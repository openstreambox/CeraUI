import { readdir } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type EffectOwner,
	isOwnerEnded,
	ownedAll,
	ownedFiles,
	ownedWrite,
} from "../../../helpers/effect-owner.ts";
import { logger } from "../../../helpers/logger.ts";
import { argMatch, ID_RE } from "../../../helpers/run.ts";
import {
	type SpawnWithTimeoutResult,
	spawnWithTimeout,
} from "../../../helpers/spawn-policy.ts";
import {
	type AptClientPaths,
	aptClientPaths,
} from "../../addons/apt-client-tls.ts";
import { getModems } from "../../modems/modems-state.ts";
import { deviceBindingArgs } from "../../network/device-bound-probe.ts";
import {
	getNetifErrorMsg,
	getNetworkInterfaces,
	NETIF_ERR_DUPIPV4,
} from "../../network/network-interfaces.ts";
import {
	getModemNetMarker,
	getRouterCellularMarker,
} from "../../network/router-cellular-scan.ts";
import { runCurlWithPrivateUrl } from "../curl-private-url.ts";
import {
	activeImageAptSource,
	carriesImageAptSecret,
	imageAptSourceInUse,
	imageAptSourcesText,
} from "../image-apt-source.ts";
import { updateChannelUrl } from "../update-channel-url.ts";
import { parseAuthorityJson } from "../update-orchestrator/strict-authority-json.ts";
import { UPDATE_INVENTORY_NMCLI_FIELDS } from "./candidate-inventory.ts";
import {
	classifyHttp,
	classifyTransfer,
	type DebianSource,
	discoverCandidates,
	type Family,
	type HostProbe,
	type ProbeState,
	parseDebianSources,
	rankTransports,
	type TransportSample,
	type TransportSelection,
} from "./core.ts";
import { recordTransportSelection } from "./last-selection.ts";

const SOURCE_DIR = "/etc/apt/sources.list.d";
const MARKER = "\n<<<update-probe>>>";
const TIMEOUT_MS = 4_500;

export type UpdateProfile = {
	readonly profile: "apt" | "os";
	readonly board: string;
	readonly channel: "stable" | "beta" | "drill";
};
export type UpdateTransportDeps = {
	listIfnames: () => string[];
	readSources: () => Promise<string>;
	credentials: () => Promise<AptClientPaths | undefined>;
	/**
	 * Runs one bounded command. A curl URL that carries the image source's
	 * access token comes as `privateUrl` and is left out of `argv`: it must
	 * reach curl without appearing on its command line.
	 */
	run: (
		argv: string[],
		privateUrl?: string,
		owner?: EffectOwner,
	) => Promise<SpawnWithTimeoutResult>;
	/**
	 * Whom this selection is made for; set by `selectUpdateTransport`. Once it
	 * has ended, no further command starts and nothing is written or published.
	 */
	owner?: EffectOwner;
	mmIfnames: () => string[];
	routerIfnames: () => string[];
	dongleIfnames: () => string[];
};

async function readSources(): Promise<string> {
	// An image with its own apt source: only that file, whatever else is on disk.
	const only = imageAptSourcesText();
	if (only !== undefined) return only;
	const names = (await readdir(SOURCE_DIR))
		.filter((name) => /\.(?:sources|list)$/.test(name))
		.sort();
	return (
		await Promise.all(
			names.map((name) => Bun.file(join(SOURCE_DIR, name)).text()),
		)
	).join("\n\n");
}

export const defaultUpdateTransportDeps: UpdateTransportDeps = {
	listIfnames: () =>
		Object.entries(getNetworkInterfaces())
			.filter(
				([, entry]) =>
					getNetifErrorMsg({
						...entry,
						error: entry.error & ~NETIF_ERR_DUPIPV4,
					}) === undefined,
			)
			.map(([ifname]) => ifname),
	readSources,
	credentials: aptClientPaths,
	run: (argv, privateUrl, owner) =>
		privateUrl === undefined
			? spawnWithTimeout(argv, { timeoutMs: TIMEOUT_MS, owner })
			: runCurlWithPrivateUrl(
					argv,
					privateUrl,
					(full) => spawnWithTimeout(full, { timeoutMs: TIMEOUT_MS, owner }),
					owner,
				),
	mmIfnames: () =>
		Object.values(getModems())
			.map(({ ifname }) => ifname)
			.filter(Boolean),
	routerIfnames: () =>
		Object.keys(getNetworkInterfaces()).filter(
			(ifname) =>
				getRouterCellularMarker(ifname) !== undefined ||
				getModemNetMarker(ifname) !== undefined,
		),
	dongleIfnames: () =>
		Object.keys(getNetworkInterfaces()).filter(
			(ifname) => getRouterCellularMarker(ifname) !== undefined,
		),
};

