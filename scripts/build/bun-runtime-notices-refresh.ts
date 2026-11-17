#!/usr/bin/env bun
// Regenerate the Bun runtime notice inventory from Bun's own pinned inputs.
//
//   bun scripts/build/bun-runtime-notices-refresh.ts refresh --repo-root <CeraUI> --cache <dir> --out <new dir>
//   bun scripts/build/bun-runtime-notices-refresh.ts check   --repo-root <CeraUI> --cache <dir>
//
// Coverage comes from the inputs, not from a list kept by hand: the Bun commit
// the policy pins names its vendored libraries (scripts/build/deps/*.ts), its
// WebKit and ICU, its Rust toolchain and crates (Cargo.lock), the npm packages it
// embeds (src/node-fallbacks/bun.lock) and the GCC archive whose static C++
// runtime it links. Every named licence, copying, notice or authors file in those
// sources is either packaged or listed as excluded with its reason.
//
// The tool reads a local cache and never downloads. Git objects come from bare
// repositories at <cache>/git/<owner>/<repo>.git (lazy fetching disabled; every
// object it reads is rehashed); release files come from <cache>/files/<name of the
// URL's last segment>, each checked against its pin before it is opened. A
// missing input is reported with its URL and expected identity.
//
// Hand-maintained judgement lives in bun-runtime-notices.rules.json: which
// source roots are the runtime, which notices point to per-file headers (with
// the quote that says so), the build-only contexts and the stated gaps.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
	type BuildOnly,
	type Excluded,
	type Gap,
	gitBlobId,
	type Inventory,
	type NoticeText,
	type Origin,
	type Pin,
	type SectionId,
	sha256,
	textFile,
} from "./bun-runtime-notices.ts";

// ---------------------------------------------------------------------------
// What counts as a notice

const NAMED_LEAF =
	/^(?:.*[-_.])?(?:licen[cs]e|copying|copyright|notice|authors|patents|credits|unlicense|legal|third[-_]?party[-_]?notices?)(?:[-_.].*)?$/i;
const NAMED_DIR = /(?:^|\/)licen[cs]es?\//i;
// Source and data files whose names happen to match are not notices.
const NOT_TEXT =
	/\.(?:[cm]?[jt]sx?|json|toml|ya?ml|py|rs|c|cc|cpp|cxx|h|hh|hpp|go|rb|java|sh|cmake|in|am|mk|s|asm|pl|zig|svg|png|gif|jpe?g|wasm)$/i;
const TESTISH =
	/(?:^|\/)(?:tests?|testdata|testing|fuzz|fuzzing|bench|benches|benchmarks?|examples?|docs?|samples?|LayoutTests|JSTests|googletest|gtest|gmock|wycheproof[^/]*|testimages|testvectors)(?:\/|$)/i;

export function isNamedNotice(path: string): boolean {
	const leaf = path.slice(path.lastIndexOf("/") + 1);
	return (NAMED_LEAF.test(leaf) || NAMED_DIR.test(path)) && !NOT_TEXT.test(leaf);
}

export function isTestish(path: string): boolean {
	return TESTISH.test(path);
}

const HEADER_TRIGGER = /copyright|spdx-license-identifier|\xc2\xa9|public domain|\(c\) /i;
const HEADER_EXTENT =
	/copyright|spdx-license|licen[cs]e|permission|redistribut|warrant|public domain|\xc2\xa9|author/gi;

/**
 * The start of a source file through its last licence, copyright or author line
 * within the first 16 KiB; null for binary files or files with no such line.
 */
export function headerExcerpt(bytes: Uint8Array): Uint8Array | null {
	const head = bytes.subarray(0, 16384);
	if (head.subarray(0, 8192).includes(0)) return null;
	const text = Buffer.from(head).toString("latin1");
	if (!HEADER_TRIGGER.test(text)) return null;
	let end = 0;
	for (const match of text.matchAll(HEADER_EXTENT)) {
		const newline = text.indexOf("\n", (match.index ?? 0) + match[0].length);
		end = newline < 0 ? text.length : newline + 1;
	}
	return end > 0 ? head.slice(0, end) : null;
}

function require(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const normalise = (text: string) => text.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Readers: git objects, tar, ar, compressed streams

type GitObject = { type: string; body: Uint8Array };
type TreeEntry = { path: string; mode: string; oid: string };

/** Reads objects from a bare repository and rehashes each one. Never fetches. */
export class GitStore {
	private proc: ReturnType<typeof Bun.spawn> | null = null;
	private buffer = new Uint8Array(0);
	private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

	constructor(readonly dir: string) {
		require(existsSync(join(dir, "objects")), `missing git input ${dir}`);
	}

	private start() {
		if (this.proc) return;
		this.proc = Bun.spawn(["git", "--git-dir", this.dir, "cat-file", "--batch"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				GIT_NO_LAZY_FETCH: "1",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
			},
		});
		this.reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
	}

	private async fill(want: number): Promise<void> {
		while (this.buffer.byteLength < want) {
			const { value, done } = await (this.reader as ReadableStreamDefaultReader<Uint8Array>).read();
			if (done) throw new Error(`git cat-file ended early in ${this.dir}`);
			const next = new Uint8Array(this.buffer.byteLength + value.byteLength);
			next.set(this.buffer);
			next.set(value, this.buffer.byteLength);
			this.buffer = next;
		}
	}

	private take(count: number): Uint8Array {
		const out = this.buffer.slice(0, count);
		this.buffer = this.buffer.slice(count);
		return out;
	}

	/** The object, or null when this repository does not have it. */
	async get(oid: string): Promise<GitObject | null> {
		require(/^[0-9a-f]{40}$/.test(oid), `bad object id ${oid}`);
		this.start();
		const stdin = (this.proc as ReturnType<typeof Bun.spawn>).stdin as import("bun").FileSink;
		stdin.write(`${oid}\n`);
		stdin.flush();
		let newline = this.buffer.indexOf(0x0a);
		while (newline < 0) {
			await this.fill(this.buffer.byteLength + 1);
			newline = this.buffer.indexOf(0x0a);
		}
		const header = new TextDecoder()
			.decode(this.take(newline + 1))
			.trim()
			.split(" ");
		if (header[1] === "missing") return null;
		const [, type = "", sizeText = ""] = header;
		const size = Number(sizeText);
		await this.fill(size + 1);
		const body = this.take(size);
		this.take(1);
		const hash = createHash("sha1").update(`${type} ${size}\0`).update(body).digest("hex");
		require(hash === oid, `git object ${oid} in ${this.dir} does not hash to its id`);
		return { type, body };
	}

	async blob(oid: string, what: string): Promise<Uint8Array> {
		const object = await this.get(oid);
		require(object?.type === "blob", `missing blob ${oid} (${what}) in ${this.dir}`);
		return object.body;
	}

	/** Peel an annotated tag to its commit; return the commit and its tree. */
	async commit(oid: string): Promise<{ commit: string; tree: string; tag?: GitObject }> {
		let object = await this.get(oid);
		require(object, `missing commit ${oid} in ${this.dir}`);
		let tag: GitObject | undefined;
		let commit = oid;
		if (object.type === "tag") {
			tag = object;
			const text = new TextDecoder().decode(object.body);
			const target = /^object ([0-9a-f]{40})\ntype commit\n/.exec(text)?.[1];
			require(target, `tag ${oid} does not point at a commit`);
			commit = target;
			object = await this.get(target);
			require(object, `missing commit ${target} in ${this.dir}`);
		}
		require(object.type === "commit", `${oid} is not a commit`);
		const tree = /^tree ([0-9a-f]{40})\n/.exec(new TextDecoder().decode(object.body))?.[1];
		require(tree, `commit ${commit} has no tree`);
		return { commit, tree, ...(tag ? { tag } : {}) };
	}

	private async entries(tree: string): Promise<{ name: string; mode: string; oid: string }[]> {
		const object = await this.get(tree);
		require(object?.type === "tree", `missing tree ${tree} in ${this.dir}`);
		const out: { name: string; mode: string; oid: string }[] = [];
		const body = object.body;
		let i = 0;
		while (i < body.byteLength) {
			const space = body.indexOf(0x20, i);
			const nul = body.indexOf(0, space);
			const mode = new TextDecoder().decode(body.subarray(i, space));
			const name = new TextDecoder().decode(body.subarray(space + 1, nul));
			const oid = Buffer.from(body.subarray(nul + 1, nul + 21)).toString("hex");
			out.push({ name, mode, oid });
			i = nul + 21;
		}
		return out;
	}

	/** Every file below `tree`, optionally pruning directories. Submodules have mode 160000. */
	async walk(
		tree: string,
		enter: (dir: string) => boolean = () => true,
		prefix = "",
	): Promise<TreeEntry[]> {
		const out: TreeEntry[] = [];
		for (const entry of await this.entries(tree)) {
			const path = `${prefix}${entry.name}`;
			if (entry.mode === "40000") {
				if (enter(path)) out.push(...(await this.walk(entry.oid, enter, `${path}/`)));
			} else out.push({ path, mode: entry.mode, oid: entry.oid });
		}
		return out;
	}

	close() {
		this.proc?.kill();
		this.proc = null;
	}
}

