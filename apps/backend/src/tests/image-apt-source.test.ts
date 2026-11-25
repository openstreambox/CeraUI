/// <reference types="bun" />

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "../helpers/logger.ts";
import { discoverAptAllPackages } from "../modules/system/apt-all-packages.ts";
import { policySources } from "../modules/system/apt-all-source-policy.ts";
import { readAptSources } from "../modules/system/apt-reachability.ts";
import {
	initCeraliveUpdateNotice,
	retireCeraliveUpdateOffer,
	standingCeraliveOffer,
} from "../modules/system/ceralive-update-notice.ts";
import {
	activeImageAptSource,
	dpkgJournalPending,
	IMAGE_APT_SOURCE_POLICY,
	imageAptSourceMode,
	imageAptSourcesText,
	imageClockUsable,
	parseImageAptSource,
	redactImageAptSecret,
	refreshedImageSuites,
	setDpkgUpdatesDirForTest,
	setImageAptSourceReaderForTest,
	setImageClockGateFlagForTest,
} from "../modules/system/image-apt-source.ts";
import { setImageOwnedPackagesReaderForTest } from "../modules/system/image-owned-packages.ts";
import {
	createSoftwareUpdateProcessMonitor,
	getUpdateState,
	resetAptReachabilityProbeForTest,
	resetSoftwareUpdateCheckRunner,
	resetSoftwareUpdateState,
	runSoftwareUpdateCheck,
	runUpdateDiscoveryAndReport,
	setAptCommandRunnerForTest,
	setAptReachabilityProbeForTest,
	setSoftwareUpdateCheckRunner,
	startSoftwareUpdate,
} from "../modules/system/software-updates.ts";
import {
	buildCeraliveSources,
	reconcileAptChannel,
	setCeraliveSourcesFileForTest,
} from "../modules/system/update-apt-channel.ts";
import { setUpdateCapabilityPathForTest } from "../modules/system/update-capabilities.ts";
import { StoredStateReadError } from "../modules/system/update-orchestrator/stored-state-file.ts";
import {
	defaultUpdateTransportDeps,
	selectUpdateTransport,
} from "../modules/system/update-transport/executor.ts";
import { getLastTransportSelectionForProfile } from "../modules/system/update-transport/last-selection.ts";
import { notificationRemove } from "../modules/ui/notifications.ts";
import * as compat from "../rpc/compat.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();

// The two files an image with its own source ships (image-building-pipeline
// mkosi/runtime/image-apt-source.sh), with a neutral host and a token-shaped segment.
const HOST = "updates.example.org";
const TOKEN = "k7Qm2xV9pL4sT8wZ";
const URI = `https://${HOST}/${TOKEN}/apt`;
const SUITE = "rock-5b-plus-2026.11.6";
const EMERGENCY = `${SUITE}-emergency`;
const SOURCES_FILE = "/etc/apt/sources.list.d/openstreambox.sources";
const POLICY = `{"schema":1,"sourcesFile":"${SOURCES_FILE}","host":"${HOST}","origin":"OpenStreamBox","label":"OpenStreamBox","suites":["${SUITE}","${EMERGENCY}"]}\n`;
const SOURCES = `Types: deb
URIs: ${URI}/
Suites: ${SUITE} ${EMERGENCY}
Components: main
Architectures: arm64
Signed-By: /usr/share/keyrings/openstreambox-archive-keyring.pgp
`;

function useImageFiles(files: Record<string, string | null>): void {
	setImageAptSourceReaderForTest((file) => files[file] ?? null);
}
const useImageSource = () =>
	useImageFiles({ [IMAGE_APT_SOURCE_POLICY]: POLICY, [SOURCES_FILE]: SOURCES });

// `LC_ALL=C apt-cache policy` on such a box: both suites, nothing else.
const OUR_MAIN = `${URI} ${SUITE}/main arm64 Packages`;
const OUR_EMERGENCY = `${URI} ${EMERGENCY}/main arm64 Packages`;
const DEBIAN = "https://deb.debian.org/debian trixie/main arm64 Packages";
const CERALIVE =
	"https://apt.ceralive.tv/dists/stable/binary-arm64 ./ Packages";
const INVENTORY = `Package files:
 100 /var/lib/dpkg/status
     release a=now
 500 ${OUR_EMERGENCY}
     release o=OpenStreamBox,a=${EMERGENCY},n=${EMERGENCY},l=OpenStreamBox,c=main,b=arm64
     origin ${HOST}
 500 ${OUR_MAIN}
     release o=OpenStreamBox,a=${SUITE},n=${SUITE},l=OpenStreamBox,c=main,b=arm64
     origin ${HOST}
Pinned packages:
     modemmanager -> 1.24.2-2~ceralive.3+osb3 with priority 990
`;
// The same box after someone added Debian and the first-party archive by hand.
const MIXED_INVENTORY = INVENTORY.replace(
	"Pinned packages:",
	` 500 ${DEBIAN}
     release v=13.7,o=Debian,a=stable,n=trixie,l=Debian,c=main,b=arm64
     origin deb.debian.org
 500 ${CERALIVE}
     release o=CeraLive,a=stable,n=stable,l=CeraLive,c=
     origin apt.ceralive.tv
Pinned packages:`,
);

