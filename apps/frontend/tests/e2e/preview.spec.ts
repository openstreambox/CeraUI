import path from 'node:path';

import type { Page, WebSocketRoute } from '@playwright/test';

import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';

/**
 * PreviewCanvas honest states and a working dev preview.
 *
 * TIER DISCIPLINE (the load-bearing convention here): the preview delivery tier
 * is selected by the harness browser's WebCodecs support, so this spec BRANCHES
 * on it rather than asserting one path unconditionally:
 *
 *   • WebCodecs tier — asserts the canvas reaches `data-status="live"` decoding
 *     the REAL mock preview upstream on :9997 through the backend
 *     `/preview` proxy (real Annex-B H.264 access units, no stub decoder), and
 *     that the decoded pictures are painted onto the canvas and keep advancing.
 *     Playwright's Chromium (Chrome for Testing and its headless shell) decodes
 *     H.264, so this case runs unconditionally. A harness browser without H.264
 *     FAILS here with a named reason; it is never skipped.
 *   • MSE tier — a SEPARATE test deletes `window.VideoDecoder` in an init-script
 *     (before app boot) so the component selects the `<video>`/MSE fallback, then
 *     asserts the video element + compat badge render and the `tier:"mse"`
 *     handshake is sent. The mock serves WebCodecs framing only (documented in
 *     apps/backend/src/mocks/providers/preview.ts), so this proves MSE PATH
 *     SELECTION deterministically without a synthetic fMP4 media source.
 *
 * State attributes read: `data-tier` (webcodecs|mse|none) and `data-status`
 * (idle|connecting|reconnecting|waiting|live|unsupported|error) on the
 * `data-testid="preview"` section.
 */

const EVIDENCE_DIR = path.resolve(import.meta.dirname, '../../../../test-results');

const SERVER_CONFIG = {
	srtla_addr: '127.0.0.1',
	srtla_port: 5000,
	srt_streamid: 'e2e',
	max_br: 5000,
};

/** avc1.42c00d — baseline H.264, level 1.3; matches the mock preview fixture. */
const FIXTURE_CODEC = 'avc1.42c00d';

let pageWs: WebSocketRoute | null = null;

/**
 * Proxy the backend WS, force is_streaming:false so the idle Live DOM is stable.
 *
 * Single-origin preview proxy: PreviewCanvas mints a token over the RPC
 * socket, then dials the SAME backend origin at `/preview?token=…`, so the preview
 * socket matches THIS route too. With no `onPreview`, that leg proxies to the real
 * mock-preview upstream (the WebCodecs-tier decode path). The MSE-tier block passes
 * an `onPreview` to fake it in-page instead — the real upstream serves only
 * WebCodecs framing.
 */
async function routeBackend(
	page: Page,
	onPreview?: (ws: WebSocketRoute) => void,
): Promise<void> {
	await page.routeWebSocket(/:(3002|31\d\d|6173)/, (ws) => {
		if (onPreview && ws.url().includes('/preview')) {
			onPreview(ws);
			return;
		}
		pageWs = ws;
		const server = ws.connectToServer();
		ws.onMessage((m) => server.send(m));
		server.onMessage((m) => {
			const text = typeof m === 'string' ? m : m.toString();
			try {
				const frame = JSON.parse(text) as { status?: Record<string, unknown> };
				if (frame?.status?.is_streaming) {
					frame.status.is_streaming = false;
					ws.send(JSON.stringify(frame));
					return;
				}
			} catch {
				/* binary / non-JSON frame */
			}
			ws.send(m);
		});
	});
}

/** Inject a server config frame so the Live view leaves its empty state. */
function injectServerConfig(): void {
	pageWs?.send(JSON.stringify({ config: SERVER_CONFIG }));
}

/**
 * Reveal the "Preview" <details> disclosure so the preview section
 * (data-testid="preview") is visible. The disclosure is open by default from
 * 768 px and closed below; revealing it only REVEALS the surface — the preview
 * stays off (data-status="idle") until `preview-toggle` is clicked, so the tier
 * selection and honest off-copy are still observed exactly as before.
 */