export type ArchiveFile = { path: string; bytes: Uint8Array };
export type Archive = { files: Map<string, Uint8Array>; links: string[] };

function cString(bytes: Uint8Array, from: number, length: number): string {
	const slice = bytes.subarray(from, from + length);
	const nul = slice.indexOf(0);
	return new TextDecoder("latin1").decode(nul < 0 ? slice : slice.subarray(0, nul));
}

function octal(bytes: Uint8Array, from: number, length: number): number {
	if ((bytes[from] ?? 0) & 0x80) {
		let value = 0;
		for (let i = from + 1; i < from + length; i++) value = value * 256 + (bytes[i] ?? 0);
		return value;
	}
	const text = cString(bytes, from, length).trim();
	return text ? Number.parseInt(text, 8) : 0;
}

function safeMember(path: string): string {
	const clean = path.replace(/^\.\//, "").replace(/\/$/, "");
	const parts = clean.split("/");
	require(clean.length > 0 &&
		!clean.startsWith("/") &&
		!parts.includes("..") &&
		!/[\0\\]/.test(clean), `unsafe archive path ${JSON.stringify(path)}`);
	return clean;
}

/** Regular files of a tar stream; symbolic and hard links are only named. */
export function readTar(bytes: Uint8Array): Archive {
	const files = new Map<string, Uint8Array>();
	const links: string[] = [];
	let at = 0;
	let longName: string | null = null;
	let paxPath: string | null = null;
	while (at + 512 <= bytes.byteLength) {
		const header = bytes.subarray(at, at + 512);
		if (header.every((b) => b === 0)) break;
		let sum = 0;
		for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
		require(sum === octal(header, 148, 8), `tar header checksum mismatch at ${at}`);
		const size = octal(header, 124, 12);
		const type = String.fromCharCode(header[156] || 0x30);
		const prefix = cString(header, 345, 155);
		const name = cString(header, 0, 100);
		const data = bytes.subarray(at + 512, at + 512 + size);
		require(data.byteLength === size, "truncated tar member");
		at += 512 + Math.ceil(size / 512) * 512;
		if (type === "L") {
			longName = cString(data, 0, data.byteLength);
			continue;
		}
		if (type === "x") {
			const text = new TextDecoder().decode(data);
			paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)?.[1] ?? null;
			continue;
		}
		if (type === "g" || type === "K") continue;
		const raw = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name);
		paxPath = null;
		longName = null;
		if (type === "5") {
			require(!raw.split("/").includes("..") &&
				!raw.startsWith("/"), `unsafe archive path ${JSON.stringify(raw)}`);
			continue;
		}
		const path = safeMember(raw);
		if (type === "0" || type === "\0" || type === "7") {
			require(!files.has(path), `duplicate archive member ${path}`);
			files.set(path, data.slice());
		} else if (type === "1" || type === "2") links.push(path);
		else
			require(type === "3" || type === "4" || type === "6", `unsupported tar member type ${type}`);
	}
	return { files, links };
}

/** Members of an ar archive (a .deb). */
export function readAr(bytes: Uint8Array): Map<string, Uint8Array> {
	require(new TextDecoder().decode(bytes.subarray(0, 8)) === "!<arch>\n", "not an ar archive");
	const out = new Map<string, Uint8Array>();
	let at = 8;
	while (at + 60 <= bytes.byteLength) {
		const name = cString(bytes, at, 16).trim().replace(/\/$/, "");
		const size = Number(cString(bytes, at + 48, 10).trim());
		require(cString(bytes, at + 58, 2) === "`\n" && Number.isFinite(size), "corrupt ar header");
		const data = bytes.subarray(at + 60, at + 60 + size);
		require(data.byteLength === size, "truncated ar member");
		require(!out.has(name), `duplicate ar member ${name}`);
		out.set(safeMember(name), data.slice());
		at += 60 + size + (size % 2);
	}
	return out;
}

const MAX_UNPACKED = 4 * 1024 ** 3;