function failure(result: SpawnWithTimeoutResult): ProbeState {
	switch (result.exitCode) {
		case 6:
			return "dns-failed";
		case 7:
			return "no-route";
		case 28:
			return "blocked";
		case 35:
		case 51:
		case 60:
			return "tls-error";
		case 58:
			return "credentials-invalid";
		default:
			return "probe-unavailable";
	}
}

function parseResponse(result: SpawnWithTimeoutResult): {
	code: number;
	body: string;
	latencyMs: number;
} {
	const at = result.stdout.lastIndexOf(MARKER);
	if (at < 0) return { code: 0, body: result.stdout, latencyMs: TIMEOUT_MS };
	const [code, seconds] = result.stdout
		.slice(at + MARKER.length)
		.trim()
		.split(/\s+/);
	return {
		code: Number(code),
		body: result.stdout.slice(0, at),
		latencyMs: Math.round(Number(seconds) * 1000) || 0,
	};
}

function failureFromError(error: unknown): ProbeState {
	if (
		error instanceof Error &&
		/not found|ENOENT|Executable|invalid argument/i.test(error.message)
	)
		return "probe-unavailable";
	return "blocked";
}

async function resolvedAddress(
	host: string,
	ifname: string,
	family: Family,
	deps: UpdateTransportDeps,
): Promise<string | ProbeState> {
	argMatch(/^[a-zA-Z0-9.-]+$/, host);
	try {
		const result = await deps.run([
			"resolvectl",
			family === 4 ? "-4" : "-6",
			"-i",
			argMatch(ID_RE, ifname),
			"query",
			host,
		]);
		if (result.exitCode !== 0)
			return result.exitCode === 1 ? "dns-failed" : failure(result);
		for (const line of result.stdout.split(/\r?\n/)) {
			const address = line.startsWith(`${host}:`)
				? line
						.slice(host.length + 1)
						.trim()
						.split(/\s+/)[0]
				: undefined;
			if (address && isIP(address) === family) return address;
		}
		return "dns-failed";
	} catch (error) {
		if (isOwnerEnded(error)) throw error;
		return failureFromError(error);
	}
}

async function curl(
	url: string,
	ifname: string,
	family: Family,
	method: "GET" | "HEAD",
	deps: UpdateTransportDeps,
	cert?: AptClientPaths,
): Promise<{
	state: ProbeState;
	code: number;
	body: string;
	latencyMs: number;
}> {
	const parsed = new URL(url);
	const address = await resolvedAddress(parsed.hostname, ifname, family, deps);
	if (isIP(address) !== family)
		return {
			state: address as ProbeState,
			code: 0,
			body: "",
			latencyMs: TIMEOUT_MS,
		};
	const target = family === 6 ? `[${address}]` : address;
	const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
	const argv = [
		"curl",
		"-q",
		family === 4 ? "-4" : "-6",
		...deviceBindingArgs(ifname),
		"--noproxy",
		"*",
		"--resolve",
		`${parsed.hostname}:${port}:${target}`,
		"--connect-timeout",
		"2",
		"--max-time",
		"3",
		"--max-filesize",
		"2097152",
		"-sS",
		...(method === "HEAD" ? ["-I"] : []),
		...(cert ? ["--cert", cert.cert, "--key", cert.key] : []),
		"-w",
		`${MARKER}%{http_code} %{time_total}`,
	];
	try {
		// The image source's URL carries its access token: curl gets it
		// privately, never as an argument.
		const result = carriesImageAptSecret(url)
			? await deps.run(argv, url)
			: await deps.run([...argv, url]);
		if (result.exitCode !== 0)
			return {
				state: failure(result),
				code: 0,
				body: "",
				latencyMs: TIMEOUT_MS,
			};
		const response = parseResponse(result);
		return {
			state:
				response.code >= 200 && response.code < 300 ? "clear" : "captive-http",
			...response,
		};
	} catch (error) {
		if (isOwnerEnded(error)) throw error;
		return {
			state: failureFromError(error),
			code: 0,
			body: "",
			latencyMs: TIMEOUT_MS,
		};
	}
}