async function openPreviewDisclosure(page: Page): Promise<void> {
	const disclosure = page.getByTestId('preview-disclosure');
	await expect(disclosure).toBeVisible();
	// Open by default from 768 px (Live screen contract), and a summary click
	// toggles a <details> — so reveal it only when it is closed.
	if (!(await disclosure.evaluate((el) => (el as HTMLDetailsElement).open))) {
		await disclosure.locator('summary').click();
	}
	await expect(page.getByTestId('preview')).toBeVisible();
}

async function webcodecsH264Supported(page: Page): Promise<boolean> {
	return page.evaluate(async (codec) => {
		const VD = (
			window as {
				VideoDecoder?: { isConfigSupported?: (c: unknown) => Promise<{ supported?: boolean }> };
			}
		).VideoDecoder;
		if (!VD || typeof VD.isConfigSupported !== 'function') return false;
		try {
			const result = await VD.isConfigSupported({ codec, codedWidth: 320, codedHeight: 180 });
			return result?.supported === true;
		} catch {
			return false;
		}
	}, FIXTURE_CODEC);
}

/**
 * Toggle the preview on and require the real decode to go live. `error` is the
 * component's decoder-failure state (a codec-config/bitstream mismatch lands
 * there), so it fails the case immediately instead of waiting out the timeout.
 */
async function toggleAndReachLive(page: Page): Promise<void> {
	expect(
		await webcodecsH264Supported(page),
		`harness Chromium must decode WebCodecs ${FIXTURE_CODEC} (Playwright's Chrome for Testing build does)`,
	).toBe(true);
	const preview = page.getByTestId('preview');
	await expect(preview).toHaveAttribute('data-tier', 'webcodecs');
	await page.getByTestId('preview-toggle').click();
	await expect
		.poll(() => preview.getAttribute('data-status'), { timeout: 20_000 })
		.toMatch(/^(live|error)$/);
	await expect(preview, 'the real H.264 decode must reach live, not error').toHaveAttribute(
		'data-status',
		'live',
	);
}

/**
 * Sample the painted canvas: its size, how many distinct colours a coarse grid
 * shows, and a cheap content hash. The fixture is ffmpeg's `testsrc2` pattern
 * (colour bars plus moving elements), so a painted picture is many-coloured and
 * changes between samples; a blank or frozen canvas is neither.
 */
async function sampleCanvas(
	page: Page,
): Promise<{ width: number; height: number; colours: number; hash: number }> {
	return page.getByTestId('preview-canvas').evaluate((el) => {
		const canvas = el as HTMLCanvasElement;
		const ctx = canvas.getContext('2d');
		if (!ctx || canvas.width === 0 || canvas.height === 0) {
			return { width: canvas.width, height: canvas.height, colours: 0, hash: 0 };
		}
		const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
		const colours = new Set<number>();
		let hash = 0;
		const stepX = Math.max(1, Math.floor(canvas.width / 32));
		const stepY = Math.max(1, Math.floor(canvas.height / 18));
		for (let y = 0; y < canvas.height; y += stepY) {
			for (let x = 0; x < canvas.width; x += stepX) {
				const i = (y * canvas.width + x) * 4;
				// Quantize to 3 bits per channel so codec noise does not inflate the count.
				const rgb = ((data[i] >> 5) << 6) | ((data[i + 1] >> 5) << 3) | (data[i + 2] >> 5);
				colours.add(rgb);
				hash = (Math.imul(hash, 31) + data[i] + data[i + 1] * 7 + data[i + 2] * 13) | 0;
			}
		}
		return { width: canvas.width, height: canvas.height, colours: colours.size, hash };
	});
}

