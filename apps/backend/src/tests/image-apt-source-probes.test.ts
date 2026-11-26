/// <reference types="bun" />

/**
 * The probes of an image's own apt source: its URL carries the access token,
 * so it never reaches curl's command line, and its host is the image's
 * repository whatever it is called.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	buildProbeArgv,
	classifyProbe,
	probeAptReachability,
	resetAptReachabilityCacheForTest,
} from "../modules/system/apt-reachability.ts";
import {
	imageAptSourceOrigins,
	parseAptSourceOrigins,
} from "../modules/system/apt-source-origins.ts";
import {
	curlUrlConfig,
	runCurlWithPrivateUrl,
	setPrivateCurlDirectoryForTest,
} from "../modules/system/curl-private-url.ts";
import {
	activeImageAptSource,
	IMAGE_APT_SOURCE_POLICY,
	imageAptSourceIndexes,
	setImageAptSourceReaderForTest,
} from "../modules/system/image-apt-source.ts";
import { parseDebianSources } from "../modules/system/update-transport/core.ts";
import { selectUpdateTransport } from "../modules/system/update-transport/executor.ts";

const TOKEN = "k7Qm2xV9pL4sT8wZb3Nc";
const SUITE = "rock-5b-plus-2026.11.6";
const EMERGENCY = `${SUITE}-emergency`;
const SOURCES_FILE = "/etc/apt/sources.list.d/openstreambox.sources";
const KEYRING = "/usr/share/keyrings/openstreambox-archive-keyring.pgp";

// A box whose image names `host` as its one apt source.
function imageSource(host: string) {
	const uri = `https://${host}/${TOKEN}/apt`;
	const sources = `Types: deb\nURIs: ${uri}/\nSuites: ${SUITE} ${EMERGENCY}\nComponents: main\nSigned-By: ${KEYRING}\n`;
	const files: Record<string, string> = {
		[IMAGE_APT_SOURCE_POLICY]: `{"schema":1,"sourcesFile":"${SOURCES_FILE}","host":"${host}","origin":"OpenStreamBox","label":"OpenStreamBox","suites":["${SUITE}","${EMERGENCY}"]}`,
		[SOURCES_FILE]: sources,
	};
	setImageAptSourceReaderForTest((file) => files[file] ?? null);
	return {
		sources,
		urls: [
			`${uri}/dists/${SUITE}/InRelease`,
			`${uri}/dists/${EMERGENCY}/InRelease`,
		],
	};
}

const scratch: string[] = [];
const scratchDirectory = (): string => {
	const made = mkdtempSync(join(tmpdir(), "image-apt-probes-"));
	scratch.push(made);
	return made;
};

afterEach(() => {
	setImageAptSourceReaderForTest(null);
	resetAptReachabilityCacheForTest();
	setPrivateCurlDirectoryForTest(null);
	for (const made of scratch.splice(0))
		rmSync(made, { recursive: true, force: true });
});

// The unbound probe, with every curl recorded as the runner received it.
async function unboundProbe(sources: string, stdout = "200 ") {
	const calls: { argv: string[]; privateUrl: string | undefined }[] = [];
	const result = await probeAptReachability({
		readSources: async () => sources,
		runProbe: async (argv, privateUrl) => {
			calls.push({ argv, privateUrl });
			return { exitCode: 0, stdout };
		},
		maxAgeMs: 0,
	});
	return { calls, result };
}

// The per-uplink transport probe, with every command recorded likewise.
async function transportProbe(sources: string) {
	const calls: { argv: string[]; privateUrl: string | undefined }[] = [];
	const selection = await selectUpdateTransport(
		{ profile: "apt", board: "apt", channel: "stable" },
		{
			listIfnames: () => ["eth0"],
			readSources: async () => sources,
			credentials: async () => undefined,
			mmIfnames: () => [],
			routerIfnames: () => [],
			dongleIfnames: () => [],
			run: async (argv, privateUrl) => {
				calls.push({ argv, privateUrl });
				if (argv[0] === "nmcli")
					return {
						exitCode: 0,
						stdout:
							"GENERAL.DEVICE:eth0\nGENERAL.IP-IFACE:eth0\nGENERAL.TYPE:ethernet\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:no",
						stderr: "",
					};
				if (argv[0] === "resolvectl")
					return argv.includes("-6")
						? { exitCode: 1, stdout: "", stderr: "" }
						: {
								exitCode: 0,
								stdout: `${argv.at(-1)}: 192.0.2.10`,
								stderr: "",
							};
				return {
					exitCode: 0,
					stdout: "\n<<<update-probe>>>403 0.05",
					stderr: "",
				};
			},
		},
	);
	return { calls, selection };
}

describe("the image source's URL never reaches curl's command line", () => {
	it("the unbound probe hands it to the runner privately", async () => {
		const { sources, urls } = imageSource("updates.example.org");
		const { calls } = await unboundProbe(sources);
		expect(calls).toHaveLength(4);
		for (const { argv } of calls) {
			expect(argv[0]).toBe("curl");
			expect(argv.join(" ")).not.toContain(TOKEN);
			expect(argv.some((arg) => arg.startsWith("https://"))).toBe(false);
		}
		expect([...new Set(calls.map(({ privateUrl }) => privateUrl))]).toEqual(
			urls,
		);
	});

	it("the per-uplink probe hands it to the runner privately", async () => {
		const { sources, urls } = imageSource("updates.example.org");
		const { calls } = await transportProbe(sources);
		const curls = calls.filter(({ argv }) => argv[0] === "curl");
		expect(curls.length).toBeGreaterThan(0);
		for (const { argv } of calls) expect(argv.join(" ")).not.toContain(TOKEN);
		expect(curls.map(({ privateUrl }) => privateUrl).sort()).toEqual(
			[...urls].sort(),
		);
	});

	it("without the record, the URL stays where it was", async () => {
		setImageAptSourceReaderForTest(() => null);
		const { calls } = await unboundProbe(
			"Types: deb\nURIs: https://deb.debian.org/debian\nSuites: trixie\n",
		);
		expect(calls.map(({ privateUrl }) => privateUrl)).toEqual([
			undefined,
			undefined,
		]);
		expect(calls[0]?.argv.at(-1)).toBe(
			"https://deb.debian.org/debian/dists/trixie/InRelease",
		);
	});

	it("curl reads it from a file only this user can read, gone afterwards", async () => {
		const url = `https://updates.example.org/${TOKEN}/apt/dists/${SUITE}/InRelease`;
		// The service's own directory, here a scratch one.
		const directory = join(scratchDirectory(), "curl-private");
		setPrivateCurlDirectoryForTest(directory);
		let file = "";
		const result = await runCurlWithPrivateUrl(
			["curl", "-q", "-sS"],
			url,
			async (argv) => {
				expect(argv.slice(0, 4)).toEqual(["curl", "-q", "-sS", "-K"]);
				expect(argv.join(" ")).not.toContain(TOKEN);
				file = argv[4] as string;
				expect(readFileSync(file, "utf8")).toBe(`url = "${url}"\n`);
				expect(statSync(file).mode & 0o777).toBe(0o600);
				expect(dirname(file)).toBe(directory);
				expect(statSync(directory).mode & 0o777).toBe(0o700);
				return "ran";
			},
		);
		expect(result).toBe("ran");
		// That file is removed, by its own path; nothing else is in there.
		expect(() => statSync(file)).toThrow();
		expect(readdirSync(directory)).toEqual([]);
	});

	it("the file goes even when curl could not run", async () => {
		setPrivateCurlDirectoryForTest(join(scratchDirectory(), "curl-private"));
		let file = "";
		await expect(
			runCurlWithPrivateUrl(["curl"], "https://example.org/", async (argv) => {
				file = argv.at(-1) as string;
				throw new Error("curl: not found");
			}),
		).rejects.toThrow("curl: not found");
		expect(() => statSync(file)).toThrow();
	});

	it("quotes what a config line could otherwise end", () => {
		expect(curlUrlConfig('https://example.org/a"b\\c')).toBe(
			'url = "https://example.org/a\\"b\\\\c"\n',
		);
	});
});

// Every shape of the source file the validator accepts. Whatever it accepted
// is what gets probed: no consumer reads the file a second time, so none can
// read it differently.
const ACCEPTED_SHAPES: Record<string, (uri: string) => string> = {
	"as the image writes it": (uri) =>
		`Types: deb\nURIs: ${uri}/\nSuites: ${SUITE} ${EMERGENCY}\nComponents: main\nSigned-By: ${KEYRING}\n`,
	"a folded URI with a comment line between": (uri) =>
		`Types: deb\nURIs:\n# the image's own repository\n ${uri}/\nSuites: ${SUITE} ${EMERGENCY}\nComponents: main\nSigned-By: ${KEYRING}\n`,
	"trailing whitespace on every value": (uri) =>
		`Types: deb \t\nURIs: ${uri}/ \nSuites: ${SUITE} ${EMERGENCY}\t\nComponents: main \nSigned-By: ${KEYRING} \t\n`,
	"suites folded one per line, with a comment": (uri) =>
		`Types: deb\nURIs: ${uri}/\nSuites:\n ${SUITE}\n# and the emergency suite\n ${EMERGENCY}\nComponents: main\nSigned-By: ${KEYRING}\n`,
	"the suites in the other order": (uri) =>
		`Types: deb\nURIs: ${uri}/\nSuites: ${EMERGENCY} ${SUITE}\nComponents: main\nSigned-By: ${KEYRING}\n`,
	"lower-case field names and tabs": (uri) =>
		`types:\tdeb\nuris:\t${uri}/\nsuites:\t${SUITE}\t${EMERGENCY}\ncomponents:\tmain\nsigned-by:\t${KEYRING}\n`,
	"comments around the stanza, an architecture, no trailing slash": (uri) =>
		`# written by the image build\nTypes: deb\nURIs: ${uri}\nSuites: ${SUITE} ${EMERGENCY}\nComponents: main\nArchitectures: arm64\nSigned-By: ${KEYRING}\n# end\n`,
	"a folded keyring path": (uri) =>
		`Types: deb\nURIs: ${uri}/\nSuites: ${SUITE} ${EMERGENCY}\nComponents: main\nSigned-By:\n ${KEYRING}\n`,
	"the default port spelled out": (uri) =>
		`Types: deb\nURIs: ${uri.replace("updates.example.org", "updates.example.org:443")}/\nSuites: ${SUITE} ${EMERGENCY}\nComponents: main\nSigned-By: ${KEYRING}\n`,
};

describe("one parse of the image's source for everything that probes it", () => {
	const HOST = "updates.example.org";
	const uri = `https://${HOST}/${TOKEN}/apt`;
	const urls = [
		`${uri}/dists/${SUITE}/InRelease`,
		`${uri}/dists/${EMERGENCY}/InRelease`,
	].sort();
	const never = async (): Promise<string> => {
		throw new Error("the source file is not read a second time");
	};

	it.each(Object.keys(ACCEPTED_SHAPES))(
		"%s: the validator, the unbound probe and the per-uplink probe agree",
		async (shape) => {
			const files: Record<string, string> = {
				[IMAGE_APT_SOURCE_POLICY]: `{"schema":1,"sourcesFile":"${SOURCES_FILE}","host":"${HOST}","origin":"OpenStreamBox","label":"OpenStreamBox","suites":["${SUITE}","${EMERGENCY}"]}`,
				[SOURCES_FILE]: (ACCEPTED_SHAPES[shape] as (uri: string) => string)(
					uri,
				),
			};
			setImageAptSourceReaderForTest((file) => files[file] ?? null);
			// The validator accepts it and holds the parsed source.
			expect(activeImageAptSource()).toMatchObject({
				host: HOST,
				token: TOKEN,
				keyring: KEYRING,
			});
			expect(
				imageAptSourceIndexes()
					?.map(({ url }) => url)
					.sort(),
			).toEqual(urls);

			// The unbound probe asks for exactly those, and finds the route.
			const unbound: (string | undefined)[] = [];
			const reachability = await probeAptReachability({
				readSources: never,
				runProbe: async (_argv, privateUrl) => {
					unbound.push(privateUrl);
					return { exitCode: 0, stdout: "200 " };
				},
				maxAgeMs: 0,
			});
			expect([...new Set(unbound)].sort()).toEqual(urls);
			expect(reachability.verdict).not.toBe("unreachable");

			// The per-uplink probe fetches the same two and verifies each with
			// the keyring the source names.
			const fetched: (string | undefined)[] = [];
			const keyrings: (string | undefined)[] = [];
			const selection = await selectUpdateTransport(
				{ profile: "apt", board: "apt", channel: "stable" },
				{
					listIfnames: () => ["eth0"],
					readSources: never,
					credentials: async () => undefined,
					mmIfnames: () => [],
					routerIfnames: () => [],
					dongleIfnames: () => [],
					run: async (argv, privateUrl) => {
						const ok = (stdout: string) => ({
							exitCode: 0,
							stdout,
							stderr: "",
						});
						if (argv[0] === "nmcli")
							return ok(
								"GENERAL.DEVICE:eth0\nGENERAL.IP-IFACE:eth0\nGENERAL.TYPE:ethernet\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:no",
							);
						if (argv[0] === "resolvectl")
							return argv.includes("-6")
								? { exitCode: 1, stdout: "", stderr: "" }
								: ok(`${argv.at(-1)}: 192.0.2.10`);
						if (argv[0] === "gpgv") {
							keyrings.push(argv[argv.indexOf("--keyring") + 1]);
							return ok("");
						}
						fetched.push(privateUrl);
						return ok("Origin: OpenStreamBox\n\n<<<update-probe>>>200 0.05");
					},
				},
			);
			expect(fetched.sort()).toEqual(urls);
			expect(keyrings).toEqual([KEYRING, KEYRING]);
			expect(selection.status).not.toBe("none");
			expect(JSON.stringify(selection)).not.toContain("tampered");
		},
	);
});

describe("an image source on the first-party archive's host", () => {
	const FIRST_PARTY = "apt.ceralive.tv";

	it("is probed at its own InRelease, without the client certificate", async () => {
		const { sources, urls } = imageSource(FIRST_PARTY);
		void sources;
		expect(imageAptSourceOrigins()?.map(({ probeUrl }) => probeUrl)).toEqual(
			urls,
		);
		const argv = buildProbeArgv(4, urls[0] as string, undefined, {
			cert: "/tmp/client.crt",
			key: "/tmp/client.key",
		});
		expect(argv).not.toContain("--cert");
		expect(argv).toContain("-I");
		const { calls } = await unboundProbe(sources);
		expect(calls.map(({ privateUrl }) => privateUrl).slice(0, 2)).toEqual([
			urls[0],
			urls[0],
		]);
	});

	it("reads an HTTP error from it as unreachable, like any image host", async () => {
		const { sources } = imageSource(FIRST_PARTY);
		expect(
			classifyProbe({
				exitCode: 0,
				stdout: "403 ",
				originHost: FIRST_PARTY,
				scheme: "https",
			}),
		).toBe("no_route");
		const { result } = await unboundProbe(sources, "403 ");
		expect(result.verdict).toBe("unreachable");
	});

	it("stays a source for the per-uplink probe", async () => {
		const { sources, urls } = imageSource(FIRST_PARTY);
		expect(imageAptSourceIndexes()?.map(({ url }) => url)).toEqual(urls);
		const { calls, selection } = await transportProbe(sources);
		// Its InRelease is asked for, and never the first-party probe.
		expect(
			calls
				.flatMap(({ privateUrl }) => (privateUrl ? [privateUrl] : []))
				.sort(),
		).toEqual([...urls].sort());
		expect(calls.flatMap(({ argv }) => argv).join(" ")).not.toContain(
			"__tls-probe",
		);
		expect(
			selection.ranked.flatMap(({ hosts }) => hosts.map(({ host }) => host)),
		).toContain(FIRST_PARTY);
	});

	it("without the record, that host is the first-party archive as before", () => {
		setImageAptSourceReaderForTest(() => null);
		const sources = `Types: deb\nURIs: https://${FIRST_PARTY}/dists/stable/binary-arm64/\nSuites: ./\n`;
		expect(
			parseAptSourceOrigins(sources).map(({ probeUrl }) => probeUrl),
		).toEqual([`https://${FIRST_PARTY}/__tls-probe`]);
		expect(parseDebianSources(sources)).toEqual([]);
		expect(
			buildProbeArgv(4, `https://${FIRST_PARTY}/__tls-probe`, undefined, {
				cert: "/tmp/client.crt",
				key: "/tmp/client.key",
			}),
		).toContain("--cert");
		expect(
			classifyProbe({
				exitCode: 58,
				stdout: "",
				originHost: FIRST_PARTY,
				scheme: "https",
			}),
		).toBe("credentials_invalid");
	});
});