const MM_OLD = "1.24.2-2~ceralive.3+osb2";
const MM_FIX = "1.24.2-2~ceralive.3+osb3";
const SIMULATION = `Reading package lists...
Building dependency tree...
Reading state information...
Calculating upgrade...
The following packages will be upgraded:
  libmm-glib0 modemmanager zstd
3 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.
Inst libmm-glib0 [${MM_OLD}] (${MM_FIX} Debian:13.7/stable [arm64])
Inst modemmanager [${MM_OLD}] (${MM_FIX} OpenStreamBox:${EMERGENCY} [arm64])
Inst zstd [1.5.6+dfsg-2] (1.5.7+dfsg-1 Debian:13.7/stable [arm64])
Conf libmm-glib0 (${MM_FIX} Debian:13.7/stable [arm64])
Conf modemmanager (${MM_FIX} OpenStreamBox:${EMERGENCY} [arm64])
Conf zstd (1.5.7+dfsg-1 Debian:13.7/stable [arm64])
`;
const POLICIES: Record<string, string> = {
	modemmanager: `modemmanager:
  Installed: ${MM_OLD}
  Candidate: ${MM_FIX}
  Version table:
     ${MM_FIX} 990
        500 ${OUR_EMERGENCY}
 *** ${MM_OLD} 100
        500 ${OUR_MAIN}
        100 /var/lib/dpkg/status
`,
	"libmm-glib0": `libmm-glib0:
  Installed: ${MM_OLD}
  Candidate: ${MM_FIX}
  Version table:
     ${MM_FIX} 500
        500 ${DEBIAN}
 *** ${MM_OLD} 100
        500 ${OUR_MAIN}
        100 /var/lib/dpkg/status
`,
	zstd: `zstd:
  Installed: 1.5.6+dfsg-2
  Candidate: 1.5.7+dfsg-1
  Version table:
     1.5.7+dfsg-1 500
        500 ${DEBIAN}
 *** 1.5.6+dfsg-2 100
        500 ${OUR_MAIN}
        100 /var/lib/dpkg/status
`,
};
const policyFor = async (name: string) => POLICIES[name] ?? "";
const IMAGE_OWNED = new Set(["ceralive-device", "libmm-glib0", "modemmanager"]);

const REFRESH = `Hit:1 ${URI} ${SUITE} InRelease
Get:2 ${URI} ${EMERGENCY} InRelease [2384 B]
Get:3 ${URI} ${EMERGENCY}/main arm64 Packages [912 B]
Fetched 3296 B in 1s (3120 B/s)
Reading package lists...
`;

const scratch: string[] = [];
async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "image-apt-source-"));
	scratch.push(dir);
	return dir;
}

afterEach(async () => {
	setImageAptSourceReaderForTest(null);
	setImageClockGateFlagForTest(null);
	setDpkgUpdatesDirForTest(null);
	setImageOwnedPackagesReaderForTest(null);
	for (const dir of scratch.splice(0))
		await rm(dir, { recursive: true, force: true });
});

