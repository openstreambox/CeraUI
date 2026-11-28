import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontend = dirname(fileURLToPath(import.meta.url));
const root = resolve(frontend, "../..");
const i18n = join(root, "packages/i18n");

/** The committed list of message keys the signed federation bundles carry. */
export const FEDERATION_CATALOG_KEYS_PATH = join(
	frontend,
	"src/lib/federation/catalog-keys.json",
);

/** Set to `write` to regenerate the key list from the build instead of checking it. */
export const FEDERATION_CATALOG_MODE_ENV = "CERAUI_FEDERATION_CATALOG";

/**
 * Hand-maintained declarations for every message lookup whose key the bundled
 * code computes. The generator never writes this file, so regenerating the key
 * list cannot bless a lookup nobody has accounted for.
 */
export const FEDERATION_COMPUTED_LOOKUPS_PATH = join(
	frontend,
	"src/lib/federation/computed-lookups.json",
);

export const FEDERATION_CATALOG_REGENERATE =
	"bun run --filter frontend generate:federation-catalog";

/**
 * Producer sources whose i18n keys can reach a hosted dialog as data. Source
 * descriptors carry `labelKey` and `unavailableReason` keys, never English text
 * (`packages/rpc/src/schemas/sources.schema.ts`), and the dialogs render them
 * through `t(key)`. Such a key need not appear as a literal in the frontend
 * graph, so it is collected here and kept when its family is one the dialogs read.
 */
export const PRODUCER_SOURCE_DIRS: readonly string[] = [
	join(root, "apps/backend/src"),
	join(root, "packages/rpc/src"),
];

const NAMESPACE_BARREL =
	/packages[/\\]i18n[/\\]generated[/\\]namespaces[/\\]([^/\\]+)\.js$/;

