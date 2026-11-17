#!/usr/bin/env bun
// Licence and third-party notice files for the ceralive-device package.
//
// The package ships compiled Bun executables and a bundled web app. Neither
// carries the licence texts of what was bundled into it, so this generator
// collects them at build time from the exact inputs:
//
//   - npm packages: every source path under node_modules/ that the bundler put
//     into an artifact, read from source maps (Bun.build of the backend entry
//     points; the relocated, non-packaged maps of the web app). The licence,
//     copying and notice files of each package are copied verbatim.
//   - Bun: compiled executables embed the Bun runtime. Its LICENSE.md is pinned
//     to the Bun release that compiles the package and checked by sha256.
//   - CeraUI itself: the GPL-3.0 text of apps/backend and apps/frontend, plus
//     the brand-asset notice.
//
// Nothing is guessed. A bundled package without a licence file fails the build
// unless the policy file names it with the reason, and those packages are
// listed as lacking text in the output. A missing pinned file, a hash mismatch
// or a Bun version other than the pinned one also fails.

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

export type Policy = {
	firstParty: { licenceFiles: string[]; brandNotice: string; source: string };
	/** Entry point -> installed executable it is compiled into. */
	backendEntrypoints: Record<string, string>;
	webSourcemapDir: string;
	web: {
		root: string;
		label: string;
		rules: WebRule[];
		mustBeAttributed: string;
	};
	runtime: {
		name: string;
		version: string;
		revision: string;
		source: string;
		file: string;
		sha256: string;
	};
	withoutLicenceText: Record<string, string>;
};

/** Attributes shipped web files that have no source map (generated or copied assets). */
export type WebRule = {
	files: string;
	resolveFrom: string[];
	packages?: string[];
	/** Only files containing this text are claimed by the rule. */
	marker?: string;
	/** Package names read from the file itself: a regex with one group, and a name with $1. */
	markerPackages?: { pattern: string; name: string };
};

export type BundledPackage = {
	name: string;
	version: string;
	declared: string;
	root: string;
	usedBy: string[];
	files: { name: string; sha256: string; text: string }[];
	missingReason?: string;
};

const LICENCE_FILE_RE = /(^|[-_.])(licen[cs]e|copying|notice)([-_.]|$)/i;

export function sha256(text: string | Uint8Array): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Package root of a resolved source path, or null when it is not in node_modules. */
export function packageRootOf(file: string): string | null {
	const marker = `${sep}node_modules${sep}`;
	const at = file.lastIndexOf(marker);
	if (at < 0) return null;
	const rest = file.slice(at + marker.length).split(sep);
	if (!rest[0] || rest[0].startsWith(".")) return null;
	const nameParts = rest[0].startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
	if (nameParts.length === 2 && !nameParts[1]) return null;
	return file.slice(0, at + marker.length) + nameParts.join(sep);
}

/** Resolved node_modules source files named by one source map. */
export function sourcesOfMap(mapPath: string): string[] {
	const map = JSON.parse(readFileSync(mapPath, "utf8")) as {
		sources?: string[];
		sourceRoot?: string;
	};
	const base = resolve(dirname(mapPath), map.sourceRoot ?? "");
	return (map.sources ?? [])
		.filter((source) => !source.includes("\0") && !/^[a-z]+:/i.test(source))
		.map((source) => resolve(base, source));
}

function listMaps(dir: string): string[] {
	const found: string[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".map")) found.push(path);
		}
	};
	walk(dir);
	return found.sort();
}