describe("the image's apt source record", () => {
	it("reads the record and its one source", () => {
		useImageSource();
		expect(imageAptSourceMode()).toEqual({
			kind: "active",
			source: {
				host: HOST,
				uri: URI,
				token: TOKEN,
				suites: [SUITE, EMERGENCY],
				sourcesFile: SOURCES_FILE,
				sourcesText: SOURCES,
			},
		});
	});

	it("is absent on an image without the record", () => {
		useImageFiles({});
		expect(imageAptSourceMode()).toEqual({ kind: "absent" });
		expect(imageAptSourcesText()).toBeUndefined();
		expect(redactImageAptSecret(`Hit:1 ${URI} ${SUITE} InRelease`)).toBe(
			`Hit:1 ${URI} ${SUITE} InRelease`,
		);
	});

	const record = (patch: Record<string, unknown>) =>
		JSON.stringify({ ...JSON.parse(POLICY), ...patch });
	it.each([
		["another schema", record({ schema: 2 }), SOURCES],
		["an unknown key", record({ channel: "stable" }), SOURCES],
		["another origin", record({ origin: "CeraLive" }), SOURCES],
		["another label", record({ label: "Debian" }), SOURCES],
		["an address for a host", record({ host: "192.0.2.10" }), SOURCES],
		["a host with a path", record({ host: `${HOST}/x` }), SOURCES],
		["a host with a port", record({ host: `${HOST}:8443` }), SOURCES],
		[
			"an emergency suite of another release",
			record({ suites: [SUITE, "rock-5b-plus-2026.11.5-emergency"] }),
			SOURCES,
		],
		["one suite", record({ suites: [SUITE] }), SOURCES],
		["three suites", record({ suites: [SUITE, EMERGENCY, "x"] }), SOURCES],
		[
			"a suite without its release",
			record({ suites: ["rock-5b-plus", "rock-5b-plus-emergency"] }),
			SOURCES,
		],
		[
			"a source file elsewhere",
			record({ sourcesFile: "/tmp/openstreambox.sources" }),
			SOURCES,
		],
		[
			"a list file",
			record({ sourcesFile: "/etc/apt/sources.list.d/openstreambox.list" }),
			SOURCES,
		],
		[
			"a repeated key",
			POLICY.replace('"schema":1,', '"schema":1,"schema":1,'),
			SOURCES,
		],
		["text that is no JSON", "schema=1", SOURCES],
		["no source file", POLICY, null],
		[
			"a second stanza",
			POLICY,
			`${SOURCES}\nTypes: deb\nURIs: https://deb.debian.org/debian\nSuites: trixie\nComponents: main\n`,
		],
		[
			"a source of another host",
			POLICY,
			SOURCES.replace(HOST, "other.example.org"),
		],
		["a plain http source", POLICY, SOURCES.replace("https://", "http://")],
		["a trusted (unsigned) source", POLICY, `${SOURCES}Trusted: yes\n`],
		["a disabled source", POLICY, `${SOURCES}Enabled: no\n`],
		[
			"source packages",
			POLICY,
			SOURCES.replace("Types: deb", "Types: deb-src"),
		],
		[
			"other components",
			POLICY,
			SOURCES.replace("Components: main", "Components: main contrib"),
		],
		[
			"other suites",
			POLICY,
			SOURCES.replace(`${SUITE} ${EMERGENCY}`, `${SUITE} trixie`),
		],
		["no keyring", POLICY, SOURCES.replace(/^Signed-By:.*\n/m, "")],
		[
			"an inline key",
			POLICY,
			SOURCES.replace(
				/^Signed-By:.*$/m,
				"Signed-By: -----BEGIN PGP PUBLIC KEY BLOCK-----",
			),
		],
		[
			"two URIs",
			POLICY,
			SOURCES.replace(
				`URIs: ${URI}/`,
				`URIs: ${URI}/ https://${HOST}/other/apt/`,
			),
		],
		[
			"a URI with credentials",
			POLICY,
			SOURCES.replace(`https://${HOST}`, `https://user:pw@${HOST}`),
		],
		["a URI with a query", POLICY, SOURCES.replace(`${URI}/`, `${URI}/?k=v`)],
		[
			"a dot segment",
			POLICY,
			SOURCES.replace(`${URI}/`, `https://${HOST}/../apt/`),
		],
	])("refuses %s, and never falls back", (_label, policy, sources) => {
		useImageFiles({
			[IMAGE_APT_SOURCE_POLICY]: policy,
			[SOURCES_FILE]: sources,
		});
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		try {
			expect(imageAptSourceMode().kind).toBe("invalid");
			// Probes read nothing from disk; redaction has nothing to show by host.
			expect(imageAptSourcesText()).toBe("");
			expect(activeImageAptSource()).toBeUndefined();
		} finally {
			warn.mockRestore();
		}
	});

	it("refuses an unreadable record and says so once per process", () => {
		setImageAptSourceReaderForTest(() => {
			throw new StoredStateReadError("oversize");
		});
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		try {
			expect(imageAptSourceMode()).toEqual({
				kind: "invalid",
				problem: "oversize",
			});
			imageAptSourceMode();
			expect(warn.mock.calls).toEqual([
				[
					"Image apt source record unusable; package updates are refused",
					{ problem: "oversize" },
				],
			]);
		} finally {
			warn.mockRestore();
		}
	});

	it("accepts the URI without its trailing slash and with a port", () => {
		const mode = parseImageAptSource(POLICY, () =>
			SOURCES.replace(`${URI}/`, `https://${HOST}:8443/${TOKEN}/apt`),
		);
		expect(mode).toMatchObject({
			kind: "active",
			source: { uri: `https://${HOST}:8443/${TOKEN}/apt`, token: TOKEN },
		});
	});
});

describe("redaction", () => {
	it("shows the source by host in apt's own lines", () => {
		useImageSource();
		const lines = `${REFRESH}E: Failed to fetch ${URI}/dists/${EMERGENCY}/InRelease  403  Forbidden [IP: 192.0.2.10 443]
W: Some index files failed to download. They have been ignored, or old ones used instead.
token was ${TOKEN}
`;
		const redacted = redactImageAptSecret(lines);
		expect(redacted).not.toContain(TOKEN);
		expect(redacted).toContain(`Hit:1 https://${HOST} ${SUITE} InRelease`);
		expect(redacted).toContain(
			`E: Failed to fetch https://${HOST}/dists/${EMERGENCY}/InRelease  403`,
		);
		expect(redacted).toContain("token was [redacted]");
	});

	it("covers the port form apt may print", () => {
		useImageFiles({
			[IMAGE_APT_SOURCE_POLICY]: POLICY,
			[SOURCES_FILE]: SOURCES.replace(
				`${URI}/`,
				`https://${HOST}:443/${TOKEN}/apt/`,
			),
		});
		expect(
			redactImageAptSecret(
				`Hit:1 https://${HOST}:443/${TOKEN}/apt ${SUITE} InRelease\nHit:2 ${URI} ${EMERGENCY} InRelease`,
			),
		).toBe(
			`Hit:1 https://${HOST} ${SUITE} InRelease\nHit:2 https://${HOST} ${EMERGENCY} InRelease`,
		);
	});

	it("leaves a short path segment alone outside the URI", () => {
		const shortPolicy = POLICY;
		useImageFiles({
			[IMAGE_APT_SOURCE_POLICY]: shortPolicy,
			[SOURCES_FILE]: SOURCES.replace(`${URI}/`, `https://${HOST}/apt/`),
		});
		expect(activeImageAptSource()?.token).toBe("apt");
		expect(
			redactImageAptSecret(
				`Hit:1 https://${HOST}/apt ${SUITE} InRelease (apt)`,
			),
		).toBe(`Hit:1 https://${HOST} ${SUITE} InRelease (apt)`);
	});

	it("logs a finished install's apt output by host only", async () => {
		useImageSource();
		const lines: unknown[] = [];
		const info = spyOn(logger, "info").mockImplementation((message) => {
			lines.push(message);
			return logger;
		});
		const error = spyOn(logger, "error").mockImplementation((message) => {
			lines.push(message);
			return logger;
		});
		// The settle's archive cleanup runs the host's apt-get, which refuses a non-root user.
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		// Every status frame sent to local clients, serialized as the socket sends it.
		const frames: string[] = [];
		const broadcast = spyOn(compat, "broadcastMsg").mockImplementation(
			(type, data) => {
				if (type === "status") frames.push(JSON.stringify(data));
			},
		);
		try {
			// A start whose check never answers holds the update open for the monitor.
			setSoftwareUpdateCheckRunner(() => true);
			expect(startSoftwareUpdate()).toEqual({ started: true });
			const monitor = createSoftwareUpdateProcessMonitor(
				`Get:1 ${URI} ${EMERGENCY}/main arm64 libmm-glib0 arm64 ${MM_FIX} [312 kB]\n`,
			);
			// The unit's lines arrive in reads that split the token.
			const get = `Get:2 ${URI} ${EMERGENCY}/main arm64 modemmanager arm64 ${MM_FIX} [1234 kB]\n`;
			const cut = get.indexOf(TOKEN) + 5;
			monitor.handlers.onStdout(get.slice(0, cut));
			monitor.handlers.onStdout(get.slice(cut));
			const err = `E: Failed to fetch ${URI}/pool/main/m/modemmanager.deb  403  Forbidden\nE: token ${TOKEN}`;
			const errCut = err.indexOf(TOKEN) + 3;
			monitor.handlers.onStderr(err.slice(0, errCut));
			monitor.handlers.onStderr(err.slice(errCut));
			await monitor.finish(Promise.resolve(100));
			await Bun.sleep(0);
			const state = getUpdateState();
			expect(state.kind).toBe("failed");
			expect(JSON.stringify(state)).not.toContain(TOKEN);
			expect(JSON.stringify(state)).toContain(HOST);
			// The failed frame's `updating.result` is the redacted apt text too.
			const result = frames
				.map(
					(frame) => JSON.parse(frame) as { updating?: { result?: unknown } },
				)
				.find(({ updating }) => typeof updating?.result === "string");
			expect(result?.updating?.result).toContain(`https://${HOST}/pool/main`);
			for (const frame of frames) expect(frame).not.toContain(TOKEN);
			const logged = lines
				.filter((line) => typeof line === "string")
				.join("\n");
			expect(logged).toContain(`https://${HOST}/pool/main`);
			expect(logged).not.toContain(TOKEN);
		} finally {
			broadcast.mockRestore();
			info.mockRestore();
			error.mockRestore();
			warn.mockRestore();
			resetSoftwareUpdateCheckRunner();
			resetSoftwareUpdateState();
			notificationRemove("ceralive_update_failed");
		}
	});
});