async function endpoint(
	base: string,
	ifname: string,
	family: Family,
	profile: UpdateProfile,
	deps: UpdateTransportDeps,
	credentials?: AptClientPaths,
): Promise<HostProbe> {
	const host = new URL(base).host;
	const apt = profile.profile === "apt";
	const httpProbe = await curl(
		`${base.replace(/^https:/, "http:")}/generate_204`,
		ifname,
		family,
		"GET",
		deps,
	);
	const captive =
		httpProbe.state === "captive-http" ||
		(httpProbe.state === "clear" &&
			classifyHttp(httpProbe.code, httpProbe.body) === "captive-http");
	if (httpProbe.state !== "clear" && !captive)
		return { host, state: httpProbe.state, latencyMs: httpProbe.latencyMs };
	if (apt && credentials) {
		try {
			const certificate = await deps.run([
				"openssl",
				"x509",
				"-checkend",
				"0",
				"-noout",
				"-in",
				argMatch(/^\/[\w./-]+$/, credentials.cert),
			]);
			if (certificate.exitCode !== 0)
				return {
					host,
					state: "credentials-invalid",
					latencyMs: httpProbe.latencyMs,
				};
		} catch (error) {
			if (isOwnerEnded(error)) throw error;
			return {
				host,
				state: failureFromError(error),
				latencyMs: httpProbe.latencyMs,
			};
		}
	}
	const secureUrl = apt
		? `${base}/__tls-probe`
		: `${base}/channels/${encodeURIComponent(profile.channel)}/${encodeURIComponent(profile.board)}.json.sig`;
	const secure = await curl(
		secureUrl,
		ifname,
		family,
		apt ? "GET" : "HEAD",
		deps,
		apt ? credentials : undefined,
	);
	// A completed, verified-TLS HEAD to our OS object can prove the link even when the channel has no publication.
	const absentOsObject =
		!apt &&
		secure.state === "captive-http" &&
		(secure.code === 404 || secure.code === 410);
	let state: ProbeState = absentOsObject ? "clear" : secure.state;
	if (secure.state === "tls-error") state = classifyTransfer("tls", captive);
	else if (secure.state === "clear" && apt) {
		try {
			const body: unknown = parseAuthorityJson(secure.body);
			state =
				typeof body === "object" &&
				body !== null &&
				"certVerified" in body &&
				body.certVerified === true
					? "clear"
					: "credentials-invalid";
		} catch {
			state = "probe-unavailable";
		}
	} else if (secure.state === "clear" && secure.code !== 200)
		state = "no-route";
	if (captive && state === "clear") state = "captive-http";
	return { host, state, latencyMs: httpProbe.latencyMs + secure.latencyMs };
}

async function debian(
	source: DebianSource,
	ifname: string,
	family: Family,
	deps: UpdateTransportDeps,
): Promise<HostProbe> {
	// The image source's URL carries its access token: findings name its host only.
	const image = activeImageAptSource();
	const imageHost =
		image !== undefined && new URL(source.url).hostname === image.host;
	const host = imageHost ? image.host : source.url;
	if (!source.keyring) return { host, state: "tampered", latencyMs: 0 };
	const response = await curl(source.url, ifname, family, "GET", deps);
	// The image's source is https only: any HTTP status came over verified TLS
	// from the repository itself (403, 404, 5xx), never from a sign-in page,
	// which cannot present the host's certificate. It is unreachable, not captive.
	const repositoryAnswered = imageHost && response.state === "captive-http";
	if (response.state !== "clear" || response.code !== 200)
		return {
			host,
			state:
				response.state === "clear" || repositoryAnswered
					? "no-route"
					: response.state,
			latencyMs: response.latencyMs,
		};
	const files = ownedFiles(deps.owner);
	const dir = await files.makeTempDirectory(
		"private-file:create",
		join(tmpdir(), "ceraui-update-index-"),
	);
	try {
		const inRelease = join(dir, "InRelease");
		await files.writeNew(
			"private-file:create",
			inRelease,
			response.body,
			0o600,
		);
		const verified = await deps.run([
			"gpgv",
			"--keyring",
			argMatch(/^\/[\w./-]+$/, source.keyring),
			inRelease,
		]);
		return {
			host,
			state: verified.exitCode === 0 ? "clear" : "tampered",
			latencyMs: response.latencyMs,
		};
	} catch (error) {
		if (isOwnerEnded(error)) throw error;
		return {
			host,
			state: failureFromError(error),
			latencyMs: response.latencyMs,
		};
	} finally {
		await files.removeTree("private-file:remove", dir);
	}
}