/** Bundle each backend entry point the way the package does and read its map. */
async function backendSources(
	repoRoot: string,
	entrypoints: Record<string, string>,
): Promise<Map<string, string[]>> {
	const out = mkdtempSync(join(tmpdir(), "ceralive-notices-"));
	const byArtifact = new Map<string, string[]>();
	try {
		for (const [entry, installed] of Object.entries(entrypoints)) {
			const outdir = join(out, basename(entry, ".ts"));
			const result = await Bun.build({
				entrypoints: [resolve(repoRoot, entry)],
				target: "bun",
				minify: true,
				sourcemap: "external",
				outdir,
				define: { "process.env.NODE_ENV": '"production"' },
			});
			if (!result.success) {
				throw new Error(`could not bundle ${entry}: ${result.logs.join("\n")}`);
			}
			const maps = listMaps(outdir);
			if (maps.length === 0) throw new Error(`no source map for ${entry}`);
			byArtifact.set(installed, maps.flatMap(sourcesOfMap));
		}
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
	return byArtifact;
}

function readPackage(root: string): { name: string; version: string; declared: string } {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		name?: string;
		version?: string;
		license?: unknown;
		licenses?: unknown;
	};
	const declared = manifest.license ?? manifest.licenses;
	return {
		name: manifest.name ?? basename(root),
		version: manifest.version ?? "unknown",
		declared:
			typeof declared === "string" ? declared : declared ? JSON.stringify(declared) : "none",
	};
}

function licenceFiles(root: string): BundledPackage["files"] {
	return readdirSync(root)
		.filter((name) => LICENCE_FILE_RE.test(name) && statSync(join(root, name)).isFile())
		.sort()
		.map((name) => {
			const text = readFileSync(join(root, name), "utf8");
			return { name, sha256: sha256(text), text };
		});
}

/** Node-style lookup of a package directory from a directory, following symlinks. */
export function findPackage(fromDir: string, name: string): string {
	let dir = resolve(fromDir);
	for (;;) {
		const candidate =
			basename(dir) === "node_modules" ? join(dir, name) : join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`cannot resolve ${name} from ${fromDir}`);
		dir = parent;
	}
}

function resolveChain(repoRoot: string, chain: string[], name: string): string {
	const [start = ".", ...hops] = chain;
	let dir = resolve(repoRoot, start);
	for (const hop of hops) dir = findPackage(dir, hop);
	return findPackage(dir, name);
}

function listFiles(root: string, dir = root): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.flatMap((entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) return listFiles(root, path);
			return entry.isFile() ? [path.slice(root.length + 1).split(sep).join("/")] : [];
		})
		.sort();
}

/** A chunk that only re-exports or imports other chunks carries no code of its own. */
export function isGlueChunk(text: string): boolean {
	const statement =
		/(?:import\s*(?:[\w$*{}\s,]+from\s*)?"[^"]+"|export\s*(?:\*|\{[^}]*\})\s*from\s*"[^"]+"|export\s+default\s+[\w$]+\(\))\s*;?/g;
	return text.length < 512 && text.replace(statement, "").trim() === "";
}

/**
 * Packages behind shipped web files that no source map covers. A file of the
 * must-be-attributed kinds (scripts and fonts) that has neither a map, nor a
 * claiming rule, nor is a glue chunk fails the build.
 */
export function webFilePackages(repoRoot: string, policy: Pick<Policy, "web" | "webSourcemapDir">): string[] {
	const root = resolve(repoRoot, policy.web.root);
	const mapRoot = resolve(repoRoot, policy.webSourcemapDir);
	const mustAttribute = new RegExp(policy.web.mustBeAttributed);
	const found = new Set<string>();
	const unattributed: string[] = [];
	for (const file of listFiles(root)) {
		const text = readFileSync(join(root, file), "latin1");
		let claimed = false;
		for (const rule of policy.web.rules) {
			if (!new RegExp(rule.files).test(file)) continue;
			if (rule.marker && !text.includes(rule.marker)) continue;
			const names = [...(rule.packages ?? [])];
			const markers = rule.markerPackages;
			if (markers) {
				const pattern = new RegExp(markers.pattern, "g");
				const fromFile = [...text.matchAll(pattern)].map((m) =>
					markers.name.replace("$1", m[1] ?? ""),
				);
				if (fromFile.length === 0) {
					throw new Error(`${policy.web.root}/${file}: no ${markers.pattern} markers`);
				}
				names.push(...fromFile);
			}
			for (const name of names) {
				found.add(join(resolveChain(repoRoot, rule.resolveFrom, name), "package.json"));
			}
			claimed = true;
		}
		if (
			!claimed &&
			mustAttribute.test(file) &&
			!existsSync(join(mapRoot, `${file}.map`)) &&
			!isGlueChunk(text)
		) {
			unattributed.push(file);
		}
	}
	if (unattributed.length > 0) {
		throw new Error(
			`shipped web files with no source map and no attribution rule:\n  ${unattributed.join("\n  ")}`,
		);
	}
	return [...found].sort();
}