describe("the first-party archive is never written back", () => {
	it.each([
		[
			"the record",
			{ [IMAGE_APT_SOURCE_POLICY]: POLICY, [SOURCES_FILE]: SOURCES },
		],
		["an invalid record", { [IMAGE_APT_SOURCE_POLICY]: "{}" }],
	])("with %s, reconcile writes nothing", async (_label, files) => {
		const dir = await tempDir();
		const file = path.join(dir, "ceralive.sources");
		useImageFiles(files);
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		try {
			expect(await reconcileAptChannel("capable", file, "arm64")).toBe(false);
			expect(existsSync(file)).toBe(false);
		} finally {
			warn.mockRestore();
		}
	});

	it("without the record, reconcile still writes it", async () => {
		const dir = await tempDir();
		const file = path.join(dir, "ceralive.sources");
		useImageFiles({});
		expect(await reconcileAptChannel("capable", file, "arm64")).toBe(true);
		expect(await readFile(file, "utf8")).toBe(buildCeraliveSources("arm64"));
	});
});

describe("source policy", () => {
	it("admits only the image's two suites, by host", () => {
		useImageSource();
		const source = activeImageAptSource();
		expect([...policySources(MIXED_INVENTORY, source)]).toEqual([
			[OUR_EMERGENCY, HOST],
			[OUR_MAIN, HOST],
			[DEBIAN, null],
			[CERALIVE, null],
		]);
	});

	it.each([
		["another token", INVENTORY.replaceAll(URI, `https://${HOST}/other/apt`)],
		[
			"another release",
			INVENTORY.replaceAll(
				`n=${EMERGENCY}`,
				"n=rock-5b-plus-2026.11.5-emergency",
			),
		],
		["another origin", INVENTORY.replaceAll("o=OpenStreamBox", "o=Debian")],
		["another label", INVENTORY.replaceAll("l=OpenStreamBox", "l=CeraLive")],
		[
			"another origin host",
			INVENTORY.replaceAll(`origin ${HOST}`, "origin other.example.org"),
		],
		[
			"a suite apt does not list",
			INVENTORY.replaceAll(`${EMERGENCY}/main`, `${EMERGENCY}/contrib`),
		],
	])("refuses %s", (_label, inventory) => {
		useImageSource();
		const sources = policySources(inventory, activeImageAptSource());
		expect(sources.get(OUR_EMERGENCY) ?? null).toBeNull();
	});

	it("without the image's source, keeps today's origins", () => {
		expect([...policySources(MIXED_INVENTORY)]).toEqual([
			[OUR_EMERGENCY, null],
			[OUR_MAIN, null],
			[DEBIAN, "Debian trixie"],
			[CERALIVE, "apt.ceralive.tv"],
		]);
	});
});

