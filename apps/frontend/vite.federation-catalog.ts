import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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

export const FEDERATION_CATALOG_REGENERATE =
	"bun run --filter frontend generate:federation-catalog";

/**
 * Producer sources whose i18n keys can reach a hosted dialog as data. Source
 * descriptors carry `labelKey` and `unavailableReason` keys, never English text
 * (`packages/rpc/src/schemas/sources.schema.ts`), and the dialogs render them
 * through `t(key)`. The key never appears as a literal in the frontend graph, so
 * it is collected here.
 */
export const PRODUCER_SOURCE_DIRS: readonly string[] = [
	join(root, "apps/backend/src"),
	join(root, "packages/rpc/src"),
];

const NAMESPACE_BARREL =
	/packages[/\\]i18n[/\\]generated[/\\]namespaces[/\\]([^/\\]+)\.js$/;

// A dotted literal, or the static head of a template or concatenated dynamic key.
// The same pattern `tests/federation/federation-namespaces.test.ts` applies.
const LITERAL = /["'`]([A-Za-z][A-Za-z0-9]*\.[A-Za-z0-9_.]*)(?=["'`]|\$\{)/g;

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

function isTestSource(path: string): boolean {
	return (
		/\.(test|spec)\.ts$/.test(path) ||
		path.split(sep).some((part) => part === "tests" || part === "__tests__")
	);
}

function producerSources(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => join(entry.parentPath, entry.name))
		.filter((path) => !isTestSource(path))
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

function namespaceOf(key: string): string {
	return key.slice(0, key.indexOf("."));
}

/**
 * The keys a federation build must carry: everything the bundled code names,
 * plus the producer vocabulary in the namespaces that code reads. Producer keys
 * in other namespaces cannot render in a hosted dialog, which never registers
 * those namespaces.
 */
export function expectedFederationKeys(
	bundled: ReadonlySet<string>,
	producer: ReadonlySet<string>,
): string[] {
	const namespaces = new Set([...bundled].map(namespaceOf));
	const keys = new Set(bundled);
	for (const key of producer) {
		if (namespaces.has(namespaceOf(key))) keys.add(key);
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
	return (
		id.startsWith(join(i18n, "generated") + sep) ||
		id.startsWith(join(i18n, "src/paraglide") + sep) ||
		id.startsWith(paraglideOutdir + sep)
	);
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
 */
export function federationCatalogPlugin(options: {
	paraglideOutdir: string;
	keysPath?: string;
	mode?: string | undefined;
}) {
	const keysPath = options.keysPath ?? FEDERATION_CATALOG_KEYS_PATH;
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
			for (const chunk of Object.values(bundle)) {
				if (chunk.type !== "chunk") continue;
				for (const [id, module] of Object.entries(chunk.modules)) {
					if (module.code === null) continue;
					if (isCatalogModule(id, options.paraglideOutdir)) continue;
					for (const key of referencedCatalogKeys(module.code, catalogKeys)) {
						bundled.add(key);
					}
				}
			}
			if (bundled.size === 0) {
				this.error("federation catalog: the bundles name no catalog keys");
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