/** Group bundled source files by npm package and attach licence files. */
export function collectPackages(
	sourcesByArtifact: Map<string, string[]>,
	policy: Pick<Policy, "withoutLicenceText">,
): BundledPackage[] {
	const roots = new Map<string, Set<string>>();
	for (const [artifact, sources] of sourcesByArtifact) {
		for (const source of sources) {
			const root = packageRootOf(source);
			if (!root) continue;
			if (!existsSync(join(root, "package.json"))) {
				throw new Error(`bundled source has no package.json at its package root: ${source}`);
			}
			const users = roots.get(root) ?? new Set<string>();
			users.add(artifact);
			roots.set(root, users);
		}
	}
	const packages: BundledPackage[] = [];
	const unexplained: string[] = [];
	for (const [root, users] of roots) {
		const meta = readPackage(root);
		const files = licenceFiles(root);
		const pkg: BundledPackage = { ...meta, root, usedBy: [...users].sort(), files };
		if (files.length === 0) {
			const reason = policy.withoutLicenceText[meta.name];
			if (reason) pkg.missingReason = reason;
			else unexplained.push(`${meta.name}@${meta.version} (${root})`);
		}
		packages.push(pkg);
	}
	if (unexplained.length > 0) {
		throw new Error(
			"bundled packages without a licence file, not listed in withoutLicenceText:\n  " +
				unexplained.join("\n  "),
		);
	}
	// Two copies of one name@version (different install paths) collapse into one entry.
	const unique = new Map<string, BundledPackage>();
	for (const pkg of packages) {
		const key = `${pkg.name}@${pkg.version}`;
		const seen = unique.get(key);
		if (!seen) unique.set(key, pkg);
		else seen.usedBy = [...new Set([...seen.usedBy, ...pkg.usedBy])].sort();
	}
	return [...unique.values()].sort((a, b) =>
		a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
	);
}

/** Pinned Bun runtime licence, verified against the running Bun and its hash. */
export function runtimeLicence(
	repoRoot: string,
	runtime: Policy["runtime"],
	bun: { version: string; revision: string },
): string {
	if (bun.version !== runtime.version || !bun.revision.startsWith(runtime.revision.slice(0, 9))) {
		throw new Error(
			`Bun ${bun.version}+${bun.revision.slice(0, 9)} compiles this package, but the notices pin ` +
				`${runtime.name} ${runtime.version}+${runtime.revision.slice(0, 9)}; refresh ${runtime.file} ` +
				`from that release's LICENSE.md and update the policy`,
		);
	}
	const path = resolve(repoRoot, runtime.file);
	if (!existsSync(path)) throw new Error(`pinned runtime licence missing: ${runtime.file}`);
	const text = readFileSync(path, "utf8");
	if (sha256(text) !== runtime.sha256) {
		throw new Error(`pinned runtime licence changed: ${runtime.file} does not match its sha256`);
	}
	return text;
}

const RULE = "=".repeat(78);