export async function decompress(bytes: Uint8Array, name: string): Promise<Uint8Array> {
	if (/\.(?:tgz|gz|crate)$/.test(name)) return Bun.gunzipSync(new Uint8Array(bytes));
	if (/\.xz$/.test(name)) {
		const proc = Bun.spawn(["xz", "--decompress", "--stdout", "--memlimit=1GiB"], {
			stdin: bytes,
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
		require((await proc.exited) === 0, `xz could not decompress ${name}`);
		require(out.byteLength < MAX_UNPACKED, `${name} unpacks beyond the size limit`);
		return out;
	}
	if (/\.tar$/.test(name)) return bytes;
	throw new Error(`unsupported compression: ${name}`);
}

// ---------------------------------------------------------------------------
// Cache of pinned inputs

export class InputCache {
	readonly missing: string[] = [];
	private stores = new Map<string, GitStore>();

	constructor(readonly root: string) {
		require(existsSync(root), `cache directory missing: ${root}`);
	}

	git(repo: string): GitStore {
		require(/^[\w.-]+\/[\w.-]+$/.test(repo), `bad repository name ${repo}`);
		let store = this.stores.get(repo);
		if (!store) {
			store = new GitStore(join(this.root, "git", `${repo}.git`));
			this.stores.set(repo, store);
		}
		return store;
	}

	/** A release file by URL, checked against sha256 or an npm sha512 integrity before use. */
	file(
		url: string,
		pin: { sha256?: string; integrity?: string; size?: number },
	): Uint8Array | null {
		const name = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
		require(/^[\w.+~-]+$/.test(name), `bad cache file name ${name}`);
		const path = join(this.root, "files", name);
		const want = pin.sha256 ? `sha256 ${pin.sha256}` : `${pin.integrity}`;
		if (!existsSync(path)) {
			this.missing.push(`${url} (${want})`);
			return null;
		}
		const bytes = new Uint8Array(readFileSync(path));
		if (pin.sha256)
			require(sha256(bytes) === pin.sha256, `${name} does not match its pin ${pin.sha256}`);
		if (pin.integrity) {
			const [algo, digest] = pin.integrity.split("-", 2);
			require(algo === "sha512", `unsupported integrity ${pin.integrity}`);
			const got = createHash("sha512").update(bytes).digest("base64");
			require(got === digest, `${name} does not match its integrity ${pin.integrity}`);
		}
		if (pin.size !== undefined)
			require(bytes.byteLength === pin.size, `${name} has the wrong size`);
		return bytes;
	}

	close() {
		for (const store of this.stores.values()) store.close();
	}
}

// ---------------------------------------------------------------------------
// Rules

type Quote = { origin: string; path: string; quote: string };

type HeaderRule = {
	origin: string;
	/** Directory prefixes whose files' headers are included. */
	roots?: string[];
	/** Single files whose headers are included. */
	paths?: string[];
	/** Prefixes below `roots` that are left out. */
	skip?: string[];
	/** Why: a notice of the same origin pointing to the headers, quoted... */
	pointer?: Quote;
	/** ...or the reason the header is the only licence statement. */
	only?: string;
};

export type Rules = {
	schema: 1;
	output: string;
	statement: string;
	bun: {
		repo: string;
		url: string;
		tree: string;
		runtimeRoots: string[];
		/** Prefix -> reason; the longest matching prefix wins, "" is the default. */
		excludedRoots: Record<string, string>;
	};
	deps: {
		dir: string;
		/** `enabled:` expression -> "include" or "exclude: <reason>". */
		enabled: Record<string, string>;
		/** Recipe files that are not github-archive dependencies, with what they are. */
		notArchive: Record<string, string>;
		/** dep name -> role. */
		roles: Record<string, string>;
		/** "<dep>:<path>" -> why that submodule is not part of the runtime. */
		submodules: Record<string, string>;
	};
	webkit: {
		repo: string;
		url: string;
		pinFile: string;
		runtimeRoots: string[];
		/** Prefix below the runtime roots -> quoted reason it is left out. */
		skip: Record<string, Quote & { reason: string }>;
		otherReason: string;
	};
	icu: { pinFile: string; url: string };
	crates: { lock: string; url: string; devOnlyReason: string };
	npm: { lock: string; url: string };
	rust: {
		toolchain: string;
		dist: string;
		rustc: string;
		repo: string;
		url: string;
		std: string;
		srcRoot: string;
		reuse: string;
		/** The repository notice that points to REUSE.toml. */
		reuseQuote: Quote;
	};
	llvm: {
		repo: string;
		url: string;
		tag: string;
		tagObject: string;
		commit: string;
		paths: string[];
		cited: Quote;
	};
	gcc: {
		pinFile: string;
		asset: string;
		arch: string;
		runtimeDeb: string;
		flags: Quote;
		otherReason: string;
	};
	licenceExclusion: string;
	testReason: string;
	quotes: Quote[];
	headers: HeaderRule[];
	buildOnly: BuildOnly[];
	gaps: Gap[];
};

// ---------------------------------------------------------------------------
// Builder

class Builder {
	origins = new Map<string, Origin>();
	texts = new Map<string, NoticeText>();
	excluded = new Map<string, Excluded>();
	files = new Map<string, Uint8Array>();
	gaps: Gap[] = [];

	origin(origin: Origin): Origin {
		require(!this.origins.has(origin.id), `origin ${origin.id} defined twice`);
		this.origins.set(origin.id, origin);
		return origin;
	}

	notice(
		origin: string,
		path: string,
		bytes: Uint8Array,
		section: SectionId,
		extra: Partial<NoticeText> = {},
	) {
		const text: NoticeText = {
			origin,
			path,
			kind: "notice",
			section,
			sha256: sha256(bytes),
			size: bytes.byteLength,
			...extra,
		};
		this.put(text, bytes);
	}

	header(
		origin: string,
		path: string,
		file: Uint8Array,
		section: SectionId,
		because: string,
		gitBlob?: string,
	) {
		const prefix = headerExcerpt(file);
		if (!prefix) return false;
		this.put(
			{
				origin,
				path,
				kind: "header",
				section,
				sha256: sha256(prefix),
				size: prefix.byteLength,
				...(gitBlob ? { gitBlob } : {}),
				fileSha256: sha256(file),
				fileSize: file.byteLength,
				because,
			},
			prefix,
		);
		return true;
	}

	private put(text: NoticeText, bytes: Uint8Array) {
		const key = `${text.origin}\0${text.path}`;
		require(!this.texts.has(key), `${text.origin}:${text.path} added twice`);
		require(!this.excluded.has(key), `${text.origin}:${text.path} is already excluded`);
		this.texts.set(key, text);
		const file = textFile(text);
		const known = this.files.get(file);
		require(!known || sha256(known) === text.sha256, `text store collision at ${file}`);
		this.files.set(file, bytes);
	}

	exclude(origin: string, path: string, reason: string) {
		const key = `${origin}\0${path}`;
		require(!this.texts.has(key), `${origin}:${path} is already packaged`);
		if (!this.excluded.has(key)) this.excluded.set(key, { origin, path, reason });
	}

	has(origin: string, path: string) {
		return this.texts.get(`${origin}\0${path}`);
	}
}

function decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

async function blobAt(
	store: GitStore,
	entries: Map<string, TreeEntry>,
	path: string,
): Promise<Uint8Array> {
	const entry = entries.get(path);
	require(entry, `${path} not found in ${store.dir}`);
	return store.blob(entry.oid, path);
}

function pinFrom(
	origin: string,
	path: string,
	entries: Map<string, TreeEntry>,
	content: string,
	text: string,
): Pin {
	require(content.includes(text), `${origin}:${path} no longer contains ${JSON.stringify(text)}`);
	const entry = entries.get(path);
	require(entry, `${origin}:${path} missing`);
	return { origin, path, gitBlob: entry.oid, text };
}

function longestPrefix(map: Record<string, string>, path: string): string {
	let best = "";
	for (const prefix of Object.keys(map))
		if (path.startsWith(prefix) && prefix.length >= best.length) best = prefix;
	const reason = map[best];
	require(reason, `no exclusion reason for ${path}`);
	return reason;
}

type Repo = { store: GitStore; entries: Map<string, TreeEntry>; commit: string; tree: string };

async function openRepo(
	cache: InputCache,
	repo: string,
	oid: string,
	enter?: (dir: string) => boolean,
): Promise<Repo> {
	const store = cache.git(repo);
	const { commit, tree } = await store.commit(oid);
	const list = await store.walk(tree, enter);
	return { store, entries: new Map(list.map((entry) => [entry.path, entry])), commit, tree };
}

/** Named notices of a git source: packaged when `include` says so, else excluded with its reason. */
async function gitNotices(
	b: Builder,
	id: string,
	repo: Repo,
	section: SectionId,
	classify: (path: string) => true | string,
) {
	for (const [path, entry] of [...repo.entries].sort(([a], [z]) => (a < z ? -1 : 1))) {
		if (!isNamedNotice(path)) continue;
		if (entry.mode === "160000" || entry.mode === "120000") {
			b.exclude(id, path, entry.mode === "120000" ? "a symbolic link, not a file" : "a submodule");
			continue;
		}
		const verdict = classify(path);
		if (verdict !== true) {
			b.exclude(id, path, verdict);
			continue;
		}
		const bytes = await repo.store.blob(entry.oid, `${id}:${path}`);
		b.notice(id, path, bytes, section, { gitBlob: entry.oid });
	}
}

function archiveNotices(
	b: Builder,
	id: string,
	files: Map<string, Uint8Array>,
	section: SectionId,
	classify: (path: string) => true | string,
): number {
	let packaged = 0;
	for (const [path, bytes] of [...files].sort(([a], [z]) => (a < z ? -1 : 1))) {
		if (!isNamedNotice(path)) continue;
		const verdict = classify(path);
		if (verdict === true) {
			b.notice(id, path, bytes, section);
			packaged++;
		} else b.exclude(id, path, verdict);
	}
	return packaged;
}

async function checkQuote(b: Builder, repos: Map<string, Repo>, quote: Quote) {
	const text = b.has(quote.origin, quote.path);
	let content: string | undefined;
	if (text) content = decode(b.files.get(textFile(text)) as Uint8Array);
	else {
		const repo = repos.get(quote.origin);
		require(repo, `quote source ${quote.origin}:${quote.path} is neither packaged nor a git origin`);
		content = decode(await blobAt(repo.store, repo.entries, quote.path));
	}
	require(normalise(content).includes(
		normalise(quote.quote),
	), `${quote.origin}:${quote.path} no longer says ${JSON.stringify(quote.quote)}`);
}

// ---------------------------------------------------------------------------
// The inventory

export type RefreshResult = {
	inventory: Inventory;
	files: Map<string, Uint8Array>;
	missing: string[];
};

type Policy = {
	firstParty: { licenceFiles: string[] };
	runtime: { name: string; version: string; revision: string; sha256: string; file: string };
};

export async function refresh(repoRoot: string, cacheDir: string): Promise<RefreshResult> {
	const rules = JSON.parse(
		readFileSync(join(repoRoot, "scripts/build/bun-runtime-notices.rules.json"), "utf8"),
	) as Rules;
	const policy = JSON.parse(
		readFileSync(join(repoRoot, "scripts/build/third-party-notices.json"), "utf8"),
	) as Policy;
	require(rules.schema === 1, "unsupported rules schema");
	const cache = new InputCache(cacheDir);
	const b = new Builder();
	const repos = new Map<string, Repo>();
	const testReason = rules.testReason;
	const sourceFiles = new Map<string, Map<string, Uint8Array>>();
	try {
		// Bun itself, at the revision the package pins.
		const bun = await openRepo(cache, rules.bun.repo, policy.runtime.revision);
		require(bun.commit === policy.runtime.revision, "the Bun pin must be a commit");
		require(bun.tree ===
			rules.bun.tree, `Bun ${bun.commit} has tree ${bun.tree}, the rules expect ${rules.bun.tree}`);
		repos.set("bun", bun);
		const bunFile = async (path: string) => decode(await blobAt(bun.store, bun.entries, path));
		const licence = await blobAt(bun.store, bun.entries, "LICENSE.md");
		require(sha256(licence) ===
			policy.runtime.sha256, "Bun's LICENSE.md differs from the pinned runtime licence");
		require(sha256(readFileSync(join(repoRoot, policy.runtime.file))) ===
			policy.runtime.sha256, `${policy.runtime.file} differs from the policy's sha256`);
		b.origin({
			id: "bun",
			kind: "git",
			url: rules.bun.url,
			commit: bun.commit,
			tree: bun.tree,
			role: `Bun ${policy.runtime.version}: its own sources compiled into the runtime`,
			pins: [],
		});
		await gitNotices(b, "bun", bun, "linked", (path) => {
			if (path === "LICENSE.md") return rules.licenceExclusion;
			const root = rules.bun.runtimeRoots.some((prefix) => path.startsWith(prefix));
			if (!root) return longestPrefix(rules.bun.excludedRoots, path);
			return isTestish(path) ? testReason : true;
		});

		// Vendored libraries, from Bun's recipes.
		const depNames: string[] = [];
		const depCommits = new Map<string, string>();
		const recipes = [...bun.entries.keys()].filter(
			(path) => path.startsWith(rules.deps.dir) && !path.slice(rules.deps.dir.length).includes("/"),
		);
		for (const path of recipes.sort()) {
			const file = path.slice(rules.deps.dir.length);
			if (rules.deps.notArchive[file]) continue;
			const name = file.replace(/\.ts$/, "");
			const source = await bunFile(path);
			require(source.includes('kind: "github-archive"'), `unreviewed dependency recipe ${path}`);
			const repo = /repo: "([\w.-]+\/[\w.-]+)"/.exec(source)?.[1];
			const constName = /commit: ([A-Z0-9_]+),/.exec(source)?.[1];
			const commitLine = constName
				? new RegExp(`const ${constName} = "([0-9a-f]{40})";`).exec(source)
				: null;
			require(repo && commitLine?.[1], `cannot read the pin of ${path}`);
			const enabled = /enabled: (cfg => [^,\n]+),/.exec(source)?.[1];
			const verdict = enabled ? rules.deps.enabled[enabled] : "include";
			require(verdict, `unreviewed build condition in ${path}: ${enabled}`);
			const role = rules.deps.roles[name];
			require(role, `no role for dependency ${name}`);
			const repoState = await openRepo(cache, repo, commitLine[1]);
			const id = `dep/${name}`;
			repos.set(id, repoState);
			depNames.push(name);
			depCommits.set(commitLine[1], id);
			b.origin({
				id,
				kind: "git",
				url: `https://github.com/${repo}`,
				commit: commitLine[1],
				tree: repoState.tree,
				...(repoState.commit !== commitLine[1] ? { peeled: repoState.commit } : {}),
				role,
				pins: [pinFrom("bun", path, bun.entries, source, commitLine[0])],
			} as Origin);
			const excluded = verdict === "include" ? null : verdict.replace(/^exclude: /, "");
			await gitNotices(
				b,
				id,
				repoState,
				"linked",
				(p) => excluded ?? (isTestish(p) ? testReason : true),
			);
		}
		// Submodules of included dependencies must be other pinned dependencies,
		// or be named in the rules with the reason they are not part of the build.
		for (const name of depNames) {
			const repo = repos.get(`dep/${name}`) as Repo;
			for (const entry of repo.entries.values()) {
				if (entry.mode !== "160000" || isTestish(entry.path)) continue;
				const ignored = rules.deps.submodules[`${name}:${entry.path}`];
				if (ignored) {
					b.exclude(`dep/${name}`, entry.path, `a submodule at ${entry.oid}: ${ignored}`);
					continue;
				}
				if (!depCommits.has(entry.oid)) {
					b.gaps.push({
						id: `submodule-${name}-${entry.path.replace(/[^\w.-]+/g, "-")}`,
						status: "open",
						text: `dep/${name} has a submodule ${entry.path} at ${entry.oid} that is not another pinned dependency; its notices are not included.`,
					});
				}
			}
		}

		// WebKit (JavaScriptCore, WTF, bmalloc) and the ICU it pins.
		const webkitSource = await bunFile(rules.webkit.pinFile);
		const webkitLine = /export const WEBKIT_VERSION = "([0-9a-f]{40})";/.exec(webkitSource);
		require(webkitLine?.[1], "cannot read the WebKit pin");
		const webkit = await openRepo(cache, rules.webkit.repo, webkitLine[1]);
		repos.set("webkit", webkit);
		b.origin({
			id: "webkit",
			kind: "git",
			url: rules.webkit.url,
			commit: webkit.commit,
			tree: webkit.tree,
			role: "WebKit sources of JavaScriptCore, WTF and bmalloc, which Bun links from its WebKit build",
			pins: [pinFrom("bun", rules.webkit.pinFile, bun.entries, webkitSource, webkitLine[0])],
		});
		for (const skip of Object.values(rules.webkit.skip)) await checkQuote(b, repos, skip);
		await gitNotices(b, "webkit", webkit, "linked", (path) => {
			if (!rules.webkit.runtimeRoots.some((root) => path.startsWith(root)))
				return rules.webkit.otherReason;
			const skip = Object.entries(rules.webkit.skip).find(([prefix]) => path.startsWith(prefix));
			if (skip) return skip[1].reason;
			return isTestish(path) ? testReason : true;
		});
		const icuSourceText = decode(await blobAt(webkit.store, webkit.entries, rules.icu.pinFile));
		const icuSource = JSON.parse(icuSourceText) as { version: string; sha256: string };
		const icuUrl = rules.icu.url.replaceAll("{version}", icuSource.version);
		b.origin({
			id: "icu",
			kind: "archive",
			url: icuUrl,
			sha256: icuSource.sha256,
			size: 0,
			role: `ICU ${icuSource.version}, which Bun's WebKit build links`,
			pins: [
				pinFrom(
					"webkit",
					rules.icu.pinFile,
					webkit.entries,
					icuSourceText,
					`"sha256": "${icuSource.sha256}"`,
				),
			],
		});
		const icuBytes = cache.file(icuUrl, { sha256: icuSource.sha256 });
		if (icuBytes) {
			(b.origins.get("icu") as Origin).size = icuBytes.byteLength;
			const icu = readTar(await decompress(icuBytes, icuUrl));
			archiveNotices(b, "icu", icu.files, "linked", (p) => (isTestish(p) ? testReason : true));
		}

		// libc++abi text for Bun's __cxa_thread_atexit fallback, at the tag Bun cites.
		const llvm = await openRepo(cache, rules.llvm.repo, rules.llvm.commit, () => false);
		const tagObject = await llvm.store.get(rules.llvm.tagObject);
		require(tagObject?.type ===
			"tag", `missing tag object ${rules.llvm.tagObject} for ${rules.llvm.tag}`);
		const tagText = decode(tagObject.body);
		require(tagText.startsWith(
			`object ${rules.llvm.commit}\ntype commit\ntag ${rules.llvm.tag}\n`,
		), `${rules.llvm.tag} does not point at ${rules.llvm.commit}`);
		const citedSource = await bunFile(rules.llvm.cited.path);
		b.origin({
			id: "llvm",
			kind: "git",
			url: rules.llvm.url,
			commit: llvm.commit,
			tree: llvm.tree,
			tag: rules.llvm.tag,
			role: "LLVM libc++abi, whose __cxa_thread_atexit fallback Bun copies",
			pins: [
				pinFrom("bun", rules.llvm.cited.path, bun.entries, citedSource, rules.llvm.cited.quote),
			],
		});
		for (const path of rules.llvm.paths) {
			const oid = await lookupPath(llvm.store, llvm.tree, path);
			const bytes = await llvm.store.blob(oid, path);
			b.notice("llvm", path, bytes, "linked", { gitBlob: oid });
		}

		// Rust: the toolchain Bun pins, its standard library and its sources.
		const toolchainText = await bunFile(rules.rust.toolchain);
		const channel = (Bun.TOML.parse(toolchainText) as { toolchain: { channel: string } }).toolchain
			.channel;
		const date = /^nightly-(\d{4}-\d{2}-\d{2})$/.exec(channel)?.[1];
		require(date, `unsupported Rust channel ${channel}`);
		const dist = rules.rust.dist.replaceAll("{date}", date);
		const channelPin = pinFrom(
			"bun",
			rules.rust.toolchain,
			bun.entries,
			toolchainText,
			`channel = "${channel}"`,
		);
		const sumBytes = cache.file(`${dist}channel-rust-nightly.toml.sha256`, {});
		const manifestBytes = sumBytes
			? cache.file(`${dist}channel-rust-nightly.toml`, {
					sha256: decode(sumBytes).split(/\s/)[0] ?? "",
				})
			: null;
		if (manifestBytes) {
			const manifestText = decode(manifestBytes);
			const manifest = Bun.TOML.parse(manifestText) as {
				pkg: Record<
					string,
					{ git_commit_hash?: string; target: Record<string, { xz_url: string; xz_hash: string }> }
				>;
			};
			require(manifest.pkg.rustc?.git_commit_hash ===
				rules.rust
					.rustc, `the Rust ${channel} manifest names rustc ${manifest.pkg.rustc?.git_commit_hash}, the executables ${rules.rust.rustc}`);
			const via = (text: string) => {
				require(manifestText.includes(text), `the Rust manifest does not contain ${text}`);
				return { url: `${dist}channel-rust-nightly.toml`, sha256: sha256(manifestBytes), text };
			};
			const std = manifest.pkg["rust-std"]?.target[rules.rust.std];
			const src = manifest.pkg["rust-src"]?.target["*"];
			require(std && src, "the Rust manifest lacks rust-std or rust-src");
			for (const [id, component, role] of [
				["rust-std", std, `the Rust standard library for ${rules.rust.std}, as linked`],
				["rust-src", src, "sources of the Rust standard library"],
			] as const) {
				b.origin({
					id,
					kind: "archive",
					url: component.xz_url,
					sha256: component.xz_hash,
					size: 0,
					role: `${role} (${channel})`,
					pins: [channelPin],
					via: via(`xz_hash = "${component.xz_hash}"`),
				} as Origin);
				const bytes = cache.file(component.xz_url, { sha256: component.xz_hash });
				if (!bytes) continue;
				(b.origins.get(id) as Origin).size = bytes.byteLength;
				const files = readTar(await decompress(bytes, component.xz_url)).files;
				if (id === "rust-std") {
					archiveNotices(b, id, files, "rust-std", () => true);
				} else {
					archiveNotices(b, id, files, "rust-std", (p) =>
						!p.startsWith(rules.rust.srcRoot)
							? "outside the standard library sources"
							: isTestish(p)
								? testReason
								: true,
					);
					sourceFiles.set(id, files);
				}
			}
			// REUSE.toml and the licence texts it names for library/.
			const rust = await openRepo(
				cache,
				rules.rust.repo,
				rules.rust.rustc,
				(dir) => dir === "LICENSES",
			);
			repos.set("rust", rust);
			b.origin({
				id: "rust",
				kind: "git",
				url: rules.rust.url,
				commit: rust.commit,
				tree: rust.tree,
				role: "the Rust repository's REUSE annotations and the licence texts they name for the standard library",
				pins: [channelPin],
				via: via(`git_commit_hash = "${rules.rust.rustc}"`),
			} as Origin);
			// Top-level notices of the repository: the rust-std component ships the same files.
			for (const [path, entry] of [...rust.entries].sort(([a], [z]) => (a < z ? -1 : 1))) {
				if (path.includes("/") || !isNamedNotice(path)) continue;
				const shipped = [...b.texts.values()].find(
					(text) =>
						text.origin === "rust-std" &&
						text.path.endsWith(`/${path}`) &&
						text.gitBlob === undefined,
				);
				const same = shipped && sha256(await rust.store.blob(entry.oid, path)) === shipped.sha256;
				b.exclude(
					"rust",
					path,
					same
						? "identical to the copy in the rust-std component, which is packaged"
						: "a top-level file of the Rust repository, outside the REUSE.toml and LICENSES/ scope read here",
				);
			}
			const reuseBytes = await blobAt(rust.store, rust.entries, rules.rust.reuse);
			await checkQuote(b, repos, rules.rust.reuseQuote);
			b.notice("rust", rules.rust.reuse, reuseBytes, "rust-std", {
				gitBlob: rust.entries.get(rules.rust.reuse)?.oid as string,
				because: `${rules.rust.reuseQuote.path} says: "${normalise(rules.rust.reuseQuote.quote)}"`,
			});
			const reuse = Bun.TOML.parse(decode(reuseBytes)) as {
				annotations: { path: string | string[]; "SPDX-License-Identifier": string }[];
			};
			const ids = new Set<string>();
			for (const annotation of reuse.annotations) {
				const paths = Array.isArray(annotation.path) ? annotation.path : [annotation.path];
				if (!paths.some((p) => p.startsWith("library/"))) continue;
				for (const token of annotation["SPDX-License-Identifier"].split(/[\s()]+/)) {
					if (token && !["AND", "OR", "WITH"].includes(token)) ids.add(token);
				}
			}
			for (const [path, entry] of [...rust.entries].sort(([a], [z]) => (a < z ? -1 : 1))) {
				if (!path.startsWith("LICENSES/")) continue;
				const id = path.slice("LICENSES/".length).replace(/\.txt$/, "");
				if (!ids.has(id)) {
					b.exclude(
						"rust",
						path,
						"named by REUSE.toml only for files outside library/ (compiler, tools, documentation)",
					);
					continue;
				}
				b.notice("rust", path, await rust.store.blob(entry.oid, path), "rust-std", {
					gitBlob: entry.oid,
				});
			}
		}

		// Rust crates Cargo.lock reaches from Bun's workspace, without dev-dependencies.
		const lockText = await bunFile(rules.crates.lock);
		const reachable = await reachableCrates(bunFile, lockText);
		const lock = Bun.TOML.parse(lockText) as {
			package: { name: string; version: string; source?: string; checksum?: string }[];
		};
		for (const pkg of lock.package) {
			if (!pkg.source?.startsWith("registry+")) continue;
			require(pkg.checksum, `no checksum for crate ${pkg.name}`);
			const id = `crate/${pkg.name}-${pkg.version}`;
			const url = rules.crates.url
				.replaceAll("{name}", pkg.name)
				.replaceAll("{version}", pkg.version);
			const runtime = reachable.has(`${pkg.name} ${pkg.version}`);
			b.origin({
				id,
				kind: "archive",
				url,
				sha256: pkg.checksum,
				size: 0,
				role: runtime
					? "Rust crate in Bun's Cargo.lock, reachable without dev-dependencies"
					: "Rust crate in Bun's Cargo.lock, reachable only through dev-dependencies",
				pins: [
					pinFrom("bun", rules.crates.lock, bun.entries, lockText, `checksum = "${pkg.checksum}"`),
				],
			});
			const bytes = cache.file(url, { sha256: pkg.checksum });
			if (!bytes) continue;
			(b.origins.get(id) as Origin).size = bytes.byteLength;
			const files = readTar(await decompress(bytes, url)).files;
			const packaged = archiveNotices(b, id, files, "crates", (p) =>
				!runtime ? rules.crates.devOnlyReason : isTestish(p) ? testReason : true,
			);
			if (runtime && packaged === 0) {
				const manifest = files.get(`${pkg.name}-${pkg.version}/Cargo.toml`);
				const declared = manifest
					? ((Bun.TOML.parse(decode(manifest)) as { package?: { license?: string } }).package
							?.license ?? "none")
					: "unknown";
				b.gaps.push(
					readmeLicence(
						b,
						id,
						files,
						`${pkg.name}-${pkg.version}/`,
						"crates",
						`its Cargo.toml declares "${declared}"`,
					),
				);
			}
		}

		// npm packages Bun embeds as Node.js polyfills.
		const npmLock = await bunFile(rules.npm.lock);
		const seen = new Set<string>();
		for (const match of npmLock.matchAll(
			/^\s+"[^"]+": \["((?:@[^/"]+\/)?[^@"]+)@([^"]+)", "[^"]*", \{.*\}, "(sha512-[^"]+)"\],?$/gm,
		)) {
			const [, name = "", version = "", integrity = ""] = match;
			if (seen.has(`${name}@${version}`)) continue;
			seen.add(`${name}@${version}`);
			const base = name.slice(name.lastIndexOf("/") + 1);
			const id = `npm/${name.replace("/", "+")}-${version}`;
			const url = rules.npm.url
				.replaceAll("{name}", name)
				.replaceAll("{base}", base)
				.replaceAll("{version}", version);
			b.origin({
				id,
				kind: "archive",
				url,
				integrity,
				sha256: "",
				size: 0,
				role: "npm package in Bun's node-fallbacks lockfile, embedded as a Node.js polyfill",
				pins: [pinFrom("bun", rules.npm.lock, bun.entries, npmLock, integrity)],
			});
			const bytes = cache.file(url, { integrity });
			if (!bytes) continue;
			Object.assign(b.origins.get(id) as Origin, { sha256: sha256(bytes), size: bytes.byteLength });
			const files = readTar(await decompress(bytes, url)).files;
			const packaged = archiveNotices(b, id, files, "polyfills", (p) =>
				isTestish(p) ? testReason : true,
			);
			if (packaged === 0) {
				const manifest = files.get("package/package.json");
				const declared = manifest
					? String((JSON.parse(decode(manifest)) as { license?: unknown }).license ?? "none")
					: "unknown";
				b.gaps.push(
					readmeLicence(
						b,
						id,
						files,
						"package/",
						"polyfills",
						`its package.json declares "${declared}"`,
					),
				);
			}
		}
		require(seen.size > 0, `no packages read from ${rules.npm.lock}`);

		// The static C++ runtime: the GCC archive Bun's recipe pins, and its gcc-13-base copyright.
		const specText = await bunFile(rules.gcc.pinFile);
		const gccBlock = /gccDebs: \{\s*url: "([^"]+)",[\s\S]*?\}/.exec(specText);
		const gccSha = gccBlock
			? new RegExp(`${rules.gcc.arch}: "([0-9a-f]{64})"`).exec(gccBlock[0])
			: null;
		require(gccBlock?.[1] && gccSha?.[1], "cannot read the GCC archive pin");
		require(specText.includes(
			"url: `${gccDebs.url}/gcc-13-focal-${deb}.tar.gz`",
		), "the GCC archive URL template changed");
		await checkQuote(b, repos, rules.gcc.flags);
		const gccUrl = `${gccBlock[1]}/${rules.gcc.asset}`;
		b.origin({
			id: "gcc-archive",
			kind: "archive",
			url: gccUrl,
			sha256: gccSha[1],
			size: 0,
			role: "GCC 13 packages whose static libstdc++ and libgcc Bun links (-static-libstdc++ -static-libgcc)",
			pins: [pinFrom("bun", rules.gcc.pinFile, bun.entries, specText, gccSha[0])],
		});
		const gccBytes = cache.file(gccUrl, { sha256: gccSha[1] });
		if (gccBytes) {
			(b.origins.get("gcc-archive") as Origin).size = gccBytes.byteLength;
			const outer = readTar(await decompress(gccBytes, gccUrl));
			require(outer.links.length === 0, "the GCC archive contains links");
			let found = false;
			for (const [member, deb] of [...outer.files].sort(([a], [z]) => (a < z ? -1 : 1))) {
				require(member.endsWith(".deb"), `unexpected member ${member} in the GCC archive`);
				const parts = readAr(deb);
				const dataName = [...parts.keys()].find((name) => name.startsWith("data.tar"));
				require(dataName, `${member} has no data archive`);
				const data = readTar(await decompress(parts.get(dataName) as Uint8Array, dataName)).files;
				const runtime = member === rules.gcc.runtimeDeb;
				const id = runtime ? "gcc-13-base" : `gcc-archive/${member.replace(/\.deb$/, "")}`;
				if (runtime) {
					found = true;
					b.origin({
						id,
						kind: "deb",
						url: gccUrl,
						sha256: sha256(deb),
						size: deb.byteLength,
						within: { origin: "gcc-archive", member },
						role: "the gcc-13 source package's copyright file, which covers libstdc++ and libgcc",
						pins: [],
					});
				}
				for (const [path, bytes] of [...data].sort(([a], [z]) => (a < z ? -1 : 1))) {
					if (!isNamedNotice(path)) continue;
					if (runtime) b.notice(id, path, bytes, "cxx-runtime");
					else b.exclude("gcc-archive", `${member}/${path}`, rules.gcc.otherReason);
				}
			}
			require(found, `${rules.gcc.runtimeDeb} not found in the GCC archive`);
		}

		// Per-file headers, where a notice points to them or nothing else carries the licence.
		for (const quote of rules.quotes) await checkQuote(b, repos, quote);
		if (cache.missing.length === 0) {
			for (const rule of rules.headers) await headerRule(b, repos, sourceFiles, rule);
		}

		const inventory: Inventory = {
			schema: 1,
			runtime: {
				name: policy.runtime.name,
				version: policy.runtime.version,
				revision: policy.runtime.revision,
				tree: bun.tree,
				licenceSha256: policy.runtime.sha256,
			},
			statement: rules.statement,
			origins: [...b.origins.values()].sort((a, z) => (a.id < z.id ? -1 : 1)),
			texts: [...b.texts.values()].sort(byOriginPath),
			excluded: [...b.excluded.values()].sort(byOriginPath),
			buildOnly: rules.buildOnly,
			gaps: [...rules.gaps, ...b.gaps.sort((a, z) => (a.id < z.id ? -1 : 1))],
		};
		const files = new Map<string, Uint8Array>([
			["inventory.json", new TextEncoder().encode(serializeInventory(inventory))],
		]);
		for (const [path, bytes] of [...b.files].sort(([a], [z]) => (a < z ? -1 : 1)))
			files.set(path, bytes);
		return { inventory, files, missing: [...cache.missing] };
	} finally {
		cache.close();
	}
}

/**
 * A package without a licence file whose README carries a complete grant (a
 * copyright line and the permission text) gets that README, whole; the gap is
 * then resolved by it. Otherwise the gap stays open.
 */
function readmeLicence(
	b: Builder,
	id: string,
	files: Map<string, Uint8Array>,
	top: string,
	section: SectionId,
	declared: string,
): Gap {
	const readme = [...files.keys()]
		.filter(
			(path) =>
				path.startsWith(top) && /^readme(?:\.(?:md|markdown|txt))?$/i.test(path.slice(top.length)),
		)
		.sort()[0];
	const bytes = readme ? files.get(readme) : undefined;
	const text = bytes ? decode(bytes) : "";
	if (readme && bytes && /copyright/i.test(text) && /permission is hereby granted/i.test(text)) {
		b.notice(id, readme, bytes, section, {
			because:
				"the package has no licence file, and its README carries its licence text and copyright line",
		});
		return {
			id: `no-notice-${id}`,
			status: "resolved",
			text: `${id} publishes no licence file; ${declared}. Its README includes the licence text with its copyright line.`,
			evidence: [{ kind: "packaged-text", origin: id, path: readme, sha256: sha256(bytes) }],
		};
	}
	return {
		id: `no-notice-${id}`,
		status: "open",
		text: `${id} publishes no licence file; ${declared}, which is not a licence text${readme ? ", and its README does not carry one" : ""}.`,
	};
}

/** JSON with one array entry per line, so a change shows up as a line in a diff. */
export function serializeInventory(inventory: Inventory): string {
	const fields = Object.entries(inventory).map(([key, value]) => {
		if (Array.isArray(value)) {
			const items = value.map((item) => `\t\t${JSON.stringify(item)}`).join(",\n");
			return `\t${JSON.stringify(key)}: [\n${items}\n\t]`;
		}
		return `\t${JSON.stringify(key)}: ${JSON.stringify(value)}`;
	});
	return `{\n${fields.join(",\n")}\n}\n`;
}

function byOriginPath(a: { origin: string; path: string }, z: { origin: string; path: string }) {
	return a.origin === z.origin ? (a.path < z.path ? -1 : 1) : a.origin < z.origin ? -1 : 1;
}

async function lookupPath(store: GitStore, tree: string, path: string): Promise<string> {
	let oid = tree;
	for (const part of path.split("/")) {
		const object = await store.get(oid);
		require(object?.type === "tree", `missing tree while looking up ${path}`);
		let found: string | undefined;
		const body = object.body;
		let i = 0;
		while (i < body.byteLength) {
			const space = body.indexOf(0x20, i);
			const nul = body.indexOf(0, space);
			if (decode(body.subarray(space + 1, nul)) === part)
				found = Buffer.from(body.subarray(nul + 1, nul + 21)).toString("hex");
			i = nul + 21;
		}
		require(found, `${path} not found`);
		oid = found;
	}
	return oid;
}

async function headerRule(
	b: Builder,
	repos: Map<string, Repo>,
	archives: Map<string, Map<string, Uint8Array>>,
	rule: HeaderRule,
) {
	let because: string;
	if (rule.pointer) {
		require(rule.pointer.origin ===
			rule.origin, "a header pointer must be a notice of the same origin");
		require(b.has(
			rule.pointer.origin,
			rule.pointer.path,
		), `${rule.pointer.origin}:${rule.pointer.path} is not packaged`);
		await checkQuote(b, repos, rule.pointer);
		because = `${rule.pointer.path} says: "${normalise(rule.pointer.quote)}"`;
	} else {
		require(rule.only, `header rule for ${rule.origin} needs a pointer or a reason`);
		because = rule.only;
	}
	const roots = rule.roots ?? [];
	const skip = rule.skip ?? [];
	const under = (path: string) => roots.find((root) => path.startsWith(root));
	const wanted = (path: string) => {
		if (isNamedNotice(path)) return false;
		if (rule.paths?.includes(path)) return true;
		const root = under(path);
		return (
			root !== undefined &&
			!skip.some((prefix) => path.startsWith(prefix)) &&
			!isTestish(path.slice(root.length))
		);
	};
	// A rule that says the headers are the only licence statement must stay true:
	// a notice appearing in its scope makes it stale.
	const scope = [
		...roots,
		...(rule.paths ?? []).map((path) => path.slice(0, path.lastIndexOf("/") + 1)),
	];
	const repo = repos.get(rule.origin);
	const files: [string, () => Promise<Uint8Array>, string | undefined][] = repo
		? [...repo.entries]
				.filter(([, entry]) => entry.mode === "100644" || entry.mode === "100755")
				.map(([path, entry]) => [
					path,
					() => repo.store.blob(entry.oid, `${rule.origin}:${path}`),
					entry.oid,
				])
		: [...(archives.get(rule.origin) ?? new Map<string, Uint8Array>())].map(([path, bytes]) => [
				path,
				async () => bytes,
				undefined,
			]);
	require(files.length > 0, `header rule origin ${rule.origin} is not loaded`);
	if (rule.only) {
		for (const [path] of files) {
			const root = scope.find((prefix) => path.startsWith(prefix));
			if (
				root === undefined ||
				!isNamedNotice(path) ||
				skip.some((prefix) => path.startsWith(prefix))
			)
				continue;
			if (isTestish(path.slice(root.length))) continue;
			throw new Error(
				`${rule.origin}:${path} is a notice; the header rule's reason no longer holds`,
			);
		}
	}
	let count = 0;
	for (const [path, read, oid] of files.sort(([a], [z]) => (a < z ? -1 : 1))) {
		if (!wanted(path)) continue;
		if (b.header(rule.origin, path, await read(), "headers", because, oid)) count++;
	}
	require(count > 0, `header rule for ${rule.origin} matched no file with a licence header`);
}

/**
 * Crates Cargo.lock reaches from the workspace members, leaving out what only the
 * members' dev-dependencies pull in. Features and targets are not resolved, so
 * this is a superset of what any one build links.
 */
async function reachableCrates(
	bunFile: (path: string) => Promise<string>,
	lockText: string,
): Promise<Set<string>> {
	const root = Bun.TOML.parse(await bunFile("Cargo.toml")) as {
		workspace: { members: string[]; dependencies?: Record<string, unknown> };
	};
	const lock = Bun.TOML.parse(lockText) as {
		package: { name: string; version: string; source?: string; dependencies?: string[] }[];
	};
	const byName = new Map<string, typeof lock.package>();
	for (const pkg of lock.package) byName.set(pkg.name, [...(byName.get(pkg.name) ?? []), pkg]);
	const resolveDep = (dep: string) => {
		const [name = "", version] = dep.split(" ");
		const candidates = (byName.get(name) ?? []).filter(
			(pkg) => !version || pkg.version === version,
		);
		require(candidates.length === 1, `Cargo.lock dependency ${dep} is ambiguous or missing`);
		return candidates[0] as (typeof lock.package)[number];
	};
	const realName = (key: string, value: unknown): string => {
		if (value && typeof value === "object") {
			const spec = value as { package?: string; workspace?: boolean };
			if (spec.package) return spec.package;
			if (spec.workspace) {
				const inherited = root.workspace.dependencies?.[key] as { package?: string } | undefined;
				if (inherited && typeof inherited === "object" && inherited.package)
					return inherited.package;
			}
		}
		return key;
	};
	const seen = new Set<string>();
	const stack: (typeof lock.package)[number][] = [];
	for (const member of root.workspace.members) {
		const manifest = Bun.TOML.parse(await bunFile(`${member}/Cargo.toml`)) as Record<
			string,
			unknown
		> & {
			package: { name: string };
			target?: Record<string, Record<string, Record<string, unknown>>>;
		};
		const kept = new Set<string>();
		const dev = new Set<string>();
		const tables: [Record<string, unknown> | undefined, boolean][] = [
			[manifest.dependencies as Record<string, unknown>, false],
			[manifest["build-dependencies"] as Record<string, unknown>, false],
			[manifest["dev-dependencies"] as Record<string, unknown>, true],
		];
		for (const target of Object.values(manifest.target ?? {})) {
			tables.push(
				[target.dependencies, false],
				[target["build-dependencies"], false],
				[target["dev-dependencies"], true],
			);
		}
		for (const [table, isDev] of tables) {
			for (const [key, value] of Object.entries(table ?? {}))
				(isDev ? dev : kept).add(realName(key, value));
		}
		const pkg = (byName.get(manifest.package.name) ?? []).find((p) => !p.source);
		require(pkg, `workspace member ${member} is not in Cargo.lock`);
		seen.add(`${pkg.name} ${pkg.version}`);
		for (const dep of pkg.dependencies ?? []) {
			const name = dep.split(" ")[0] ?? "";
			if (kept.has(name) || !dev.has(name)) stack.push(resolveDep(dep));
		}
	}
	while (stack.length > 0) {
		const pkg = stack.pop() as (typeof lock.package)[number];
		const key = `${pkg.name} ${pkg.version}`;
		if (seen.has(key)) continue;
		seen.add(key);
		for (const dep of pkg.dependencies ?? []) stack.push(resolveDep(dep));
	}
	return seen;
}

// ---------------------------------------------------------------------------
// Output and comparison

function listTree(root: string, dir = root): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return listTree(root, path);
		return [path.slice(root.length + 1)];
	});
}

