import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer | undefined;
let cacheDir: string | undefined;
let origin: string;

test.describe.configure({ mode: 'default' });

test.beforeAll(async () => {
	const frontendRoot = resolve(import.meta.dirname, '../..');
	cacheDir = await mkdtemp(join(tmpdir(), 'ceraui-idle-component-'));
	server = await createServer({
		root: frontendRoot,
		configFile: resolve(frontendRoot, 'vite.config.ts'),
		cacheDir,
		server: { host: '127.0.0.1', port: 0, hmr: false },
		plugins: [{
			name: 'connected-idle-component-fixture',
			configureServer(vite) {
				vite.middlewares.use((request, response, next) => {
					if (request.url !== '/__connected-idle-component.html') {
						next();
						return;
					}
					const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head><body>
						<div id="fixture"></div><script type="module">
						import { mount } from 'svelte';
						import { ensureNamespace, initLocale } from '@ceraui/i18n/svelte';
						import Harness from '/src/tests/fixtures/ConnectedIdleHarness.svelte';
						initLocale({ saved: 'en' });
						await ensureNamespace('network');
						await ensureNamespace('units');
						mount(Harness, { target: document.getElementById('fixture') });
						</script></body></html>`;
					void vite.transformIndexHtml(request.url, html).then((rendered) => {
						response.setHeader('Content-Type', 'text/html');
						response.end(rendered);
					}, next);
				});
			},
		}],
	});
	await server.listen();
	const address = server.httpServer?.address();
	if (!address || typeof address === 'string') throw new Error('Component HTTP listener missing');
	origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
	try {
		await server?.close();
	} finally {
		if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
	}
});

test('quiet bonded link notice opens details and clears on recovery', async ({ page }) => {
	await page.goto(`${origin}/__connected-idle-component.html`);
	const notice = page.getByTestId('connected-idle-notice');
	await expect(notice).toHaveCount(0);
	for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Next quiet sample' }).click();
	await expect(notice).toBeVisible();
	await expect(notice).toContainText('SIM 2');
	await expect(notice).toContainText('carries almost no stream traffic');
	await expect(notice).not.toContainText('can this network reach');
	for (let i = 0; i < 110; i++) await page.getByRole('button', { name: 'Next quiet sample' }).click();
	await expect(notice).toBeVisible();
	await notice.locator('summary').click();
	await expect(notice.locator('p')).toBeVisible();
	await expect(notice).toContainText('still live on other links');
	await page.getByRole('button', { name: 'Resume traffic' }).click();
	await expect(notice).toHaveCount(0);
});
