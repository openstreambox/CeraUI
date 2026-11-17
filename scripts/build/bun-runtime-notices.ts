// Third-party notices of the Bun runtime that compiled executables embed.
//
// Bun's LICENSE.md lists the libraries Bun links, but not their licence texts.
// This module adds those texts to the package's copyright file from a small,
// checked-in inventory (scripts/build/notices/bun-<version>/inventory.json) and
// the verbatim files beside it. The inventory is regenerated from Bun's own
// pinned inputs by bun-runtime-notices-refresh.ts; this module only reads it.
//
// The inventory names source candidates: the notice files of the sources Bun
// pins for its runtime, not proof that every file was linked. What the build
// could not establish is listed as an open gap, and the copyright file says so.
//
// Every check here runs offline and fails closed: a changed, missing, truncated,
// extra or moved text, an inventory whose hash the policy does not pin, an
// origin whose identity its pin does not name, or a gap marked resolved
// without checkable evidence all stop the build.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type SupplementPolicy = {
	/** Repository path of inventory.json; the texts live beside it. */
	inventory: string;
	/** sha256 of inventory.json. */
	sha256: string;
};

/** A file of another origin whose content names this origin's identity. */
export type Pin = {
	origin: string;
	path: string;
	/** Git blob id of the pinning file at that origin's commit. */
	gitBlob: string;
	/** Literal text in the pinning file. It must contain the pinned identity. */
	text: string;
};

export type Origin = {
	id: string;
	kind: "git" | "archive" | "deb";
	url: string;
	/** What this origin is, in a sentence. */
	role: string;
	/** The object Bun pins: a commit, or an annotated tag peeled to `peeled`. */
	commit?: string;
	peeled?: string;
	tree?: string;
	/** A tag Bun cites for this origin, resolved to `commit` when the inventory was made. */
	tag?: string;
	sha256?: string;
	size?: number;
	/** npm sha512 integrity, when that is the pin. */
	integrity?: string;
	/** A Debian package inside an archive origin. */
	within?: { origin: string; member: string };
	pins: Pin[];
	/** A published document, itself identified by sha256, that names this identity. */
	via?: { url: string; sha256: string; text: string };
};

export const SECTIONS = {
	linked: "Libraries and sources compiled into the Bun runtime",
	headers: "Licence statements kept in the source files themselves",
	"rust-std": "Rust standard library",
	crates: "Rust crates",
	polyfills: "Node.js compatibility packages embedded in Bun",
	"cxx-runtime": "Static C++ runtime",
} as const;
export type SectionId = keyof typeof SECTIONS;

export type NoticeText = {
	origin: string;
	path: string;
	/** notice: a whole licence, copying, notice or authors file. header: the start of a source file. */
	kind: "notice" | "header";
	section: SectionId;
	sha256: string;
	size: number;
	/** Git blob id of the whole upstream file (git origins). */
	gitBlob?: string;
	/** header texts: sha256 and size of the whole upstream file. */
	fileSha256?: string;
	fileSize?: number;
	/** Why this file is included, when it is not a named notice file (required for headers). */
	because?: string;
};

export type Excluded = { origin: string; path: string; reason: string };

export type Evidence =
	| { kind: "packaged-text"; origin: string; path: string; sha256: string }
	| {
			kind: "first-party";
			file: string;
			sha256: string;
			official: { url: string; sha256: string };
	  };

export type Gap = {
	id: string;
	status: "open" | "resolved";
	text: string;
	evidence?: Evidence[];
};

export type BuildOnly = { id: string; what: string; identity: string; note: string };

export type Inventory = {
	schema: 1;
	runtime: { name: string; version: string; revision: string; tree: string; licenceSha256: string };
	statement: string;
	origins: Origin[];
	texts: NoticeText[];
	excluded: Excluded[];
	buildOnly: BuildOnly[];
	gaps: Gap[];
};

export type RuntimeIdentity = { name: string; version: string; revision: string; sha256: string };

export type VerifiedSupplement = {
	inventory: Inventory;
	inventorySha256: string;
	/** Bytes of each text, by textKey. */
	payload: Map<string, Uint8Array>;
};

export function sha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Git blob id of a file's bytes. */
export function gitBlobId(data: Uint8Array): string {
	return createHash("sha1").update(`blob ${data.byteLength}\0`).update(data).digest("hex");
}

export function textKey(text: Pick<NoticeText, "origin" | "path">): string {
	return `${text.origin}\0${text.path}`;
}

