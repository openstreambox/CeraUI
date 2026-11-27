/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * An image that ships its own signed apt source.
 *
 * Such an image has exactly one apt source, a deb822 file with two suites:
 * `<board>-<version>` (exactly the installed packages) and the same name plus
 * `-emergency` (normally empty, occasionally a fix). It records that source in
 * {@link IMAGE_APT_SOURCE_POLICY}. When the record is there, package updates
 * come only from that source, the first-party archive is never written back
 * as an apt source, and the source's URI (whose first path segment is an
 * access token) is shown by host only. A record that is there but does not
 * validate refuses package checks; it never falls back to the first-party
 * archive. Without the record nothing here changes behaviour.
 */

import { existsSync, readdirSync } from "node:fs";
import { z } from "zod";
import { logger } from "../../helpers/logger.ts";
import {
	readStoredStateFileSync,
	STORED_STATE_LIMITS,
	StoredStateReadError,
} from "./update-orchestrator/stored-state-file.ts";
import {
	AuthorityJsonError,
	parseAuthorityJson,
} from "./update-orchestrator/strict-authority-json.ts";

export const IMAGE_APT_SOURCE_POLICY =
	"/usr/lib/ceralive/image-apt-source.json";

/**
 * Written by the image's clock gate once the wall clock is usable (chrony is
 * synchronised, or the clock is clearly past the build-date floor). apt's
 * signature check refuses a Release signed in the box clock's future, which a
 * cold boot without RTC is.
 */
export const IMAGE_CLOCK_GATE_FLAG = "/run/ceralive/clock-gate-open";

export const IMAGE_APT_ORIGIN = "OpenStreamBox";

/** dpkg's journal of an unfinished run: what apt checks before it takes the lock. */
export const DPKG_UPDATES_DIR = "/var/lib/dpkg/updates";

export type ImageAptSource = {
	/** The only part of the source ever shown or logged. */
	readonly host: string;
	/** The URI as apt prints it: no trailing slash. Carries the token. */
	readonly uri: string;
	/** The URI's first path segment. */
	readonly token: string;
	readonly suites: readonly [string, string];
	/** The keyring its `Signed-By` names. */
	readonly keyring: string;
	readonly sourcesFile: string;
};

/** One signed index of the image's source: what a probe fetches and verifies. */
export type ImageAptSourceIndex = {
	readonly suite: string;
	/** The repository, as apt and the probes write it: no trailing slash. */
	readonly repository: string;
	/** `<repository>/dists/<suite>/InRelease`. Carries the token. */
	readonly url: string;
};

export type ImageAptSourceMode =
	| { readonly kind: "absent" }
	| { readonly kind: "active"; readonly source: ImageAptSource }
	| { readonly kind: "invalid"; readonly problem: string };

const HOST_RE =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SUITE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d{4}\.\d{1,2}\.\d{1,4}$/;
const SOURCES_FILE_RE =
	/^\/etc\/apt\/sources\.list\.d\/[A-Za-z0-9_][A-Za-z0-9_.-]*\.sources$/;
const URI_RE =
	/^https:\/\/([a-z0-9.-]+)(?::(\d{1,5}))?((?:\/[A-Za-z0-9._~-]+)+)\/?$/;
const SIGNED_BY_RE = /^\/[\w./-]+$/;
const ARCHITECTURES_RE = /^[a-z0-9-]+(?: [a-z0-9-]+)*$/;
/**
 * The shortest access token a source may carry. The images' own check allows
 * none shorter, and a shorter one could not be told from ordinary text when
 * apt echoes it: such a source is refused, not half redacted.
 */
export const IMAGE_APT_TOKEN_MIN = 20;

const policySchema = z
	.object({
		schema: z.literal(1),
		sourcesFile: z.string().regex(SOURCES_FILE_RE),
		host: z.string().regex(HOST_RE),
		origin: z.literal(IMAGE_APT_ORIGIN),
		label: z.literal(IMAGE_APT_ORIGIN),
		suites: z.tuple([z.string().regex(SUITE_RE), z.string()]),
	})
	.strict()
	.refine(({ suites: [main, emergency] }) => emergency === `${main}-emergency`);

// Only fields apt reads for a plain signed source; anything else (Trusted,
// Allow-Insecure, Enabled, …) could weaken it.
const SOURCE_FIELDS = new Set([
	"types",
	"uris",
	"suites",
	"components",
	"architectures",
	"signed-by",
]);

class SourceInvalid extends Error {}