test.describe('PreviewCanvas — WebCodecs tier + idle copy', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'WebCodecs is a Chromium proof');

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the Live column');
		pageWs = null;
		// WebCodecs-tier proof: neutralize RTCPeerConnection before app boot so the
		// tier ladder selects WebCodecs (matching the real mock upstream's
		// WebCodecs framing) instead of putting WebRTC on top.
		await page.addInitScript(() => {
			(window as { RTCPeerConnection?: unknown }).RTCPeerConnection = undefined;
		});
		await routeBackend(page);
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
		injectServerConfig();
		await openPreviewDisclosure(page);
	});

	test('idle toggle shows the honest "preview off" copy, not a stalled state', async ({
		page,
	}) => {
		const preview = page.getByTestId('preview');
		await expect(preview).toBeVisible();
		// Off by default: the calm off-copy is shown; no media surface, no dial.
		await expect(preview).toHaveAttribute('data-status', 'idle');
		await expect(page.getByTestId('preview-off')).toBeVisible();
		await expect(page.getByTestId('preview-off')).toContainText(/preview off/i);
		await expect(page.getByTestId('preview-canvas')).toBeHidden();
	});

	test('WebCodecs tier decodes the mock preview server to a live canvas', async ({ page }) => {
		await toggleAndReachLive(page);
		await expect(page.getByTestId('preview-canvas')).toBeVisible();

		// The decoded picture is painted at the fixture's coded size...
		const first = await sampleCanvas(page);
		expect(first.width).toBe(320);
		expect(first.height).toBe(180);
		expect(first.colours, 'a painted testsrc2 frame is many-coloured, not blank').toBeGreaterThan(8);
		// ...and later access units keep decoding: another painted picture, not
		// the same one and not a cleared canvas.
		await expect
			.poll(
				async () => {
					const next = await sampleCanvas(page);
					return (
						next.width === 320 &&
						next.height === 180 &&
						next.colours > 8 &&
						next.hash !== first.hash
					);
				},
				{ timeout: 10_000, message: 'later frames must paint a new picture' },
			)
			.toBe(true);
		await expect(page.getByTestId('preview')).toHaveAttribute('data-status', 'live');
	});

	test('@visual evidence: live decoded canvas', { tag: '@visual' }, async ({ page }) => {
		await toggleAndReachLive(page);
		await page
			.getByTestId('preview')
			.screenshot({ path: path.join(EVIDENCE_DIR, 'preview-webcodecs-live.png') });
	});
});

test.describe('PreviewCanvas — forced MSE tier', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'single-browser preview proof');

	let mseHandshakeTier: string | null = null;

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the Live column');
		pageWs = null;
		mseHandshakeTier = null;

		// Delete WebCodecs BEFORE the app boots so the component selects the MSE
		// (<video>) fallback tier at module-eval.
		await page.addInitScript(() => {
			// biome-ignore lint/performance/noDelete: force the MSE fallback path.
			delete (window as { VideoDecoder?: unknown }).VideoDecoder;
			// Also drop WebRTC so the tier ladder selects the MSE floor
			// rather than putting WebRTC on top of the mock's MSE codec-config.
			(window as { RTCPeerConnection?: unknown }).RTCPeerConnection = undefined;
		});
		// The real mock-preview upstream serves WebCodecs framing only, so fake the
		// `/preview` leg here to supply an MSE codec-config and capture the client's
		// start-handshake tier.
		await routeBackend(page, (ws) => {
			ws.onMessage((message) => {
				const text = typeof message === 'string' ? message : message.toString();
				let parsed: { action?: string; tier?: string };
				try {
					parsed = JSON.parse(text);
				} catch {
					return;
				}
				if (parsed?.action !== 'start') return;
				mseHandshakeTier = parsed.tier ?? null;
				ws.send(
					JSON.stringify({
						type: 'codec-config',
						tier: 'mse',
						mime: `video/mp4; codecs="${FIXTURE_CODEC}"`,
					}),
				);
			});
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
		injectServerConfig();
		await openPreviewDisclosure(page);
	});

	test('selects the <video> path, shows the compat badge, sends the mse handshake', async ({
		page,
	}) => {
		const preview = page.getByTestId('preview');
		await expect(preview).toHaveAttribute('data-tier', 'mse');

		await page.getByTestId('preview-toggle').click();

		// Deterministic, codec-independent MSE-path proof.
		await expect(page.getByTestId('preview-video')).toBeVisible();
		await expect(page.getByTestId('preview-compat')).toBeVisible();
		await expect
			.poll(() => mseHandshakeTier, { message: 'the client should hand-shake tier:"mse"' })
			.toBe('mse');
	});
});