/**
 * True unless NetworkManager reports at least one uplink as unmetered. An
 * unreadable inventory counts as metered, so a failed probe never opens cellular.
 */
export async function onlyMeteredUplinksRemain(
	deps: UpdateTransportDeps = defaultUpdateTransportDeps,
): Promise<boolean> {
	let nmcli: SpawnWithTimeoutResult;
	try {
		nmcli = await deps.run([
			"nmcli",
			"-t",
			"-f",
			UPDATE_INVENTORY_NMCLI_FIELDS,
			"device",
			"show",
		]);
	} catch {
		return true;
	}
	if (nmcli.exitCode !== 0) return true;
	const candidates = discoverCandidates(
		deps.listIfnames(),
		nmcli.stdout,
		deps.mmIfnames(),
		deps.routerIfnames(),
		deps.dongleIfnames(),
	);
	return !candidates.some((c) => c.metered === false);
}

/**
 * Probe every candidate uplink × family for `profile` and rank them. Every
 * answer — including the early "nothing to probe" ones — is recorded as the
 * last selection, which the Updates dialog's Connection section reads back;
 * the record is an observation and never feeds a routing decision.
 */
export async function selectUpdateTransport(
	profile: UpdateProfile,
	deps: UpdateTransportDeps = defaultUpdateTransportDeps,
	// Whom the selection is made for (an install on an image with its own apt
	// source). Every command and write of it then carries that owner.
	owner?: EffectOwner,
): Promise<TransportSelection> {
	const selection = await probeUpdateTransport(
		profile,
		owner === undefined
			? deps
			: {
					...deps,
					owner,
					run: (argv, privateUrl) => deps.run(argv, privateUrl, owner),
				},
	);
	// An ended owner publishes no finding: the record keeps the last real one.
	ownedWrite(owner, "transport-selection:publish", () =>
		recordTransportSelection(profile.profile, selection),
	);
	if (profile.profile === "os" && selection.status === "none") {
		logger.warn("No healthy update transport", {
			profile: "os",
			findings: selection.ranked.map((row) => ({
				ifname: row.candidate.ifname,
				family: row.family,
				reason: row.reason,
			})),
		});
	}
	return selection;
}

async function probeUpdateTransport(
	profile: UpdateProfile,
	deps: UpdateTransportDeps,
): Promise<TransportSelection> {
	argMatch(ID_RE, profile.board);
	let nmcli: SpawnWithTimeoutResult;
	try {
		nmcli = await deps.run([
			"nmcli",
			"-t",
			"-f",
			UPDATE_INVENTORY_NMCLI_FIELDS,
			"device",
			"show",
		]);
	} catch (error) {
		if (isOwnerEnded(error)) throw error;
		return rankTransports([]);
	}
	if (nmcli.exitCode !== 0) return rankTransports([]);
	const candidates = discoverCandidates(
		deps.listIfnames(),
		nmcli.stdout,
		deps.mmIfnames(),
		deps.routerIfnames(),
		deps.dongleIfnames(),
	);
	const sources =
		profile.profile === "apt"
			? parseDebianSources(await deps.readSources(), imageAptSourceInUse())
			: [];
	if (profile.profile === "apt" && sources.length === 0)
		return rankTransports([]);
	// The first-party archive is probed (with its client certificate) only where it is a source.
	const firstParty = profile.profile === "apt" && !imageAptSourceInUse();
	const credentials = firstParty ? await deps.credentials() : undefined;
	// Live verification against the Todo-12-deployed apt.ceralive.tv is deferred; fixture contracts are the current evidence.
	const imageBase = profile.profile === "os" ? await updateChannelUrl() : "";
	// Every probe that was started is waited for, also when one is refused.
	const samples: TransportSample[] = await ownedAll(
		deps.owner,
		candidates.flatMap((candidate) =>
			([4, 6] as const).map(async (family) => ({
				candidate,
				family,
				hosts:
					profile.profile === "apt"
						? [
								...(firstParty
									? [
											await endpoint(
												"https://apt.ceralive.tv",
												candidate.ifname,
												family,
												profile,
												deps,
												credentials,
											),
										]
									: []),
								...(await ownedAll(
									deps.owner,
									sources.map((source) =>
										debian(source, candidate.ifname, family, deps),
									),
								)),
							]
						: [
								await endpoint(
									imageBase,
									candidate.ifname,
									family,
									profile,
									deps,
								),
							],
			})),
		),
	);
	return rankTransports(samples);
}