describe("discovery from the image's own source", () => {
	it("offers an emergency fix for an image-owned name and refuses every other origin", async () => {
		useImageSource();
		const result = await discoverAptAllPackages(
			SIMULATION,
			"",
			policyFor,
			MIXED_INVENTORY,
			IMAGE_OWNED,
			activeImageAptSource(),
		);
		expect(result.packages).toEqual([
			{
				name: "modemmanager",
				version: MM_FIX,
				origin: HOST,
				layer: "app",
				actionable: true,
			},
			{
				name: "zstd",
				version: "1.5.7+dfsg-1",
				layer: "platform",
				actionable: false,
			},
		]);
		expect(result.actionable).toEqual([
			{ name: "modemmanager", version: MM_FIX },
		]);
		// The same image-owned fix from Debian stays withheld.
		expect(result.withheld).toEqual([{ name: "libmm-glib0", version: MM_FIX }]);
	});

	it("without the image's source, withholds image-owned names as before", async () => {
		const result = await discoverAptAllPackages(
			SIMULATION,
			"",
			policyFor,
			MIXED_INVENTORY,
			IMAGE_OWNED,
		);
		expect(result.withheld.map(({ name }) => name)).toEqual([
			"libmm-glib0",
			"modemmanager",
		]);
		expect(result.packages.map(({ name }) => name)).toEqual(["zstd"]);
	});
});

describe("reachability and transport read only the image's file", () => {
	it("reads the image's source instead of the directory", async () => {
		const dir = await tempDir();
		await writeFile(
			path.join(dir, "ceralive.sources"),
			buildCeraliveSources("arm64"),
		);
		useImageSource();
		expect(await readAptSources(dir)).toBe(SOURCES);
		expect(await defaultUpdateTransportDeps.readSources()).toBe(SOURCES);
		useImageFiles({});
		expect(await readAptSources(dir)).toBe(buildCeraliveSources("arm64"));
	});

	it("probes the image's host without the client certificate, and names it by host", async () => {
		useImageSource();
		const calls: string[][] = [];
		let credentialsRead = false;
		await selectUpdateTransport(
			{ profile: "apt", board: "apt", channel: "stable" },
			{
				listIfnames: () => ["eth0"],
				readSources: async () => SOURCES,
				credentials: async () => {
					credentialsRead = true;
					return { cert: "/tmp/client.crt", key: "/tmp/client.key" };
				},
				mmIfnames: () => [],
				routerIfnames: () => [],
				dongleIfnames: () => [],
				run: async (argv) => {
					calls.push(argv);
					if (argv[0] === "nmcli")
						return {
							exitCode: 0,
							stdout:
								"GENERAL.DEVICE:eth0\nGENERAL.IP-IFACE:eth0\nGENERAL.TYPE:ethernet\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:no",
							stderr: "",
						};
					if (argv[0] === "resolvectl")
						return {
							exitCode: 0,
							stdout: `${argv.at(-1)}: 192.0.2.10`,
							stderr: "",
						};
					// The image's InRelease answers 403 on IPv4; IPv6 has no route.
					if (argv.includes("-6"))
						return { exitCode: 7, stdout: "", stderr: "" };
					return {
						exitCode: 0,
						stdout: "\n<<<update-probe>>>403 0.05",
						stderr: "",
					};
				},
			},
		);
		const curls = calls.filter(([command]) => command === "curl");
		// IPv4 only: IPv6 has no route, so its curls never start.
		expect(curls.map((argv) => argv.at(-1)).sort()).toEqual([
			`${URI}/dists/${EMERGENCY}/InRelease`,
			`${URI}/dists/${SUITE}/InRelease`,
		]);
		expect(calls.flat()).not.toContain("--cert");
		expect(calls.flat().some((arg) => arg.includes("apt.ceralive.tv"))).toBe(
			false,
		);
		expect(credentialsRead).toBe(false);
		const summary = getLastTransportSelectionForProfile("apt");
		expect(JSON.stringify(summary)).not.toContain(TOKEN);
		expect(
			summary?.findings.flatMap(({ hosts }) => hosts.map(({ host }) => host)),
		).toContain(HOST);
	});
});

describe("the CeraLive update notice", () => {
	it("retires a stored offer once, then stays silent", async () => {
		const dir = await tempDir();
		const record = path.join(dir, "offer.json");
		await writeFile(
			record,
			JSON.stringify({
				version: 8,
				offer: [
					{ name: "ceralive-device", arch: "arm64", version: "2026.11.5-1" },
				],
			}),
		);
		const writes: string[] = [];
		initCeraliveUpdateNotice({
			path: record,
			write: (_file, text) => writes.push(text),
		});
		expect(standingCeraliveOffer()).not.toBeNull();
		retireCeraliveUpdateOffer("the image ships its own apt source");
		retireCeraliveUpdateOffer("the image ships its own apt source");
		expect(standingCeraliveOffer()).toBeNull();
		expect(writes).toEqual(['{"version":8,"offer":null}']);
	});
});