const ORIGIN_ID = /^[a-z0-9][a-z0-9._+@-]*(?:\/[a-z0-9][a-z0-9._+@~-]*)*$/i;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Reject absolute, parent, empty or odd path segments: paths become file names. */
export function assertSafePath(path: string, what: string): void {
	const parts = path.split("/");
	if (
		path.length === 0 ||
		path.length > 400 ||
		/[\0\\\r\n]/.test(path) ||
		parts.some((part) => part === "" || part === "." || part === "..")
	) {
		throw new Error(`unsafe path in ${what}: ${JSON.stringify(path)}`);
	}
}

/** Where a text lives below the inventory's directory: named by its own sha256. */
export function textFile(text: Pick<NoticeText, "sha256">): string {
	return `texts/${text.sha256}`;
}

function listFiles(root: string, dir = root): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		const rel = path.slice(root.length + 1);
		if (entry.isSymbolicLink()) throw new Error(`symbolic link in the notice texts: ${rel}`);
		if (entry.isDirectory()) return listFiles(root, path);
		if (!entry.isFile()) throw new Error(`unexpected file type in the notice texts: ${rel}`);
		return [rel.split("\\").join("/")];
	});
}

function fail(problems: string[], message: string): void {
	problems.push(message);
}

/**
 * Check the inventory and every text it names, offline. Returns the texts.
 * `firstParty` maps first-party licence files to their bytes; evidence for a
 * resolved gap may point at one of them.
 */