/**
 * The preview surface must exist WHILE STREAMING.
 *
 * The engine attaches its MSE publisher during an active session (wave2 14e), but
 * the disclosure only ever lived in IdleCockpit, which LiveView unmounts the
 * instant a stream starts — so the shipped capability had no UI and the board QA
 * matrix recorded "streaming preview: NO UI SURFACE".
 *
 * The mirror of the idle harness: rewrite `is_streaming` to TRUE (instead of
 * false) so LiveView renders LiveCockpit, and assert the disclosure is there AND
 * still dials through the single-use-token proxy — the mid-stream mount must not
 * become a second, unauthenticated path to the engine.
 */
test.describe('PreviewCanvas — mid-stream surface', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'single-browser preview proof');

	let previewDialUrl: string | null = null;

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the Live column');
		pageWs = null;
		previewDialUrl = null;

		await page.addInitScript(() => {
			// biome-ignore lint/performance/noDelete: force the MSE fallback path.
			delete (window as { VideoDecoder?: unknown }).VideoDecoder;
			(window as { RTCPeerConnection?: unknown }).RTCPeerConnection = undefined;
		});

		await page.routeWebSocket(/:(3002|31\d\d|6173)/, (ws) => {
			if (ws.url().includes('/preview')) {
				previewDialUrl = ws.url();
				ws.onMessage((message) => {
					const text = typeof message === 'string' ? message : message.toString();
					try {
						if ((JSON.parse(text) as { action?: string })?.action !== 'start') return;
					} catch {
						return;
					}
					ws.send(
						JSON.stringify({
							type: 'codec-config',
							tier: 'mse',
							mime: `video/mp4; codecs="${FIXTURE_CODEC}"`,
						}),
					);
				});
				return;
			}
			pageWs = ws;
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				const text = typeof m === 'string' ? m : m.toString();
				try {
					const frame = JSON.parse(text) as { status?: Record<string, unknown> };
					if (frame?.status && 'is_streaming' in frame.status) {
						frame.status.is_streaming = true;
						ws.send(JSON.stringify(frame));
						return;
					}
				} catch {
					/* binary / non-JSON frame */
				}
				ws.send(m);
			});
		});

		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
		injectServerConfig();
	});

	test('the preview disclosure renders while streaming and still dials the token proxy', async ({
		page,
	}) => {
		// The stream is live, so the idle cockpit is gone...
		await expect(page.getByTestId('live-cockpit')).toBeVisible();
		await expect(page.getByTestId('idle-cockpit')).toBeHidden();

		// ...and the preview surface is nonetheless reachable (the wave2 14e gap).
		const disclosure = page.getByTestId('preview-disclosure');
		await expect(disclosure).toBeVisible();
		await expect(disclosure).toHaveAttribute('data-streaming', 'true');

		// Open by default from 768 px (Live screen contract), and a summary click
		// toggles a <details> — so reveal it only when it is closed.
		if (!(await disclosure.evaluate((el) => (el as HTMLDetailsElement).open))) {
			await disclosure.locator('summary').click();
		}
		const preview = page.getByTestId('preview');
		await expect(preview).toBeVisible();
		// Still OFF until the operator asks — opening only reveals the surface.
		await expect(preview).toHaveAttribute('data-status', 'idle');

		await page.getByTestId('preview-toggle').click();

		// Renders frames mid-stream, over the SAME authenticated proxy: a minted
		// single-use token on the backend origin, never a direct engine dial.
		await expect(page.getByTestId('preview-video')).toBeVisible();
		await expect.poll(() => previewDialUrl).toContain('/preview?token=');
		expect(new URL(previewDialUrl ?? '').searchParams.get('token')).toBeTruthy();
	});
});
