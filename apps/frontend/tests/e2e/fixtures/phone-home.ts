import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { persistPlugin } from 'svelte-persistent-runes/plugins';
import { build } from 'vite';
import { test as base } from './index.js';

export { expect } from './index.js';

type Bundle = { script: string; styles: string[] };

// Compile the presentation-only harness outside the shipped frontend. Pages use
// emitted JS/CSS under both Vite dev and production preview, never source URLs.
export const test = base.extend<{ phoneHomeBundle: void }, { phoneHomeAssets: Bundle }>({
	phoneHomeAssets: [
		async ({}, use) => {
			const outDir = await mkdtemp(join(tmpdir(), 'ceraui-phone-home-'));
			const root = resolve(import.meta.dirname, '../../..');
			try {
				await build({
					configFile: false,
					root,
					publicDir: false,
					define: { 'process.env.NODE_ENV': JSON.stringify('production') },
					plugins: [persistPlugin(), svelte({ compilerOptions: { dev: false } })],
					resolve: { alias: { $lib: resolve(root, 'src/lib'), $main: resolve(root, 'src/main') } },
					build: {
						outDir,
						emptyOutDir: true,
						lib: {
							entry: resolve(import.meta.dirname, 'phone-home-browser.ts'),
							name: 'PhoneHomeFixture',
							formats: ['iife'],
							fileName: () => 'fixture.js',
						},
					},
				});
				const files = await readdir(outDir);
				await use({
					script: await readFile(join(outDir, 'fixture.js'), 'utf8'),
					styles: await Promise.all(
						files
							.filter((file) => file.endsWith('.css'))
							.map((file) => readFile(join(outDir, file), 'utf8')),
					),
				});
			} finally {
				await rm(outDir, { recursive: true, force: true });
			}
		},
		{ scope: 'worker', timeout: 120_000 },
	],
	phoneHomeBundle: [
		async ({ page, phoneHomeAssets }, use) => {
			// An init script runs again after navigation; app and fixture keep independent
			// module graphs, just as the presentation harness did under the dev server.
			await page.addInitScript({
				content: `${phoneHomeAssets.script}\nwindow.PhoneHomeFixture = PhoneHomeFixture;`,
			});
			await page.route('**/__phone-home-fixture.css', (route) =>
				route.fulfill({ contentType: 'text/css', body: phoneHomeAssets.styles.join('\n') }),
			);
			await page.addInitScript(() => {
				document.addEventListener('DOMContentLoaded', () => {
					const link = document.createElement('link');
					link.rel = 'stylesheet';
					link.href = '/__phone-home-fixture.css';
					document.head.append(link);
				});
			});
			await use();
		},
		{ auto: true },
	],
});