export function verifySupplement(
	repoRoot: string,
	policy: SupplementPolicy,
	runtime: RuntimeIdentity,
	firstPartyFiles: string[],
): VerifiedSupplement {
	const inventoryPath = resolve(repoRoot, policy.inventory);
	if (!existsSync(inventoryPath)) {
		throw new Error(`Bun runtime notice inventory missing: ${policy.inventory}`);
	}
	if (lstatSync(inventoryPath).isSymbolicLink()) {
		throw new Error(`Bun runtime notice inventory is a symbolic link: ${policy.inventory}`);
	}
	const raw = readFileSync(inventoryPath);
	const inventorySha256 = sha256(raw);
	if (inventorySha256 !== policy.sha256) {
		throw new Error(
			`Bun runtime notice inventory changed: ${policy.inventory} is ${inventorySha256}, ` +
				`the policy pins ${policy.sha256}; regenerate it with bun-runtime-notices-refresh.ts`,
		);
	}
	const inventory = JSON.parse(raw.toString("utf8")) as Inventory;
	const problems: string[] = [];

	if (inventory.schema !== 1) fail(problems, `unsupported inventory schema ${inventory.schema}`);
	const rt = inventory.runtime;
	if (
		rt?.name !== runtime.name ||
		rt.version !== runtime.version ||
		rt.revision !== runtime.revision ||
		rt.licenceSha256 !== runtime.sha256
	) {
		fail(
			problems,
			`inventory is for ${rt?.name} ${rt?.version}+${rt?.revision}, licence ${rt?.licenceSha256}; ` +
				`the package pins ${runtime.name} ${runtime.version}+${runtime.revision}, licence ${runtime.sha256}`,
		);
	}
	if (!inventory.statement?.trim()) fail(problems, "inventory has no statement of scope");

	// Origins: unique ids, a usable identity, and pins that name it and lead back to Bun.
	const origins = new Map<string, Origin>();
	for (const origin of inventory.origins ?? []) {
		if (!ORIGIN_ID.test(origin.id)) fail(problems, `bad origin id ${JSON.stringify(origin.id)}`);
		if (origins.has(origin.id)) fail(problems, `duplicate origin ${origin.id}`);
		origins.set(origin.id, origin);
		if (!/^https:\/\//.test(origin.url)) fail(problems, `${origin.id}: no https source URL`);
		if (!origin.role?.trim()) fail(problems, `${origin.id}: no role`);
		if (origin.kind === "git") {
			if (!HEX40.test(origin.commit ?? "") || !HEX40.test(origin.tree ?? "")) {
				fail(problems, `${origin.id}: a git origin needs a commit and a tree`);
			}
		} else if (origin.kind === "archive") {
			if (!HEX64.test(origin.sha256 ?? "") || !(Number(origin.size) > 0)) {
				fail(problems, `${origin.id}: an archive origin needs a sha256 and a size`);
			}
		} else if (origin.kind === "deb") {
			if (!HEX64.test(origin.sha256 ?? "") || !origin.within?.member) {
				fail(problems, `${origin.id}: a package origin needs a sha256 and its archive member`);
			}
		} else fail(problems, `${origin.id}: unknown origin kind ${String(origin.kind)}`);
	}
	const bun = origins.get("bun");
	if (!bun || bun.kind !== "git" || bun.commit !== runtime.revision || bun.tree !== rt?.tree) {
		fail(problems, "the bun origin must be the pinned runtime revision and tree");
	}
	for (const origin of origins.values()) {
		const identity =
			origin.kind === "git" ? (origin.tag ?? origin.commit) : (origin.integrity ?? origin.sha256);
		if (origin.id === "bun") continue;
		if (origin.kind === "deb") {
			const parent = origin.within ? origins.get(origin.within.origin) : undefined;
			if (!parent || parent.kind !== "archive") {
				fail(
					problems,
					`${origin.id}: its archive ${origin.within?.origin} is not an archive origin`,
				);
			}
			continue;
		}
		if (!origin.pins?.length) {
			fail(problems, `${origin.id}: no pin says where its identity comes from`);
			continue;
		}
		for (const pin of origin.pins) {
			if (!origins.has(pin.origin))
				fail(problems, `${origin.id}: pinned by unknown origin ${pin.origin}`);
			if (!HEX40.test(pin.gitBlob ?? ""))
				fail(problems, `${origin.id}: pin without the pinning blob`);
			assertSafePath(pin.path, `${origin.id} pin`);
		}
		// A pin, or the document it leads to, must state the identity itself, so a
		// rewritten commit or hash cannot pass with an old pin.
		if (
			origin.via &&
			(!HEX64.test(origin.via.sha256 ?? "") || !/^https:\/\//.test(origin.via.url ?? ""))
		) {
			fail(problems, `${origin.id}: its naming document has no sha256 or URL`);
		}
		const named =
			identity &&
			(origin.pins.some((pin) => pin.text.includes(identity)) ||
				origin.via?.text.includes(identity));
		if (!named) {
			fail(problems, `${origin.id}: no pin names its identity ${identity}`);
		}
		// Follow pins back to Bun; a cycle or a dead end fails.
		const seen = new Set<string>();
		let at: Origin | undefined = origin;
		while (at && at.id !== "bun" && !seen.has(at.id)) {
			seen.add(at.id);
			at =
				at.kind === "deb"
					? origins.get(at.within?.origin ?? "")
					: origins.get(at.pins[0]?.origin ?? "");
		}
		if (at?.id !== "bun")
			fail(problems, `${origin.id}: its pins do not lead back to the Bun revision`);
	}

	// Texts: each one at its derived place, with the recorded bytes.
	const root = dirname(inventoryPath);
	const payload = new Map<string, Uint8Array>();
	const expectedFiles = new Set<string>();
	for (const text of inventory.texts ?? []) {
		const where = `${text.origin}:${text.path}`;
		try {
			assertSafePath(text.path, where);
		} catch (error) {
			fail(problems, (error as Error).message);
			continue;
		}
		const origin = origins.get(text.origin);
		if (!origin) fail(problems, `${where}: unknown origin`);
		if (!(text.section in SECTIONS)) fail(problems, `${where}: unknown section ${text.section}`);
		if (!HEX64.test(text.sha256 ?? "")) {
			fail(problems, `${where}: no sha256`);
			continue;
		}
		if (text.kind !== "notice" && text.kind !== "header") fail(problems, `${where}: unknown kind`);
		if (payload.has(textKey(text))) fail(problems, `${where}: listed twice`);
		const file = textFile(text);
		expectedFiles.add(file);
		const full = join(root, file);
		if (!existsSync(full)) {
			fail(problems, `${where}: text missing (${file})`);
			continue;
		}
		const bytes = new Uint8Array(readFileSync(full));
		if (bytes.byteLength !== text.size || sha256(bytes) !== text.sha256) {
			fail(problems, `${where}: text changed or truncated (${file})`);
			continue;
		}
		if (text.kind === "notice") {
			if (origin?.kind === "git" && text.gitBlob !== gitBlobId(bytes)) {
				fail(problems, `${where}: text does not match its upstream git blob ${text.gitBlob}`);
			}
		} else {
			// A header is the start of the upstream file, through its last licence line.
			const fileSize = Number(text.fileSize);
			if (!(fileSize > text.size || (fileSize === text.size && text.fileSha256 === text.sha256))) {
				fail(problems, `${where}: a header that is not the start of its file`);
			}
			if (!HEX64.test(text.fileSha256 ?? ""))
				fail(problems, `${where}: header without its file hash`);
			if (!text.because?.trim()) fail(problems, `${where}: header without a reason`);
		}
		payload.set(textKey(text), bytes);
	}
	for (const file of listFiles(root, join(root, "texts"))) {
		if (!expectedFiles.has(file)) fail(problems, `text not in the inventory: ${file}`);
	}

	// Exclusions: every excluded named file has a reason and is not also included.
	const excludedKeys = new Set<string>();
	for (const entry of inventory.excluded ?? []) {
		const key = textKey(entry);
		if (!origins.has(entry.origin))
			fail(problems, `excluded ${entry.path}: unknown origin ${entry.origin}`);
		if (!entry.reason?.trim())
			fail(problems, `excluded ${entry.origin}:${entry.path} has no reason`);
		if (excludedKeys.has(key))
			fail(problems, `excluded ${entry.origin}:${entry.path} listed twice`);
		if (payload.has(key))
			fail(problems, `${entry.origin}:${entry.path} is both packaged and excluded`);
		excludedKeys.add(key);
	}

	// Gaps: open ones are stated; resolved ones carry evidence that checks out.
	const gapIds = new Set<string>();
	for (const gap of inventory.gaps ?? []) {
		if (gapIds.has(gap.id)) fail(problems, `gap ${gap.id} listed twice`);
		gapIds.add(gap.id);
		if (!gap.text?.trim()) fail(problems, `gap ${gap.id} has no text`);
		if (gap.status === "open") continue;
		if (gap.status !== "resolved") {
			fail(problems, `gap ${gap.id}: unknown status ${String(gap.status)}`);
			continue;
		}
		if (!gap.evidence?.length) {
			fail(problems, `gap ${gap.id} is marked resolved without evidence`);
			continue;
		}
		for (const evidence of gap.evidence) {
			if (evidence.kind === "packaged-text") {
				const bytes = payload.get(textKey(evidence));
				if (!bytes || sha256(bytes) !== evidence.sha256) {
					fail(
						problems,
						`gap ${gap.id}: evidence ${evidence.origin}:${evidence.path} is not a packaged text`,
					);
				}
			} else if (evidence.kind === "first-party") {
				const path = resolve(repoRoot, evidence.file);
				const ok =
					firstPartyFiles.includes(evidence.file) &&
					existsSync(path) &&
					sha256(readFileSync(path)) === evidence.sha256 &&
					evidence.official?.sha256 === evidence.sha256 &&
					/^https:\/\//.test(evidence.official?.url ?? "");
				if (!ok) {
					fail(
						problems,
						`gap ${gap.id}: evidence ${evidence.file} is not a packaged first-party text equal to ${evidence.official?.url}`,
					);
				}
			} else {
				fail(problems, `gap ${gap.id}: unknown evidence kind`);
			}
		}
	}
	for (const item of inventory.buildOnly ?? []) {
		if (!item.id || !item.what?.trim() || !item.identity?.trim()) {
			fail(problems, `build-only context ${item.id} is incomplete`);
		}
	}
	if (problems.length > 0) {
		throw new Error(`Bun runtime notices:\n  ${problems.join("\n  ")}`);
	}
	return { inventory, inventorySha256, payload };
}

const RULE = "=".repeat(78);
const THIN = "-".repeat(78);

function identityLine(origin: Origin): string {
	if (origin.kind === "git") {
		const tag = origin.tag
			? ` (${origin.tag})`
			: origin.peeled
				? ` (tag object; commit ${origin.peeled})`
				: "";
		return `${origin.url} at ${origin.commit}${tag}`;
	}
	if (origin.kind === "deb") {
		return `${origin.within?.member} (sha256 ${origin.sha256}) inside ${origin.within?.origin}`;
	}
	return `${origin.url} (sha256 ${origin.sha256}${origin.integrity ? `, ${origin.integrity}` : ""})`;
}

/**
 * The supplement as it goes into the copyright file. Each distinct text is
 * printed once, byte for byte, between markers that state its sha256 and length;
 * later carriers of the same text point back to it.
 */
export function renderSupplement(verified: VerifiedSupplement): Uint8Array {
	const { inventory, payload } = verified;
	const origins = new Map(inventory.origins.map((origin) => [origin.id, origin]));
	const chunks: Uint8Array[] = [];
	const encoder = new TextEncoder();
	const line = (text = "") => chunks.push(encoder.encode(`${text}\n`));
	const rt = inventory.runtime;

	line();
	line(RULE);
	line(`${rt.name} ${rt.version} (${rt.revision}): notices of what it links`);
	line(RULE);
	line();
	for (const paragraph of inventory.statement.split("\n")) line(paragraph);
	line();
	line(
		`Each text is printed once, unchanged, between "-----BEGIN TEXT" and "-----END TEXT"; ` +
			"the marker states its sha256 and length in bytes.",
	);

	const printed = new Map<string, string>();
	for (const [section, title] of Object.entries(SECTIONS) as [SectionId, string][]) {
		const texts = inventory.texts
			.filter((text) => text.section === section)
			.sort((a, b) =>
				a.origin === b.origin ? (a.path < b.path ? -1 : 1) : a.origin < b.origin ? -1 : 1,
			);
		if (texts.length === 0) continue;
		line();
		line(RULE);
		line(title);
		line(RULE);
		let current = "";
		for (const text of texts) {
			if (text.origin !== current) {
				current = text.origin;
				const origin = origins.get(text.origin);
				line();
				line(THIN);
				line(`${text.origin}: ${origin?.role ?? ""}`);
				if (origin) line(`Source: ${identityLine(origin)}`);
				line(THIN);
			}
			line();
			line(`--- ${text.path} ---`);
			if (text.kind === "header") {
				line(
					`The first ${text.size} bytes of this file, through its last licence or copyright line.`,
				);
			}
			if (text.because)
				line(`Included because ${text.because}${/[.!?"]$/.test(text.because) ? "" : "."}`);
			const first = printed.get(text.sha256);
			if (first) {
				line(`Same text as ${first}, printed above.`);
				continue;
			}
			printed.set(text.sha256, `${text.origin}: ${text.path}`);
			const bytes = payload.get(textKey(text));
			if (!bytes) throw new Error(`no bytes for ${text.origin}:${text.path}`);
			line(`-----BEGIN TEXT sha256=${text.sha256} bytes=${text.size}-----`);
			chunks.push(bytes);
			if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] !== 0x0a) line();
			line("-----END TEXT-----");
		}
	}

	line();
	line(RULE);
	line("Build-only inputs (not shipped; their texts are not included)");
	line(RULE);
	for (const item of inventory.buildOnly) {
		line();
		line(`- ${item.what}`);
		line(`  ${item.identity}`);
		line(`  ${item.note}`);
	}

	line();
	line(RULE);
	line("Known gaps");
	line(RULE);
	for (const gap of inventory.gaps) {
		line();
		line(`[${gap.status}] ${gap.text}`);
		for (const evidence of gap.evidence ?? []) {
			line(
				evidence.kind === "first-party"
					? `  Evidence: ${evidence.file} (printed at the top of this file) is byte-identical to ${evidence.official.url} (sha256 ${evidence.sha256}).`
					: `  Evidence: ${evidence.origin}: ${evidence.path} (sha256 ${evidence.sha256}), printed above.`,
			);
		}
	}
	line();
	line(
		`Named notice files of these sources that were left out, each with its reason: ${inventory.excluded.length}. ` +
			"They are listed in the inventory file of the CeraUI source tree.",
	);

	const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const out = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}