export function renderCopyright(repoRoot: string, policy: Policy): string {
	const texts = new Map<string, string[]>();
	for (const file of policy.firstParty.licenceFiles) {
		const path = resolve(repoRoot, file);
		if (!existsSync(path)) throw new Error(`first-party licence file missing: ${file}`);
		const text = readFileSync(path, "utf8");
		texts.set(text, [...(texts.get(text) ?? []), file]);
	}
	const brand = resolve(repoRoot, policy.firstParty.brandNotice);
	if (!existsSync(brand)) throw new Error(`brand notice missing: ${policy.firstParty.brandNotice}`);
	const parts = [
		"ceralive-device",
		"",
		`Source: ${policy.firstParty.source}`,
		"",
		"The licence files of the CeraUI source tree are reproduced below. The",
		"brand assets under /var/www/ceralive have their own notice, also below.",
		"Components bundled into the executables and the web app are listed with",
		"their own licence texts in THIRD-PARTY-NOTICES in this directory.",
	];
	for (const [text, files] of texts) {
		parts.push("", RULE, `Licence text from ${files.join(", ")}`, RULE, "", text.trimEnd());
	}
	parts.push(
		"",
		RULE,
		`Brand assets: ${policy.firstParty.brandNotice}`,
		RULE,
		"",
		readFileSync(brand, "utf8").trimEnd(),
	);
	return `${parts.join("\n")}\n`;
}

export function renderNotices(packages: BundledPackage[], policy: Policy, runtimeText: string): string {
	const parts = [
		"Third-party components in ceralive-device",
		"",
		"Generated at build time from the bundler's source maps and the pinned",
		"runtime licence. Texts are copied verbatim from each component.",
		"",
		RULE,
		`${policy.runtime.name} ${policy.runtime.version} (${policy.runtime.revision}), compiled into the executables`,
		`Source: ${policy.runtime.source}`,
		RULE,
		"",
		runtimeText.trimEnd(),
	];
	for (const pkg of packages) {
		parts.push(
			"",
			RULE,
			`${pkg.name} ${pkg.version} (declared licence: ${pkg.declared})`,
			`Bundled into: ${pkg.usedBy.join(", ")}`,
			RULE,
		);
		if (pkg.files.length === 0) {
			parts.push("", `No licence text is published in this package. ${pkg.missingReason}`);
		}
		for (const file of pkg.files) {
			parts.push("", `--- ${file.name} ---`, "", file.text.trimEnd());
		}
	}
	return `${parts.join("\n")}\n`;
}

export function renderIndex(packages: BundledPackage[], policy: Policy): string {
	const index = {
		runtime: {
			name: policy.runtime.name,
			version: policy.runtime.version,
			revision: policy.runtime.revision,
			source: policy.runtime.source,
			sha256: policy.runtime.sha256,
		},
		packages: packages.map((pkg) => ({
			name: pkg.name,
			version: pkg.version,
			declaredLicence: pkg.declared,
			bundledInto: pkg.usedBy,
			licenceFiles: pkg.files.map(({ name, sha256 }) => ({ name, sha256 })),
			...(pkg.files.length === 0 ? { withoutLicenceText: pkg.missingReason } : {}),
		})),
	};
	return `${JSON.stringify(index, null, "\t")}\n`;
}

export type GenerateOptions = {
	repoRoot: string;
	policy: Policy;
	outDir: string;
	bun?: { version: string; revision: string };
	backend?: Map<string, string[]>;
};

export async function generate(options: GenerateOptions): Promise<BundledPackage[]> {
	const { repoRoot, policy, outDir } = options;
	const runtimeText = runtimeLicence(
		repoRoot,
		policy.runtime,
		options.bun ?? { version: Bun.version, revision: Bun.revision },
	);
	const sources = options.backend ?? (await backendSources(repoRoot, policy.backendEntrypoints));
	const webDir = resolve(repoRoot, policy.webSourcemapDir);
	const webMaps = existsSync(webDir) ? listMaps(webDir) : [];
	if (webMaps.length === 0) {
		throw new Error(
			`no web app source maps under ${policy.webSourcemapDir}; build the frontend first`,
		);
	}
	sources.set(policy.web.label, [
		...webMaps.flatMap(sourcesOfMap),
		...webFilePackages(repoRoot, policy),
	]);
	const packages = collectPackages(sources, policy);
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "copyright"), renderCopyright(repoRoot, policy));
	writeFileSync(join(outDir, "THIRD-PARTY-NOTICES"), renderNotices(packages, policy, runtimeText));
	writeFileSync(join(outDir, "third-party-notices.json"), renderIndex(packages, policy));
	return packages;
}