describe("clock and dpkg state", () => {
	it("reads the image's clock gate", async () => {
		const dir = await tempDir();
		const flag = path.join(dir, "clock-gate-open");
		setImageClockGateFlagForTest(flag);
		expect(imageClockUsable()).toBe(false);
		await writeFile(flag, "");
		expect(imageClockUsable()).toBe(true);
	});

	it("sees an interrupted dpkg run in dpkg's journal", async () => {
		const dir = await tempDir();
		const updates = path.join(dir, "updates");
		setDpkgUpdatesDirForTest(updates);
		expect(dpkgJournalPending()).toBe(false);
		await mkdir(updates);
		await writeFile(path.join(updates, "tmp.i"), "");
		expect(dpkgJournalPending()).toBe(false);
		await writeFile(path.join(updates, "0000"), "");
		expect(dpkgJournalPending()).toBe(true);
	});

	it("knows when a refresh reached both suites", () => {
		useImageSource();
		const source = activeImageAptSource();
		if (source === undefined) throw new Error("no source");
		expect(refreshedImageSuites(REFRESH, source)).toBe(true);
		expect(
			refreshedImageSuites(REFRESH.replace(/^Get:2 .*\n/m, ""), source),
		).toBe(false);
		expect(
			refreshedImageSuites(
				`${REFRESH}Err:4 ${URI} ${EMERGENCY} InRelease\n  The following signatures were invalid: EXPKEYSIG\n`,
				source,
			),
		).toBe(false);
		expect(
			refreshedImageSuites(
				`${REFRESH}Ign:4 ${URI} ${EMERGENCY}/main arm64 Packages\n`,
				source,
			),
		).toBe(false);
	});
});

// A capable box with the record, its apt answers scripted as the box gives them.
async function capableBox(options: {
	readonly features?: readonly string[];
	readonly refresh?: string;
	readonly refreshStderr?: string;
	readonly clock?: boolean;
}) {
	const dir = await tempDir();
	const capability = path.join(dir, "capabilities.json");
	await writeFile(
		capability,
		JSON.stringify({
			schema: 1,
			features: options.features ?? [
				"apt-all-packages",
				"rauc-verity-streaming",
			],
			ota_uid: 42041,
			apt_uid: 42042,
		}),
	);
	const flag = path.join(dir, "clock-gate-open");
	if (options.clock !== false) await writeFile(flag, "");
	setImageClockGateFlagForTest(flag);
	setUpdateCapabilityPathForTest(capability);
	const ceraliveSources = path.join(dir, "ceralive.sources");
	setCeraliveSourcesFileForTest(ceraliveSources);
	setImageOwnedPackagesReaderForTest(null, path.join(dir, "no-pin"));
	setDpkgUpdatesDirForTest(path.join(dir, "updates"));
	setAptReachabilityProbeForTest(async () => ({
		ipv4: "ok",
		ipv6: "ok",
		used: "any",
		verdict: "any",
		detail: [],
	}));
	const commands: string[][] = [];
	setAptCommandRunnerForTest(async (argv) => {
		commands.push(argv);
		if (argv[0] === "/usr/bin/apt-get" && argv[1] === "update")
			return {
				exitCode: 0,
				stdout: options.refresh ?? REFRESH,
				stderr: options.refreshStderr ?? "",
			};
		if (argv[0] === "/usr/bin/apt-cache") {
			const name = argv[argv.indexOf("policy") + 1];
			return {
				exitCode: 0,
				stdout: name === undefined ? INVENTORY : (POLICIES[name] ?? ""),
				stderr: "",
			};
		}
		if (argv[0] === "/usr/bin/apt-mark")
			return { exitCode: 0, stdout: "", stderr: "" };
		if (argv.includes("-s") && argv.includes("install"))
			return { exitCode: 100, stdout: "", stderr: "pinned recheck stops here" };
		if (argv.includes("-s"))
			return {
				exitCode: 0,
				stdout: SIMULATION.replace(/^Inst (?:libmm-glib0|zstd).*\n/gm, "")
					.replace(/^Conf (?:libmm-glib0|zstd).*\n/gm, "")
					.replace("3 upgraded", "1 upgraded")
					.replace("libmm-glib0 modemmanager zstd", "modemmanager"),
				stderr: "",
			};
		return { exitCode: 0, stdout: "", stderr: "" };
	});
	return {
		commands,
		ceraliveSources,
		dir,
		cleanup: () => {
			setUpdateCapabilityPathForTest(null);
			setCeraliveSourcesFileForTest(null);
			setAptCommandRunnerForTest(null);
			resetAptReachabilityProbeForTest();
			resetSoftwareUpdateCheckRunner();
			resetSoftwareUpdateState();
			notificationRemove("ceralive_update_failed");
		},
	};
}

describe("a package check on such a box", () => {
	it("offers the emergency fix, by host, with no first-party source and no notice warning", async () => {
		useImageSource();
		const box = await capableBox({
			refreshStderr: `W: ${URI}/dists/${SUITE}/InRelease: a warning naming the URI\n`,
		});
		const logged: unknown[][] = [];
		const capture = (...args: unknown[]) => {
			logged.push(args);
			return logger;
		};
		const spies = [
			spyOn(logger, "info").mockImplementation(capture),
			spyOn(logger, "warn").mockImplementation(capture),
			spyOn(logger, "error").mockImplementation(capture),
		];
		try {
			expect(await runSoftwareUpdateCheck()).toBe(null);
			const state = getUpdateState();
			expect(state).toMatchObject({
				kind: "available",
				actionable_count: 1,
				packages: [
					{
						name: "modemmanager",
						version: MM_FIX,
						origin: HOST,
						actionable: true,
					},
				],
			});
			expect(JSON.stringify(state)).not.toContain(TOKEN);
			expect(existsSync(box.ceraliveSources)).toBe(false);
			// apt's refresh output reaches the log by host only.
			expect(JSON.stringify(logged)).not.toContain(TOKEN);
			expect(JSON.stringify(logged)).toContain(
				`Hit:1 https://${HOST} ${SUITE} InRelease`,
			);
			expect(logged.map(([message]) => message)).not.toContain(
				"CeraLive update notice unchanged: check not complete",
			);
		} finally {
			for (const spy of spies) spy.mockRestore();
			box.cleanup();
		}
	});

	it("waits for the clock gate without running apt or reporting a failure", async () => {
		useImageSource();
		const box = await capableBox({ clock: false });
		const info = spyOn(logger, "info").mockImplementation(() => logger);
		try {
			// The orchestrator never reaches this while the clock waits (it skips the cycle).
			expect(await runSoftwareUpdateCheck()).toBe("busy");
			expect(box.commands).toEqual([]);
			expect(getUpdateState().kind).not.toBe("check_failed");
			expect(info.mock.calls.map(([message]) => message)).toContain(
				"Package check waits for a synchronized clock",
			);
		} finally {
			info.mockRestore();
			box.cleanup();
		}
	});

	it.each([
		["an invalid record", { [IMAGE_APT_SOURCE_POLICY]: "{}" }, undefined],
		[
			"an image without the all-packages path",
			{ [IMAGE_APT_SOURCE_POLICY]: POLICY, [SOURCES_FILE]: SOURCES },
			["rauc-verity-streaming"],
		],
	])("refuses the check with %s", async (_label, files, features) => {
		useImageFiles(files);
		const box = await capableBox({ features });
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		try {
			expect(await runSoftwareUpdateCheck()).toBe("discovery_failed");
			expect(await runUpdateDiscoveryAndReport()).toBe("discovery_failed");
			expect(box.commands).toEqual([]);
			expect(existsSync(box.ceraliveSources)).toBe(false);
		} finally {
			warn.mockRestore();
			box.cleanup();
		}
	});
});

