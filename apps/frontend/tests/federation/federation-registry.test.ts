/**
 * @vitest-environment jsdom
 *
 * Renders the BUILT federation registry, the copy the signed bundles really
 * carry, against the full compiled catalog. A pruned list that drops a key, or
 * a registry entry that stopped rendering its copy, fails here even when the
 * key's spelling is still somewhere in the bundle.
 *
 * Kept apart from `federation-namespaces.test.ts`, which imports the source
 * `messages.ts`: the built bundles are loaded in a graph without the source i18n.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import {
	ALL_LOCALES,
	readOracleParams,
	readRenderedOracle,
} from "../../../../packages/i18n/tests/helpers/catalog";
import type {
	FederationHostAdapter,
	FederationMountHandle,
	FederationMountOptions,
} from "../../src/lib/federation/host-contract";
import { readCatalogKeys, readFederationCatalogKeys } from "../../vite.federation-catalog";
import { FEDERATION_PARAGLIDE_OUTDIR } from "../../vite.federation-i18n";

const ROOT = resolve(import.meta.dirname, "../../../..");
const VERSION = (
	JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
).version;
const OUTPUT = join(ROOT, "dist", "federation", VERSION);

type Message = (inputs?: Record<string, unknown>, options?: { locale?: string }) => string;
type Resolve = (key: string, params?: Record<string, unknown>) => string;

interface FederationModule {
	mountDialog(target: Element, options: FederationMountOptions): FederationMountHandle;
}

const PROBE = "notifications.saveFailed";
const UNKNOWN = "federationRegistryTest.unknownKey";

/**
 * The shared chunk does not export `m`, but it does export the key resolver the
 * dialogs use (`resolveMessageKey`): the one exported two-argument function that
 * renders a registered key and echoes an unknown one.
 */
async function builtResolver(compiled: Record<string, Message>): Promise<Resolve> {
	const chunk = readdirSync(OUTPUT).find((name) => /^toast-host-.+\.js$/.test(name));
	if (chunk === undefined) throw new Error(`no toast-host chunk in ${OUTPUT}`);
	const exports = (await import(pathToFileURL(join(OUTPUT, chunk)).href)) as Record<
		string,
		unknown
	>;
	const english = (compiled[PROBE] as Message)({}, { locale: "en" });
	const matches = Object.values(exports).filter((value): value is Resolve => {
		if (typeof value !== "function" || value.length !== 2) return false;
		try {
			return value(PROBE) === english && value(UNKNOWN) === UNKNOWN;
		} catch {
			return false;
		}
	});
	expect(matches).toHaveLength(1);
	return matches[0] as Resolve;
}

/** Applies a locale to the bundle's own runtime the way a host does: through mountDialog. */
async function useLocale(audio: FederationModule, locale: string): Promise<void> {
	const target = document.createElement("div");
	document.body.append(target);
	const handle = audio.mountDialog(target, {
		host: { setConfig: async () => ({ success: true }) } as unknown as FederationHostAdapter,
		locale,
	});
	await new Promise((done) => setTimeout(done, 0));
	await handle.destroy();
	target.remove();
}

/** Each input set a key is rendered with: its oracle params, every plural count, or none. */
function inputSets(key: string, params: ReturnType<typeof readOracleParams>) {
	const spec = params.keys[key];
	if (spec?.plural) {
		return params.counts.map((count) =>
			Object.fromEntries(spec.countParams.map((name) => [name, count])),
		);
	}
	return [spec ? { ...spec.params } : {}];
}

describe("federation registry — the BUILT toast-host chunk", () => {
	let audio: FederationModule;
	let compiled: Record<string, Message>;
	let resolveKey: Resolve;

	// Each test can run alone: load an entry (it registers the catalog at module
	// scope), put the runtime in English, then find the resolver.
	beforeAll(async () => {
		audio = (await import(pathToFileURL(join(OUTPUT, "audio.js")).href)) as FederationModule;
		compiled = (await import(
			pathToFileURL(join(FEDERATION_PARAGLIDE_OUTDIR, "messages.js")).href
		)) as Record<string, Message>;
		await useLocale(audio, "en");
		resolveKey = await builtResolver(compiled);
	}, 60_000);

	it("renders every listed key exactly as the compiled catalog does, in every locale", async () => {
		const listed = readFederationCatalogKeys();
		const problems: string[] = [];
		let frozen = 0;
		for (const locale of ALL_LOCALES) {
			await useLocale(audio, locale);
			const params = readOracleParams(locale);
			const oracle = readRenderedOracle(locale) as Record<string, unknown>;
			for (const key of listed) {
				const reference = compiled[key];
				if (typeof reference !== "function") {
					problems.push(`${key}: not in the compiled catalog`);
					continue;
				}
				const inputs = inputSets(key, params);
				const rendered = inputs.map((input) => resolveKey(key, input));
				const expected = inputs.map((input) => reference(input, { locale }));
				if (JSON.stringify(rendered) !== JSON.stringify(expected)) {
					problems.push(`${locale}:${key}: ${JSON.stringify(rendered)} != ${JSON.stringify(expected)}`);
				}
				const fixture = oracle[key];
				if (typeof fixture === "string" && inputs.length === 1) {
					frozen += 1;
					if (rendered[0] !== fixture) problems.push(`${locale}:${key}: differs from the frozen copy`);
				}
			}
		}
		await useLocale(audio, "en");
		expect(problems.slice(0, 20)).toEqual([]);
		expect(frozen).toBeGreaterThan(0);
	}, 60_000);

	it("echoes every unlisted key of the registered namespaces, so the pruning is real", async () => {
		const listed = new Set(readFederationCatalogKeys());
		const namespaces = new Set([...listed].map((key) => key.slice(0, key.indexOf("."))));
		const unlisted = readCatalogKeys().filter(
			(key) => namespaces.has(key.slice(0, key.indexOf("."))) && !listed.has(key),
		);
		expect(unlisted.length).toBeGreaterThan(0);
		expect(unlisted.filter((key) => resolveKey(key) !== key).slice(0, 20)).toEqual([]);
	}, 60_000);
});
