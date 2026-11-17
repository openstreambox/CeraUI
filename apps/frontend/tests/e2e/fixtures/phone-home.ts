import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { persistPlugin } from "svelte-persistent-runes/plugins";
import { build } from "vite";
import { PARAGLIDE_OUTDIR, PARAGLIDE_STRATEGY } from "../../../vite.i18n.js";
import { PERSIST_RUNTIME_ALIAS } from "../../../vite.persist.js";
import { VARIANTS_ALIAS } from "../../../vite.variants.js";
import { test as base } from "./index.js";
import { assertPhoneHomeStrategy } from "./phone-home-strategy.js";

export { expect } from "./index.js";

type Bundle = { script: string; styles: string[] };

// Compile the presentation-only harness outside the shipped frontend. Pages use
// emitted JS/CSS under both Vite dev and production preview, never source URLs.
export const test = base.extend<
	{ loadPhoneHome: () => Promise<void> },
	{ phoneHomeAssets: Bundle }
>({
	phoneHomeAssets: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured dependency list.
		async ({}, use) => {
			const outDir = await mkdtemp(join(tmpdir(), "ceraui-phone-home-"));
			const root = resolve(import.meta.dirname, "../../..");
			try {
				await build({
					configFile: false,
					root,
					publicDir: false,
					define: { "process.env.NODE_ENV": JSON.stringify("production") },
					plugins: [
						{
							name: "phone-home-runtime-strategy",
							async load(id) {
								if (id !== join(PARAGLIDE_OUTDIR, "runtime.js")) return null;
								const source = await readFile(id, "utf8");
								assertPhoneHomeStrategy(source, PARAGLIDE_STRATEGY);
								return source;
							},
						},
						persistPlugin(),
						svelte({ compilerOptions: { dev: false } }),
					],
					resolve: {
						alias: [
							PERSIST_RUNTIME_ALIAS,
							VARIANTS_ALIAS,
							{ find: "$lib", replacement: resolve(root, "src/lib") },
							{ find: "$main", replacement: resolve(root, "src/main") },
						],
					},
					build: {
						outDir,
						emptyOutDir: true,
						lib: {
							entry: resolve(import.meta.dirname, "phone-home-browser.ts"),
							name: "PhoneHomeFixture",
							formats: ["iife"],
							fileName: () => "fixture.js",
						},
					},
				});
				const files = await readdir(outDir);
				await use({
					script: await readFile(join(outDir, "fixture.js"), "utf8"),
					styles: await Promise.all(
						files
							.filter((file) => file.endsWith(".css"))
							.map((file) => readFile(join(outDir, file), "utf8")),
					),
				});
			} finally {
				await rm(outDir, { recursive: true, force: true });
			}
		},
		{ scope: "worker", timeout: 120_000 },
	],
	// Requesting the loader builds assets, but does not execute them. Call only
	// after navigation and authentication, immediately before mounting. Unlike
	// Vite source imports, this bundle carries separate runtime module instances.
	loadPhoneHome: async ({ page, phoneHomeAssets }, use) => {
		await use(async () => {
			await page.addScriptTag({ content: phoneHomeAssets.script });
			for (const content of phoneHomeAssets.styles)
				await page.addStyleTag({ content });
		});
	},
});