describe("an install on such a box", () => {
	async function install(
		box: Awaited<ReturnType<typeof capableBox>>,
		afterDiscovery?: () => Promise<void>,
	) {
		expect(await runUpdateDiscoveryAndReport(REFRESH)).toBe(null);
		await afterDiscovery?.();
		expect(startSoftwareUpdate()).toEqual({ started: true });
		for (let i = 0; i < 100 && getUpdateState().kind !== "failed"; i++)
			await Bun.sleep(5);
		return box.commands.filter(
			(argv) => argv.includes("install") || argv.includes("upgrade"),
		);
	}

	it("refuses when its refresh did not reach the emergency suite", async () => {
		useImageSource();
		const box = await capableBox({
			refresh: REFRESH.replace(/^Get:2 .*\n/m, ""),
		});
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		const info = spyOn(logger, "info").mockImplementation(() => logger);
		const error = spyOn(logger, "error").mockImplementation(() => logger);
		try {
			const transactions = await install(box);
			// The install's own refresh ran and missed a suite: nothing after it.
			expect(getUpdateState()).toMatchObject({
				kind: "failed",
				reason: "refresh_failed",
			});
			expect(box.commands.some((argv) => argv[1] === "update")).toBe(true);
			expect(transactions.filter((argv) => argv.includes("install"))).toEqual(
				[],
			);
		} finally {
			warn.mockRestore();
			info.mockRestore();
			error.mockRestore();
			box.cleanup();
		}
	});

	it("refuses over an interrupted dpkg run", async () => {
		useImageSource();
		const box = await capableBox({});
		// dpkg is interrupted after the offer was found.
		const afterDiscovery = async () => {
			await mkdir(path.join(box.dir, "updates"));
			await writeFile(path.join(box.dir, "updates", "0001"), "");
		};
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		const info = spyOn(logger, "info").mockImplementation(() => logger);
		const error = spyOn(logger, "error").mockImplementation(() => logger);
		try {
			const transactions = await install(box, afterDiscovery);
			expect(getUpdateState()).toMatchObject({
				kind: "failed",
				reason: "dpkg_interrupted",
			});
			expect(transactions.filter((argv) => argv.includes("install"))).toEqual(
				[],
			);
		} finally {
			warn.mockRestore();
			info.mockRestore();
			error.mockRestore();
			box.cleanup();
		}
	});

	it("goes on to the pinned recheck from freshly refreshed lists", async () => {
		useImageSource();
		const box = await capableBox({});
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		const info = spyOn(logger, "info").mockImplementation(() => logger);
		const error = spyOn(logger, "error").mockImplementation(() => logger);
		try {
			const transactions = await install(box);
			// The install's own refresh ran right before the pinned recheck.
			const refreshes = box.commands
				.map((argv, i) => (argv[1] === "update" ? i : -1))
				.filter((i) => i >= 0);
			const recheck = box.commands.findIndex(
				(argv) => argv.includes("-s") && argv.includes("install"),
			);
			expect(refreshes.length).toBe(1);
			expect(recheck).toBeGreaterThan(refreshes[0] ?? Number.POSITIVE_INFINITY);
			expect(transactions.at(-1)).toContain(`modemmanager=${MM_FIX}`);
		} finally {
			warn.mockRestore();
			info.mockRestore();
			error.mockRestore();
			box.cleanup();
		}
	});
});