/** Find every printed text in a rendered copyright file: sha256 -> bytes. */
export function extractPrintedTexts(rendered: Uint8Array): Map<string, Uint8Array> {
	const latin1 = Buffer.from(rendered).toString("latin1");
	const found = new Map<string, Uint8Array>();
	const marker = /-----BEGIN TEXT sha256=([0-9a-f]{64}) bytes=(\d+)-----\n/g;
	for (const match of latin1.matchAll(marker)) {
		const start = (match.index ?? 0) + match[0].length;
		const size = Number(match[2]);
		const bytes = rendered.slice(start, start + size);
		const tail = latin1.slice(start + size, start + size + 20);
		if (!/^\n?-----END TEXT-----\n/.test(tail)) {
			throw new Error(`text ${match[1]} is not followed by its end marker`);
		}
		found.set(match[1] ?? "", bytes);
	}
	return found;
}

/** The index entry written beside the built package. */
export function supplementIndex(verified: VerifiedSupplement, inventoryPath: string) {
	const { inventory } = verified;
	return {
		inventory: inventoryPath,
		sha256: verified.inventorySha256,
		texts: inventory.texts.map(({ origin, path, kind, section, sha256 }) => ({
			origin,
			path,
			kind,
			section,
			sha256,
		})),
		excluded: inventory.excluded.length,
		gaps: inventory.gaps.map(({ id, status }) => ({ id, status })),
	};
}