function sourceFields(text: string): Map<string, string> {
	const stanzas = text
		.split("\n")
		.filter((line) => !line.startsWith("#"))
		.join("\n")
		.split(/\n[ \t]*\n/)
		.filter((stanza) => stanza.trim() !== "");
	if (stanzas.length !== 1) throw new SourceInvalid("not exactly one stanza");
	const fields = new Map<string, string>();
	let current: string | undefined;
	for (const line of (stanzas[0] ?? "").split("\n")) {
		if (line.trim() === "") continue;
		if (/^[ \t]/.test(line)) {
			if (current === undefined) throw new SourceInvalid("stray continuation");
			fields.set(current, `${fields.get(current)} ${line.trim()}`.trim());
			continue;
		}
		const match = /^([A-Za-z][A-Za-z-]*):[ \t]*(.*?)[ \t]*$/.exec(line);
		if (!match) throw new SourceInvalid("unreadable line");
		current = (match[1] ?? "").toLowerCase();
		if (!SOURCE_FIELDS.has(current))
			throw new SourceInvalid(`unexpected field ${current}`);
		if (fields.has(current))
			throw new SourceInvalid(`duplicate field ${current}`);
		fields.set(current, match[2] ?? "");
	}
	return fields;
}

/**
 * The image's source, or why it does not match its record: `policy` is the
 * record's text, `readSources` reads the file it names (null when absent).
 */
export function parseImageAptSource(
	policy: string,
	readSources: (path: string) => string | null,
): ImageAptSourceMode {
	let parsed: z.infer<typeof policySchema>;
	try {
		const result = policySchema.safeParse(parseAuthorityJson(policy));
		if (!result.success) return { kind: "invalid", problem: "record_schema" };
		parsed = result.data;
	} catch (error) {
		return {
			kind: "invalid",
			problem:
				error instanceof AuthorityJsonError ? error.reason : "record_json",
		};
	}
	let sources: string | null;
	try {
		sources = readSources(parsed.sourcesFile);
	} catch (error) {
		return {
			kind: "invalid",
			problem: `sources: ${error instanceof StoredStateReadError ? error.reason : "read_failed"}`,
		};
	}
	if (sources === null) return { kind: "invalid", problem: "sources_missing" };
	try {
		const fields = sourceFields(sources);
		const words = (field: string) =>
			(fields.get(field) ?? "").split(/\s+/).filter(Boolean);
		if (words("types").join(" ") !== "deb")
			throw new SourceInvalid("types not deb");
		if (words("components").join(" ") !== "main")
			throw new SourceInvalid("components not main");
		const suites = words("suites");
		if (
			suites.length !== 2 ||
			!parsed.suites.every((suite) => suites.includes(suite))
		)
			throw new SourceInvalid("suites differ from the record");
		const signedBy = fields.get("signed-by") ?? "";
		if (!SIGNED_BY_RE.test(signedBy) || signedBy.includes(".."))
			throw new SourceInvalid("signed-by not a keyring path");
		const architectures = fields.get("architectures");
		if (architectures !== undefined && !ARCHITECTURES_RE.test(architectures))
			throw new SourceInvalid("architectures unreadable");
		const uris = words("uris");
		if (uris.length !== 1) throw new SourceInvalid("not exactly one URI");
		const raw = uris[0] ?? "";
		const match = URI_RE.exec(raw);
		const segments = match?.[3]?.split("/").filter(Boolean) ?? [];
		// The same parser the probes use: a URI they would discard is refused here.
		const url = URL.canParse(raw) ? new URL(raw) : undefined;
		if (
			!match ||
			match[1] !== parsed.host ||
			segments.some((segment) => segment === "." || segment === "..") ||
			url === undefined ||
			url.protocol !== "https:" ||
			url.hostname !== parsed.host ||
			url.username !== "" ||
			url.password !== "" ||
			url.search !== "" ||
			url.hash !== "" ||
			url.port !== (match[2] === "443" ? "" : (match[2] ?? "")) ||
			url.pathname.replace(/\/+$/, "") !== match[3]
		)
			throw new SourceInvalid("URI does not name the recorded host");
		if ((segments[0] ?? "").length < IMAGE_APT_TOKEN_MIN)
			throw new SourceInvalid("access token too short");
		return {
			kind: "active",
			source: {
				host: parsed.host,
				uri: raw.replace(/\/+$/, ""),
				token: segments[0] ?? "",
				suites: parsed.suites,
				keyring: signedBy,
				sourcesFile: parsed.sourcesFile,
			},
		};
	} catch (error) {
		if (!(error instanceof SourceInvalid)) throw error;
		return { kind: "invalid", problem: `sources: ${error.message}` };
	}
}

type Reader = (path: string) => string | null;
const defaultReader: Reader = (path) =>
	readStoredStateFileSync(path, STORED_STATE_LIMITS.settings);
let reader: Reader = defaultReader;
let clockFlag = IMAGE_CLOCK_GATE_FLAG;
let dpkgUpdatesDir = DPKG_UPDATES_DIR;
// Both files are part of the booted image: read once per process.
let cached: ImageAptSourceMode | undefined;

/** Test seam: replace the file reader (null restores it) and forget the cached answer. */
export function setImageAptSourceReaderForTest(next: Reader | null): void {
	reader = next ?? defaultReader;
	cached = undefined;
}

/** Test seam: the clock gate's flag path (null restores it). */
export function setImageClockGateFlagForTest(path: string | null): void {
	clockFlag = path ?? IMAGE_CLOCK_GATE_FLAG;
}