describe("every package apt run reads only the image's source", () => {
	const PAIR = [
		"-o",
		`Dir::Etc::SourceList=${SOURCES_FILE}`,
		"-o",
		"Dir::Etc::SourceParts=/dev/null",
	];
	const carriesPair = (argv: readonly string[]) =>
		argv.some((_, i) => PAIR.every((value, j) => argv[i + j] === value));

	it("passes the source overrides to the refresh, the inventory and the simulation", async () => {
		useImageSource();
		const box = await capableBox({});
		const quiet = [
			spyOn(logger, "info").mockImplementation(() => logger),
			spyOn(logger, "warn").mockImplementation(() => logger),
		];
		try {
			expect(await runSoftwareUpdateCheck()).toBe(null);
			const apt = box.commands.filter(
				([command]) =>
					command === "/usr/bin/apt-get" || command === "/usr/bin/apt-cache",
			);
			expect(apt.map((argv) => argv.slice(0, 2).join(" "))).toContain(
				"/usr/bin/apt-get update",
			);
			expect(apt.length).toBeGreaterThan(3);
			for (const argv of apt) expect(carriesPair(argv)).toBe(true);
		} finally {
			for (const spy of quiet) spy.mockRestore();
			box.cleanup();
		}
	});

	it("passes none on an image without the record", async () => {
		useImageFiles({});
		const box = await capableBox({});
		const quiet = [
			spyOn(logger, "info").mockImplementation(() => logger),
			spyOn(logger, "warn").mockImplementation(() => logger),
		];
		try {
			await runSoftwareUpdateCheck();
			expect(box.commands.length).toBeGreaterThan(0);
			for (const argv of box.commands)
				expect(argv.some((arg) => arg.startsWith("Dir::Etc::"))).toBe(false);
		} finally {
			for (const spy of quiet) spy.mockRestore();
			box.cleanup();
		}
	});
});

describe("a package check refuses what it cannot vouch for", () => {
	// LC_ALL=C apt-get update on trixie when one suite's InRelease times out: exit 0,
	// the old lists kept.
	const PARTIAL = {
		stdout: `Hit:1 ${URI} ${SUITE} InRelease
Err:2 ${URI} ${EMERGENCY} InRelease
  Could not connect to ${HOST}:443 (192.0.2.10), connection timed out
Reading package lists...
`,
		stderr: `W: Failed to fetch ${URI}/dists/${EMERGENCY}/InRelease  Could not connect to ${HOST}:443 (192.0.2.10), connection timed out
W: Some index files failed to download. They have been ignored, or old ones used instead.
`,
	};
	const quietly = async <T>(work: () => Promise<T>): Promise<T> => {
		const spies = [
			spyOn(logger, "info").mockImplementation(() => logger),
			spyOn(logger, "warn").mockImplementation(() => logger),
			spyOn(logger, "error").mockImplementation(() => logger),
		];
		try {
			return await work();
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	};

	it("fails a refresh that exited 0 without one suite, before discovery", async () => {
		useImageSource();
		const box = await capableBox({
			refresh: PARTIAL.stdout,
			refreshStderr: PARTIAL.stderr,
		});
		try {
			expect(await quietly(() => runSoftwareUpdateCheck())).toBe(
				"refresh_failed",
			);
			expect(getUpdateState()).toMatchObject({
				kind: "check_failed",
				reason: "refresh_failed",
			});
			expect(box.commands.some((argv) => argv.includes("-s"))).toBe(false);
		} finally {
			box.cleanup();
		}
	});

	it("still reports a sign-in page as a captive portal", async () => {
		useImageSource();
		const box = await capableBox({
			refresh: PARTIAL.stdout,
			refreshStderr:
				"E: Failed to fetch https://updates.example.org/  does the network require authentication?\n",
		});
		try {
			expect(await quietly(() => runSoftwareUpdateCheck())).toBe(
				"captive_portal",
			);
			expect(getUpdateState()).toMatchObject({
				kind: "check_failed",
				reason: "captive_portal",
			});
		} finally {
			box.cleanup();
		}
	});

	it("never discovers from cached lists", async () => {
		useImageSource();
		const box = await capableBox({});
		try {
			expect(await quietly(() => runUpdateDiscoveryAndReport())).toBe(
				"refresh_failed",
			);
			expect(box.commands).toEqual([]);
		} finally {
			box.cleanup();
		}
	});

	it("refuses over an interrupted dpkg run until it is repaired", async () => {
		useImageSource();
		const box = await capableBox({});
		await mkdir(path.join(box.dir, "updates"));
		await writeFile(path.join(box.dir, "updates", "0001"), "");
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		try {
			expect(await runSoftwareUpdateCheck()).toBe("dpkg_interrupted");
			expect(await runUpdateDiscoveryAndReport(REFRESH)).toBe(
				"dpkg_interrupted",
			);
			expect(box.commands).toEqual([]);
			expect(getUpdateState()).toMatchObject({ kind: "check_failed" });
			expect(warn.mock.calls.map(([message]) => message)).toContain(
				"Package updates refused: an earlier dpkg run was interrupted; run dpkg --configure -a",
			);
			// `dpkg --configure -a` empties the journal: the next check runs.
			await rm(path.join(box.dir, "updates", "0001"));
			expect(await quietly(() => runSoftwareUpdateCheck())).toBe(null);
		} finally {
			warn.mockRestore();
			box.cleanup();
		}
	});

	it("retires a stored CeraLive offer even while the clock waits", async () => {
		useImageSource();
		const box = await capableBox({ clock: false });
		const record = path.join(box.dir, "offer.json");
		await writeFile(
			record,
			JSON.stringify({
				version: 8,
				offer: [
					{ name: "ceralive-device", arch: "arm64", version: "2026.11.5-1" },
				],
			}),
		);
		initCeraliveUpdateNotice({ path: record, write: () => {} });
		try {
			expect(standingCeraliveOffer()).not.toBeNull();
			expect(await quietly(() => runSoftwareUpdateCheck())).toBe("busy");
			expect(standingCeraliveOffer()).toBeNull();
			expect(box.commands).toEqual([]);
		} finally {
			box.cleanup();
		}
	});
});