/**
 * Cross-check a compiled executable against the notices. Bun embeds the source
 * map of a `--compile --sourcemap` build, so its node_modules/.bun/<name>@<version>
 * paths (Bun's isolated install layout) name what was really bundled. Every one
 * must have a notice entry; finding none means the check cannot work.
 */
export function checkBinary(path: string, packages: BundledPackage[]): string[] {
	const bytes = readFileSync(path).toString("latin1");
	const known = new Set(packages.map((pkg) => `${pkg.name}@${pkg.version}`));
	const isolated =
		/node_modules\/\.bun\/([^/"\s]+)\/node_modules\/((?:@[^/"\s]+\/)?[^/"\s]+)\//g;
	const missing = new Set<string>();
	let seen = 0;
	for (const [, folder = "", name = ""] of bytes.matchAll(isolated)) {
		seen++;
		const prefix = `${name.replace("/", "+")}@`;
		const version = folder.startsWith(prefix) ? folder.slice(prefix.length) : folder;
		// Bun appends +<hash> to the folder of a package installed with peer variants.
		const listed = [...known].some(
			(entry) =>
				entry === `${name}@${version}` ||
				(entry.startsWith(`${name}@`) && version.startsWith(`${entry.slice(name.length + 1)}+`)),
		);
		if (!listed) missing.add(`${name}@${version}`);
	}
	if (seen === 0) {
		return [`no node_modules/.bun paths in ${path}; was it compiled with --sourcemap?`];
	}
	return [...missing].sort();
}

export function loadPolicy(path: string): Policy {
	return JSON.parse(readFileSync(path, "utf8")) as Policy;
}

type Args = { outDir: string; policy: string; binaries: string[] };

function parseArgs(argv: string[]): Args {
	const parsed: Args = { outDir: "", policy: "", binaries: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		const value = () => {
			const next = argv[++i];
			if (!next) throw new Error(`${arg} needs a value`);
			return next;
		};
		if (arg === "--policy") parsed.policy = value();
		else if (arg === "--check-binary") parsed.binaries.push(value());
		else if (!parsed.outDir) parsed.outDir = arg;
		else throw new Error(`unexpected argument: ${arg}`);
	}
	return parsed;
}

if (import.meta.main) {
	const repoRoot = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "../..");
	try {
		const args = parseArgs(process.argv.slice(2));
		if (!args.outDir) {
			throw new Error(
				"usage: third-party-notices.ts <output-dir> [--policy policy.json] [--check-binary exe]...",
			);
		}
		const outDir = resolve(args.outDir);
		const packages = await generate({
			repoRoot,
			policy: loadPolicy(args.policy || join(repoRoot, "scripts/build/third-party-notices.json")),
			outDir,
		});
		for (const binary of args.binaries) {
			const missing = checkBinary(binary, packages);
			if (missing.length > 0) {
				throw new Error(`${binary} bundles packages missing from the notices: ${missing.join(", ")}`);
			}
		}
		const without = packages.filter((pkg) => pkg.files.length === 0);
		console.log(
			`notices: ${packages.length} bundled packages, ${without.length} without licence text` +
				(without.length ? ` (${without.map((pkg) => pkg.name).join(", ")})` : ""),
		);
	} catch (error) {
		console.error(`notices: ${(error as Error).message}`);
		process.exit(1);
	}
}