/** Test seam: dpkg's journal directory (null restores it). */
export function setDpkgUpdatesDirForTest(path: string | null): void {
	dpkgUpdatesDir = path ?? DPKG_UPDATES_DIR;
}

function load(): ImageAptSourceMode {
	let policy: string | null;
	try {
		policy = reader(IMAGE_APT_SOURCE_POLICY);
	} catch (error) {
		return {
			kind: "invalid",
			problem:
				error instanceof StoredStateReadError ? error.reason : "read_failed",
		};
	}
	if (policy === null) return { kind: "absent" };
	return parseImageAptSource(policy, reader);
}

/** Whether, and how, the booted image ships its own apt source. Never throws. */
export function imageAptSourceMode(): ImageAptSourceMode {
	if (cached === undefined) {
		cached = load();
		if (cached.kind === "invalid")
			logger.warn(
				"Image apt source record unusable; package updates are refused",
				{ problem: cached.problem },
			);
	}
	return cached;
}

/** The record is there, valid or not: the first-party archive is not this box's source. */
export function imageAptSourceInUse(): boolean {
	return imageAptSourceMode().kind !== "absent";
}

export function activeImageAptSource(): ImageAptSource | undefined {
	const mode = imageAptSourceMode();
	return mode.kind === "active" ? mode.source : undefined;
}

/**
 * apt options that make one invocation read only the image's source file,
 * whatever the ambient configuration says; none on any other image. Every
 * package-update apt run in that mode carries them.
 */
export function imageAptSourceArgs(): string[] {
	const source = activeImageAptSource();
	return source === undefined
		? []
		: [
				"-o",
				`Dir::Etc::SourceList=${source.sourcesFile}`,
				"-o",
				"Dir::Etc::SourceParts=/dev/null",
			];
}

/** Whether `pair` is exactly {@link imageAptSourceArgs} for an active image source. */
export function isImageAptSourcePair(pair: readonly string[]): boolean {
	const expected = imageAptSourceArgs();
	return (
		expected.length === 4 &&
		pair.length === 4 &&
		expected.every((value, index) => pair[index] === value)
	);
}

/**
 * The image's source as its validator read it, for everything that probes
 * it: one signed index per suite. Nobody reads the source file a second
 * time, so what validated and what is probed cannot differ. Undefined on any
 * other image (its sources are read from disk as always); empty when the
 * record is invalid, so nothing is probed.
 */
export function imageAptSourceIndexes():
	| readonly ImageAptSourceIndex[]
	| undefined {
	const mode = imageAptSourceMode();
	if (mode.kind === "absent") return undefined;
	if (mode.kind !== "active") return [];
	const repository = new URL(mode.source.uri).href.replace(/\/+$/, "");
	return mode.source.suites.map((suite) => ({
		suite,
		repository,
		url: `${repository}/dists/${suite}/InRelease`,
	}));
}

/** Whether the image's clock gate says the wall clock is usable. */
export function imageClockUsable(): boolean {
	try {
		return existsSync(clockFlag);
	} catch {
		return false;
	}
}

/**
 * dpkg left a journal entry (a numbered file) from a run that did not finish,
 * so apt would refuse with "dpkg was interrupted". An unreadable directory
 * counts as interrupted.
 */
export function dpkgJournalPending(): boolean {
	try {
		return readdirSync(dpkgUpdatesDir).some((name) => /^\d+$/.test(name));
	} catch (error) {
		return !(
			error instanceof Error &&
			"code" in error &&
			error.code === "ENOENT"
		);
	}
}

/**
 * `text` with the image source's URI shown as its host, and any bare copy of
 * its token removed. Unchanged on any other image.
 */
export function redactImageAptSecret(text: string): string {
	const source = activeImageAptSource();
	if (source === undefined || source.token === "") return text;
	// apt may print the URI with or without its port.
	const path = source.uri.replace(/^https:\/\/[^/]+/, "");
	let out = text;
	for (const uri of new Set([source.uri, `https://${source.host}${path}`]))
		out = out.split(uri).join(`https://${source.host}`);
	// Every bare copy too, whatever the token's length.
	return out.split(source.token).join("[redacted]");
}

/** Whether `text` holds the image source's URI or its token. */
export function carriesImageAptSecret(text: string): boolean {
	return redactImageAptSecret(text) !== text;
}

/**
 * The refresh fetched or hit the Release of both image suites and failed no
 * index: the lists an install reads are current and validly signed.
 */
export function refreshedImageSuites(
	refresh: string,
	source: ImageAptSource,
): boolean {
	const lines = refresh
		.split("\n")
		.filter((line) => line.split(/\s+/)[1] === source.uri);
	if (lines.some((line) => /^(?:Ign|Err):/.test(line))) return false;
	return source.suites.every((suite) =>
		lines.some((line) =>
			new RegExp(
				`^(?:Hit|Get):\\d+ \\S+ ${suite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (?:In)?Release(?: \\[.*\\])?$`,
			).test(line),
		),
	);
}