export function writeOutput(out: string, files: Map<string, Uint8Array>) {
	require(!existsSync(out), `output must not exist: ${out}`);
	for (const [path, bytes] of files) {
		const full = join(out, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, bytes);
	}
}

/** Differences between a regenerated output and the committed directory. */
export function compareOutput(committed: string, files: Map<string, Uint8Array>): string[] {
	const problems: string[] = [];
	const present = new Set(listTree(committed));
	for (const [path, bytes] of files) {
		if (!present.has(path)) problems.push(`missing from the repository: ${path}`);
		else if (sha256(readFileSync(join(committed, path))) !== sha256(bytes))
			problems.push(`differs: ${path}`);
		present.delete(path);
	}
	for (const path of present) problems.push(`not produced by the inputs: ${path}`);
	return problems.sort();
}

function arg(argv: string[], name: string): string {
	const at = argv.indexOf(name);
	const value = at >= 0 ? argv[at + 1] : undefined;
	require(value, `${name} is required`);
	return value;
}

if (import.meta.main) {
	try {
		const [command, ...rest] = process.argv.slice(2);
		require(command === "refresh" ||
			command === "check", "usage: refresh|check --repo-root <dir> --cache <dir> [--out <dir>]");
		const repoRoot = resolve(arg(rest, "--repo-root"));
		const result = await refresh(repoRoot, resolve(arg(rest, "--cache")));
		if (result.missing.length > 0) {
			throw new Error(`pinned inputs missing from the cache:\n  ${result.missing.join("\n  ")}`);
		}
		const rules = JSON.parse(
			readFileSync(join(repoRoot, "scripts/build/bun-runtime-notices.rules.json"), "utf8"),
		) as Rules;
		if (command === "refresh") {
			writeOutput(resolve(arg(rest, "--out")), result.files);
		} else {
			const problems = compareOutput(join(repoRoot, rules.output), result.files);
			if (problems.length > 0)
				throw new Error(`committed notices differ from the inputs:\n  ${problems.join("\n  ")}`);
		}
		const inventorySha = sha256(result.files.get("inventory.json") as Uint8Array);
		console.log(
			`bun runtime notices: ${result.inventory.texts.length} texts, ${result.inventory.excluded.length} excluded, ` +
				`${result.inventory.gaps.length} gaps; inventory sha256 ${inventorySha}`,
		);
	} catch (error) {
		console.error(`bun runtime notices: ${(error as Error).message}`);
		process.exit(1);
	}
}

export { gitBlobId };