// A dotted literal, or the static head of a template or concatenated dynamic key.
// The same pattern `tests/federation/federation-namespaces.test.ts` applies.
const LITERAL = /["'`]([A-Za-z][A-Za-z0-9]*\.[A-Za-z0-9_.-]*)(?=["'`]|\$\{)/g;

const BARREL_IMPORT = /^import \{ ("(?:[^"\\]|\\.)*") as (_\d+) \} from "[^"]+";$/;
const BARREL_ENTRY = /^\t\[("(?:[^"\\]|\\.)*")\]: (_\d+),$/;

const EMPTY_BARREL = "export const messages = {};\n";

/** Every dotted key in the base catalog, `$schema` excluded. */
export function readCatalogKeys(): string[] {
	const catalog = JSON.parse(
		readFileSync(join(i18n, "messages/en.json"), "utf8"),
	) as Record<string, unknown>;
	return Object.keys(catalog).filter((key) => key !== "$schema");
}

/**
 * The catalog keys a piece of code names: exact dotted literals, plus every key
 * under a literal head that ends in a dot (`` `live.layout.error.${code}` ``).
 */
export function referencedCatalogKeys(
	code: string,
	catalogKeys: readonly string[],
): Set<string> {
	const known = new Set(catalogKeys);
	const found = new Set<string>();
	for (const [, literal = ""] of code.matchAll(LITERAL)) {
		if (known.has(literal)) {
			found.add(literal);
		} else if (literal.endsWith(".")) {
			for (const key of catalogKeys) {
				if (key.startsWith(literal)) found.add(key);
			}
		}
	}
	return found;
}

/** Forward slashes, no Vite query or virtual-module prefix. */
export function normalizeModulePath(id: string): string {
	return id.replace(/^\0/, "").replace(/\?.*$/, "").replace(/\\/g, "/");
}

/** Whether a path RELATIVE to a producer source root is a test source. */
function isTestSource(relativePath: string): boolean {
	return (
		/\.(test|spec)\.ts$/.test(relativePath) ||
		relativePath.split("/").some((part) => part === "tests" || part === "__tests__")
	);
}

function producerSources(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => join(entry.parentPath, entry.name))
		.filter((path) => !isTestSource(normalizeModulePath(relative(dir, path))))
		.sort();
}

/** Every catalog key the producer's non-test sources name, i.e. what it can send. */
export function producerVocabulary(
	catalogKeys: readonly string[],
	dirs: readonly string[] = PRODUCER_SOURCE_DIRS,
): Set<string> {
	const found = new Set<string>();
	for (const dir of dirs) {
		for (const path of producerSources(dir)) {
			for (const key of referencedCatalogKeys(readFileSync(path, "utf8"), catalogKeys)) {
				found.add(key);
			}
		}
	}
	return found;
}

/** A key's family: every segment but the last (`live.education.reason`). */
function familyOf(key: string): string {
	return key.slice(0, key.lastIndexOf("."));
}

/**
 * The keys a federation build must carry: everything the bundled code names,
 * plus each producer key whose family the bundled code already reads. A wire
 * key renders in a dialog only through code that handles its family, and that
 * code names siblings (`live.education.reason.unsupportedPlatform` next to the
 * producer's `live.education.reason.pipelineNotOffered`). A family is at least
 * two segments, so a namespace alone never qualifies: backend notification copy
 * (`notifications.*`) and template heads such as `network.changeSafety.` that no
 * dialog renders stay out.
 */
export function expectedFederationKeys(
	bundled: ReadonlySet<string>,
	producer: ReadonlySet<string>,
): string[] {
	const families = new Set(
		[...bundled].map(familyOf).filter((family) => family.includes(".")),
	);
	const keys = new Set(bundled);
	for (const key of producer) {
		if (families.has(familyOf(key))) keys.add(key);
	}
	return [...keys].sort();
}

export function readFederationCatalogKeys(
	path: string = FEDERATION_CATALOG_KEYS_PATH,
): string[] {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as { keys?: unknown };
	if (
		!Array.isArray(parsed.keys) ||
		parsed.keys.some((key) => typeof key !== "string")
	) {
		throw new Error(`${path} has no string "keys" array`);
	}
	return parsed.keys as string[];
}

export function serializeFederationCatalogKeys(keys: readonly string[]): string {
	return `${JSON.stringify(
		{
			$comment: `Message keys the federation bundles carry. Generated and checked by vite.federation-catalog.ts; regenerate with \`${FEDERATION_CATALOG_REGENERATE}\`.`,
			keys: [...keys].sort(),
		},
		null,
		"\t",
	)}\n`;
}

/**
 * Narrows a generated namespace barrel to the kept keys. The barrel's two line
 * shapes come from `packages/i18n/scripts/generate-registry.ts`; any other line
 * that names a binding is refused, so a generator change cannot silently keep
 * or drop messages.
 */
export function filterNamespaceBarrel(
	source: string,
	keep: ReadonlySet<string>,
): string {
	const kept: string[] = [];
	let imports = 0;
	let entries = 0;
	let retained = 0;
	for (const line of source.split("\n")) {
		const match = BARREL_IMPORT.exec(line) ?? BARREL_ENTRY.exec(line);
		if (match === null) {
			if (/\b_\d+\b/.test(line)) {
				throw new Error(`unrecognised namespace barrel line: ${line}`);
			}
			kept.push(line);
			continue;
		}
		const isImport = line.startsWith("import ");
		if (isImport) imports += 1;
		else entries += 1;
		const key = JSON.parse(match[1] ?? '""') as string;
		if (keep.has(key)) {
			kept.push(line);
			if (isImport) retained += 1;
		}
	}
	if (imports !== entries) {
		throw new Error(
			`namespace barrel has ${imports} imports but ${entries} entries`,
		);
	}
	return retained === 0 ? EMPTY_BARREL : kept.join("\n");
}

/** Modules that ARE the catalog, so their literals are not references to it. */
export function isCatalogModule(id: string, paraglideOutdir: string): boolean {
	const path = normalizeModulePath(id);
	return [join(i18n, "generated"), join(i18n, "src/paraglide"), paraglideOutdir]
		.map((dir) => `${normalizeModulePath(dir)}/`)
		.some((dir) => path.startsWith(dir));
}

// The lookup names the facade exports, and the injected `msg` helpers use.
const LOOKUP_NAMES = "t|m|msg|resolveMessageKey";
const LOOKUP_CALL = new RegExp(
	`(?<![\\w.$])(?<!function\\s+)(${LOOKUP_NAMES})\\s*(?:\\?\\.\\s*)?([([])`,
	"g",
);
const I18N_SPECIFIERS = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@ceraui\/i18n(?:\/svelte)?["']/g;
const I18N_NAMESPACE = /import\s+\*\s*as\s+\w+\s+from\s*["']@ceraui\/i18n(?:\/svelte)?["']/g;
const KEY_TEXT = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+$/;
const KEY_PREFIX = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)*\.$/;

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** The callee plus its balanced argument or index, whitespace collapsed. */
function callText(source: string, start: number, open: number): string {
	const close = source[open] === "(" ? ")" : "]";
	let depth = 0;
	for (let index = open; index < source.length; index += 1) {
		const char = source[index];
		if (char === source[open]) depth += 1;
		else if (char === close && --depth === 0) {
			return source.slice(start, index + 1).replace(/\s+/g, " ");
		}
	}
	return source.slice(start, open + 1);
}

/**
 * Whether the argument starting at `index` is fully accounted for by the literal
 * collector: a single string literal that is a key and the WHOLE argument, or a
 * template that is a key, or whose only static head ends in a dot.
 */
function literalArgument(code: string, index: number): boolean {
	const quote = code[index];
	if (quote !== '"' && quote !== "'" && quote !== "`") return false;
	let end = index + 1;
	while (end < code.length && code[end] !== quote) end += code[end] === "\\" ? 2 : 1;
	let next = end + 1;
	while (/\s/.test(code[next] ?? "")) next += 1;
	if (![")", ",", "]"].includes(code[next] ?? "")) return false;
	const body = code.slice(index + 1, end);
	if (quote !== "`" || !body.includes("${")) return KEY_TEXT.test(body);
	return KEY_PREFIX.test(body.slice(0, body.indexOf("${"))) && !body.slice(body.indexOf("${")).includes("`");
}

/**
 * The message lookups in a module that the literal collector cannot account
 * for, each of which must be declared:
 *
 * - a lookup whose key is computed: `t(option.reason)`, `m[key]`, `t?.(key)`,
 *   `resolveMessageKey(["a", b].join("."))`, `t("a." + b)`;
 * - the facade handed on as a value (`format(msg)`, `const tr = t`, `...m`),
 *   since the receiver can compute keys under any name;
 * - the facade imported under another name or as a namespace.
 *
 * This is a source heuristic, not binding analysis. Hosted code imports the
 * facade directly from `@ceraui/i18n/svelte`; a local re-export is caught by
 * {@link facadeReexports}. Known gaps: a facade destructured from a dynamic
 * `import()`, and `t.bind(...)` / `t.call(...)`.
 * The built relay-validation ABI case in Build Check backstops the computed
 * stage labels, the path such a change would break first.
 */
export function computedLookups(source: string): string[] {
	const code = stripComments(source);
	const found = new Set<string>();
	for (const match of code.matchAll(LOOKUP_CALL)) {
		const open = (match.index ?? 0) + match[0].length - 1;
		let argument = open + 1;
		while (/\s/.test(code[argument] ?? "")) argument += 1;
		if (code[argument] === ")" || literalArgument(code, argument)) continue;
		found.add(callText(code, match.index ?? 0, open));
	}
	// Names bound to the facade in this module: imports from @ceraui/i18n, and
	// local copies such as `const t = resolveMessageKey`.
	const isLookupName = (name: string) => new RegExp(`^(?:${LOOKUP_NAMES})$`).test(name);
	const facade = new Set<string>();
	for (const match of code.matchAll(I18N_SPECIFIERS)) {
		if (/^import\s+type\b/.test(match[0])) continue;
		for (const specifier of (match[1] ?? "").split(",")) {
			if (/^\s*type\s/.test(specifier)) continue;
			const [imported = "", local = imported] = specifier.trim().split(/\s+as\s+/);
			if (!isLookupName(imported)) continue;
			if (isLookupName(local)) facade.add(local);
			else found.add(`alias ${imported} as ${local}`);
		}
	}
	for (const match of code.matchAll(I18N_NAMESPACE)) {
		found.add(`namespace ${match[0].replace(/\s+/g, " ")}`);
	}
	for (const match of code.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*([\w$]+)\s*;/g)) {
		const [, local = "", value = ""] = match;
		if (!facade.has(value)) continue;
		if (isLookupName(local)) facade.add(local);
		else found.add(`alias ${value} as ${local}`);
	}
	// The facade handed on as a value (an argument, a return, a spread, a
	// property): the receiver can compute keys under any parameter name.
	for (const name of facade) {
		const use = new RegExp(`(?<![\\w.$])(?:\\.\\.\\.)?${name}(?![\\w$])(?!\\s*(?:\\(|\\[|\\?\\.|\\.|=[^=>]))`, "g");
		for (const match of code.matchAll(use)) {
			const at = match.index ?? 0;
			const start = code.lastIndexOf("\n", at) + 1;
			const end = code.indexOf("\n", at);
			const line = code.slice(start, end === -1 ? undefined : end).trim().replace(/\s+/g, " ");
			if (/^import\b/.test(line) || /\bfrom\s*["']@ceraui\/i18n/.test(line)) continue;
			// A plain copy is reported above as an alias, or kept as a lookup name.
			if (new RegExp(`^(?:const|let|var)\\s+[\\w$]+\\s*=\\s*${name}\\s*;$`).test(line)) continue;
			found.add(`passes ${name}: ${line}`);
		}
	}
	return [...found].sort();
}

const I18N_REEXPORT_SPECIFIERS =
	/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@ceraui\/i18n(?:\/svelte)?["']/g;
const I18N_REEXPORT_ALL = /export\s+\*\s*(?:as\s+[\w$]+\s+)?from\s*["']@ceraui\/i18n(?:\/svelte)?["']/g;

/**
 * Facade re-exports (`export { resolveMessageKey as translate } from
 * "@ceraui/i18n/svelte"`, `export * from ...`). A module that only re-exports
 * renders no code, so it is scanned whether or not the bundle kept any of it:
 * its importers call the facade under a name the lookup scan cannot follow.
 */
export function facadeReexports(source: string): string[] {
	const code = stripComments(source);
	const found = new Set<string>();
	for (const match of code.matchAll(I18N_REEXPORT_SPECIFIERS)) {
		if (/^export\s+type\b/.test(match[0])) continue;
		for (const specifier of (match[1] ?? "").split(",")) {
			if (/^\s*type\s/.test(specifier)) continue;
			const [imported = ""] = specifier.trim().split(/\s+as\s+/);
			if (new RegExp(`^(?:${LOOKUP_NAMES})$`).test(imported)) {
				found.add(`reexport ${specifier.trim().replace(/\s+/g, " ")}`);
			}
		}
	}
	for (const match of code.matchAll(I18N_REEXPORT_ALL)) {
		found.add(`reexport ${match[0].replace(/\s+/g, " ")}`);
	}
	return [...found].sort();
}

export interface ComputedLookupDeclaration {
	/** `<repo-relative path> <lookup text>`, as {@link computedLookups} prints it. */
	site: string;
	/** Key families the computed key can come from; their keys all ship. */
	families: string[];
	why: string;
}

export function readComputedLookups(
	path: string = FEDERATION_COMPUTED_LOOKUPS_PATH,
): ComputedLookupDeclaration[] {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as { lookups?: unknown };
	if (!Array.isArray(parsed.lookups)) {
		throw new Error(`${path} has no "lookups" array`);
	}
	for (const entry of parsed.lookups as Partial<ComputedLookupDeclaration>[]) {
		if (
			typeof entry.site !== "string" ||
			!Array.isArray(entry.families) ||
			entry.families.some((family) => typeof family !== "string") ||
			typeof entry.why !== "string" ||
			entry.why.trim() === ""
		) {
			throw new Error(`${path}: malformed lookup ${JSON.stringify(entry)}`);
		}
	}
	return parsed.lookups as ComputedLookupDeclaration[];
}

interface RenderedChunk {
	type: "chunk";
	modules: Record<string, { code: string | null }>;
}

interface PluginContextLike {
	error(message: string): never;
	warn(message: string): void;
}

function describeDrift(missing: string[], stale: string[]): string {
	const list = (keys: string[]) =>
		keys.slice(0, 20).join(", ") + (keys.length > 20 ? `, … (${keys.length})` : "");
	return [
		missing.length > 0
			? `${missing.length} key(s) the bundles name are missing: ${list(missing)}`
			: "",
		stale.length > 0
			? `${stale.length} listed key(s) nothing names any more: ${list(stale)}`
			: "",
	]
		.filter(Boolean)
		.join("; ");
}

/**
 * Ships only the message keys the federation bundles can render.
 *
 * Every namespace barrel loads narrowed to `catalog-keys.json`, so the locale
 * modules lose the unused messages to tree-shaking. After bundling, the plugin
 * re-derives the list from the rendered (tree-shaken) code of every non-catalog
 * module plus the producer vocabulary and fails the build on any difference: a
 * missing key would render as its dotted name, a stale one ships dead copy.
 * A lookup whose key the code computes must be declared, with the families its
 * key comes from, in `computed-lookups.json`; an undeclared or stale declaration
 * fails the build in write mode too.
 */
export function federationCatalogPlugin(options: {
	paraglideOutdir: string;
	keysPath?: string;
	computedLookupsPath?: string;
	/** Repository root that computed-lookup sites are relative to. */
	root?: string;
	mode?: string | undefined;
}) {
	const sourceRoot = options.root ?? root;
	const keysPath = options.keysPath ?? FEDERATION_CATALOG_KEYS_PATH;
	const lookupsPath = options.computedLookupsPath ?? FEDERATION_COMPUTED_LOOKUPS_PATH;
	const writing = options.mode === "write";
	let keep: Set<string> = new Set();

	return {
		name: "ceraui:federation-catalog",
		buildStart() {
			keep = new Set(
				writing && !existsSync(keysPath) ? [] : readFederationCatalogKeys(keysPath),
			);
		},
		load(id: string): string | null {
			if (NAMESPACE_BARREL.exec(id) === null) return null;
			return filterNamespaceBarrel(readFileSync(id, "utf8"), keep);
		},
		generateBundle(
			this: PluginContextLike,
			_output: unknown,
			bundle: Record<string, RenderedChunk | { type: "asset" }>,
		) {
			const catalogKeys = readCatalogKeys();
			const bundled = new Set<string>();
			const sites = new Set<string>();
			const normalizedRoot = `${normalizeModulePath(sourceRoot)}/`;
			for (const chunk of Object.values(bundle)) {
				if (chunk.type !== "chunk") continue;
				for (const [id, module] of Object.entries(chunk.modules)) {
					if (isCatalogModule(id, options.paraglideOutdir)) continue;
					if (module.code !== null) {
						for (const key of referencedCatalogKeys(module.code, catalogKeys)) {
							bundled.add(key);
						}
					}
					const path = normalizeModulePath(id);
					if (!path.startsWith(normalizedRoot) || path.includes("/node_modules/")) continue;
					if (!/\.(ts|js|svelte)$/.test(path) || !existsSync(path)) continue;
					const source = readFileSync(path, "utf8");
					const relativePath = path.slice(normalizedRoot.length);
					for (const reexport of facadeReexports(source)) sites.add(`${relativePath} ${reexport}`);
					if (module.code === null) continue;
					for (const lookup of computedLookups(source)) {
						sites.add(`${relativePath} ${lookup}`);
					}
				}
			}
			if (bundled.size === 0) {
				this.error("federation catalog: the bundles name no catalog keys");
			}

			const declarations = readComputedLookups(lookupsPath);
			const declared = new Set(declarations.map((entry) => entry.site));
			const undeclared = [...sites].filter((site) => !declared.has(site)).sort();
			const gone = [...declared].filter((site) => !sites.has(site)).sort();
			const lookupsFile = relative(root, lookupsPath);
			if (undeclared.length > 0 || gone.length > 0) {
				this.error(
					`federation catalog: ${lookupsFile} does not match the bundled computed message lookups. ` +
						(undeclared.length > 0
							? `Declare, with the key families each can produce: ${undeclared.join(" | ")}. `
							: "") +
						(gone.length > 0 ? `Remove declarations no bundled code has: ${gone.join(" | ")}.` : ""),
				);
			}
			for (const { site, families } of declarations) {
				for (const family of families) {
					const members = catalogKeys.filter((key) => key.startsWith(`${family}.`));
					if (members.length === 0) {
						this.error(`federation catalog: ${lookupsFile}: family ${family} (${site}) has no catalog keys`);
					}
					for (const key of members) bundled.add(key);
				}
			}

			const expected = expectedFederationKeys(
				bundled,
				producerVocabulary(catalogKeys),
			);
			const listed = [...keep].sort();
			const missing = expected.filter((key) => !keep.has(key));
			const expectedSet = new Set(expected);
			const stale = listed.filter((key) => !expectedSet.has(key));
			if (missing.length === 0 && stale.length === 0) return;

			const drift = describeDrift(missing, stale);
			const file = relative(root, keysPath);
			if (writing) {
				writeFileSync(keysPath, serializeFederationCatalogKeys(expected));
				this.warn(`federation catalog: rewrote ${file} (${drift}); rebuild to ship it`);
				return;
			}
			this.error(
				`federation catalog: ${file} is out of date (${drift}). Run \`${FEDERATION_CATALOG_REGENERATE}\` and commit the result.`,
			);
		},
	};
}
