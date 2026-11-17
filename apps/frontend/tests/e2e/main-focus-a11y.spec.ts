import { errors, expect, type CDPSession, type Dialog, test } from '@playwright/test';

import { focusMainContent } from './helpers/focus-main-content.js';

for (const standIn of ['event', 'function', 'dialog', 'attachment-error', 'oversize', 'collector-pause'] as const) {
test(`a stalled main focus fails within its step budget and retains page state (${standIn}) @a11y @desktop-only`, async ({ page, browser }, testInfo) => {
	test.setTimeout(15_000);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.setContent(`
		<button id="previous">Previous focus</button>
		<main id="main-content" tabindex="-1" style="min-height: 100px">
			<div data-testid="live-cockpit">Live</div>
		</main>
		<div data-testid="live-bar" style="position: fixed; bottom: 0; left: 0; right: 0; height: 44px">Stop</div>
		<div role="dialog" hidden inert aria-hidden="true">Inactive overlay</div>
		<div data-boot-shell class="boot-shell" aria-busy="true" aria-live="polite" role="status"
			style="display: flex; position: fixed; inset: 0; z-index: 50"></div>
	`);
	await page.locator('#previous').focus();
	await page.locator('#main-content').evaluate((main) => {
		main.onfocus = function focusWitness() {
			main.setAttribute('data-focus-event', 'received');
		};
	});
	if (standIn === 'oversize') {
		await page.evaluate(() => {
			const canvas = document.createElement('canvas');
			canvas.width = canvas.height = 512;
			const context = canvas.getContext('2d');
			if (context === null) throw new Error('Missing canvas context');
			const image = context.createImageData(512, 512);
			let seed = 1;
			for (let i = 0; i < image.data.length; i += 4) {
				for (let channel = 0; channel < 3; channel++) {
					seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
					image.data[i + channel] = seed >>> 24;
				}
				image.data[i + 3] = 255;
			}
			context.putImageData(image, 0, 0);
			document.querySelector('[data-boot-shell]')?.append(canvas);
		});
	}

	const session = await page.context().newCDPSession(page);
	await session.send('Debugger.enable');
	let dialog: Dialog | undefined;
	let release: (() => Promise<unknown>) | undefined;
	if (standIn !== 'function' && standIn !== 'dialog') {
		// A public DOM-event breakpoint holds native focus inside its event dispatch, without a busy loop.
		await session.send('DOMDebugger.setEventListenerBreakpoint', { eventName: 'focus' });
		release = () => session.send('DOMDebugger.removeEventListenerBreakpoint', { eventName: 'focus' });
	} else if (standIn === 'function') {
		const { result } = await session.send('Runtime.evaluate', { expression: 'document.querySelector("#main-content").onfocus' });
		if (result.objectId === undefined) throw new Error('Missing focus listener object');
		const { breakpointId } = await session.send('Debugger.setBreakpointOnFunctionCall', { objectId: result.objectId });
		release = () => session.send('Debugger.removeBreakpoint', { breakpointId });
	} else {
		await page.locator('#main-content').evaluate((main) => {
			main.addEventListener('focus', () => alert('Focus diagnostic witness'), { once: true });
		});
	}
	const paused = new Promise<void>((resolve) => session.once('Debugger.paused', () => resolve()));
	const dialogOpened = new Promise<void>((resolve) => page.once('dialog', (opened) => { dialog = opened; resolve(); }));
	const context = page.context();
	const createPageSession = context.newCDPSession.bind(context);
	const createBrowserSession = browser.newBrowserCDPSession.bind(browser);
	const attach = testInfo.attach.bind(testInfo);
	const collectorSessions: CDPSession[] = [];
	context.newCDPSession = async (target) => {
		const created = await createPageSession(target);
		collectorSessions.push(created);
		if (standIn === 'collector-pause') {
			await release?.();
			release = undefined;
			await session.send('Debugger.resume');
			await page.evaluate(() => {
				requestAnimationFrame(function collectorPauseWitness() {
					if (document.documentElement.dataset.collectorPauseDone === 'true') return;
					requestAnimationFrame(collectorPauseWitness);
				});
			});
		}
		return created;
	};
	browser.newBrowserCDPSession = async () => {
		const created = await createBrowserSession();
		collectorSessions.push(created);
		return created;
	};
	if (standIn === 'attachment-error') {
		testInfo.attach = async (name, options) => {
			if (name === 'main-focus-cdp-screenshot') {
				const error = new Error('Controlled screenshot attachment failure');
				error.name = 'ScreenshotAttachmentWitnessError';
				throw error;
			}
			return attach(name, options);
		};
	}
	try {
		const focus = focusMainContent(page, 'live 1280x900 stalled-renderer witness');
		await (standIn === 'dialog' ? dialogOpened : paused);
		await expect(focus).rejects.toBeInstanceOf(errors.TimeoutError);
		await expect(focus).rejects.toThrow('locator.focus: Timeout 5000ms exceeded');
		await expect(focus).rejects.toThrow('JavaScript=timeout, animationFrame=timeout, pageState=timeout');
		const attachment = testInfo.attachments.find((item) => item.name === 'main-focus-state');
		if (attachment?.body === undefined) throw new Error('Missing main-focus-state diagnostic attachment');
		const diagnostic: unknown = JSON.parse(attachment.body.toString('utf8'));
		expect(diagnostic).toMatchObject({
			configuration: 'live 1280x900 stalled-renderer witness',
			viewport: { width: 1280, height: 900 },
			focusTimeoutMs: 5_000,
			before: {
				status: 'ok',
				value: {
					readyState: 'complete',
					appMounted: null,
					viewport: { width: 1280, height: 900, scrollX: 0, scrollY: 0 },
					activeElement: { id: 'previous' },
					target: { connected: true, visible: true, tabindex: '-1', inert: false, ariaHidden: false },
					liveBar: { connected: true, visible: true, testId: 'live-bar' },
					bootShell: {
						name: 'boot-shell',
						present: true,
						inHitTestStack: true,
						element: {
							name: 'boot-shell', tag: 'DIV', role: 'status',
							connected: true, visible: true, hidden: false, inert: false, ariaHidden: false,
							display: 'flex', position: 'fixed', zIndex: '50',
							rect: { x: 0, y: 0, width: 1280, height: 900 },
						},
					},
					ancestors: expect.arrayContaining([expect.objectContaining({ tag: 'BODY', connected: true })]),
					hitTestPoint: { x: expect.any(Number), y: expect.any(Number) },
					elementsAtPoint: expect.arrayContaining([
						expect.objectContaining({ id: 'main-content' }),
						expect.objectContaining({ name: 'boot-shell' }),
					]),
					cockpit: 'live-cockpit',
					surfaces: [
						{ tag: 'DIV', role: 'dialog', visible: false, hidden: true, inert: true, ariaHidden: true, display: 'none', position: 'static', zIndex: 'auto' },
						{ name: 'boot-shell', tag: 'DIV', role: 'status', visible: true },
					],
				},
			},
			liveness: {
				javascript: { status: 'timeout', error: expect.stringContaining('1000ms') },
				animationFrame: { status: 'timeout', error: expect.stringContaining('1000ms') },
			},
			after: { status: 'timeout', error: expect.stringContaining('1000ms') },
		});
		expect(diagnostic).toMatchObject({
			outOfPage: {
				status: 'ok',
				budgetMs: 2_500,
				rendererMatch: standIn === 'dialog' ? {
					status: expect.stringMatching(/^(ok|timeout|error)$/),
				} : {
					status: 'ok',
					value: { frameId: expect.any(String), rendererPid: expect.any(Number) },
				},
				processSamples: [0, 1].map(() => ({
					status: 'ok',
					value: {
						elapsedMs: expect.any(Number),
						processes: expect.arrayContaining([
							expect.objectContaining({
								pid: expect.any(Number), type: 'browser', cpuTimeSeconds: expect.any(Number), pageRenderer: false,
								threads: process.platform === 'linux' ? {
									status: 'ok',
									value: expect.arrayContaining([expect.objectContaining({
										tid: expect.any(Number),
										stat: { status: 'ok', value: { state: expect.stringMatching(/^[RSDZTtXxKWPI]$/), userTicks: expect.any(Number), systemTicks: expect.any(Number) } },
									})]),
								} : { status: 'error' },
							}),
							expect.objectContaining({
								pid: expect.any(Number), type: 'renderer', cpuTimeSeconds: expect.any(Number),
								pageRenderer: standIn === 'dialog' ? expect.any(Boolean) : true,
								threads: process.platform === 'linux' ? {
									status: 'ok',
									value: expect.arrayContaining([expect.objectContaining({
										tid: expect.any(Number),
										stat: { status: 'ok', value: { state: expect.stringMatching(/^[RSDZTtXxKWPI]$/), userTicks: expect.any(Number), systemTicks: expect.any(Number) } },
									})]),
								} : { status: 'error' },
							}),
						]),
					},
				})),
				debugger: standIn === 'dialog'
					? { status: 'timeout' }
					: { status: 'ok', value: { reason: expect.any(String), callFrames: expect.any(Array) } },
				cpuInterval: {
					intervalMs: expect.any(Number),
					calculation: 'second.elapsedMs - first.elapsedMs',
					order: 'consecutive process samples before Debugger.enable and Debugger.pause',
					collectorPauseOverlapMs: 0,
				},
				cleanup: expect.arrayContaining([
					expect.objectContaining({
						kind: 'page',
						detach: expect.objectContaining({
							status: standIn === 'dialog' ? expect.stringMatching(/^(ok|timeout)$/) : 'ok',
						}),
					}),
					expect.objectContaining({ kind: 'browser', detach: { status: 'ok' } }),
				]),
			},
		});
		const png = testInfo.attachments.find((item) => item.name === 'main-focus-cdp-screenshot');
		if (standIn === 'attachment-error') {
			expect(png).toBeUndefined();
			expect(diagnostic).toMatchObject({
				outOfPage: {
					screenshot: {
						status: 'error', error: 'ScreenshotAttachmentWitnessError',
						capture: { status: 'ok', bytes: expect.any(Number), limitBytes: 262_144 },
						attachment: { status: 'error', error: 'ScreenshotAttachmentWitnessError' },
					},
				},
			});
		} else if (standIn === 'oversize') {
			expect(png).toBeUndefined();
			expect(diagnostic).toMatchObject({
				outOfPage: {
					screenshot: {
						status: 'truncated', truncated: true, originalBytes: expect.any(Number),
						bytes: 0, limitBytes: 262_144,
					},
				},
			});
		} else if (standIn === 'dialog') {
			expect(diagnostic).toMatchObject({
				outOfPage: { screenshot: { status: expect.stringMatching(/^(ok|timeout|error)$/) } },
			});
		} else {
			expect(png?.body).toBeDefined();
		}
		if (png?.body !== undefined) {
			expect(png.contentType).toBe('image/png');
			expect([...png.body.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
			expect(png.body.length).toBeLessThanOrEqual(262_144);
			expect(diagnostic).toMatchObject({
				outOfPage: { screenshot: { status: 'ok', attachment: 'main-focus-cdp-screenshot', bytes: png.body.length } },
			});
		}
		if (standIn === 'function' || standIn === 'collector-pause') {
			expect(diagnostic).toMatchObject({
				outOfPage: {
					debugger: {
						value: {
							callFrames: expect.arrayContaining([expect.objectContaining({
								functionName: standIn === 'collector-pause' ? 'collectorPauseWitness' : 'focusWitness',
								url: expect.any(String),
								scriptId: expect.any(String),
								lineNumber: expect.any(Number),
								columnNumber: expect.any(Number),
							})]),
						},
					},
				},
			});
		}
		if (standIn === 'collector-pause') {
			expect(diagnostic).toMatchObject({
				outOfPage: { debugger: { value: { pauseRequested: true } } },
			});
		}
		// Prove collector cleanup before the observer's teardown can resume anything.
		const modalReleasedBeforeProof = dialog !== undefined;
		if (dialog !== undefined) {
			await dialog.dismiss();
			dialog = undefined;
		}
		expect(collectorSessions).toHaveLength(2);
		for (const collected of collectorSessions) {
			await expect.poll(async () => {
				try {
					await collected.send('Target.getTargetInfo', {}, { timeout: 250 });
					return 'open';
				} catch (error) {
					if (error instanceof Error && /Session closed|Target page, context or browser has been closed/.test(error.message)) return 'closed';
					throw error;
				}
			}, { timeout: 1_000 }).toBe('closed');
		}
		await expect(page.locator('#main-content')).toHaveAttribute('data-focus-event', 'received', { timeout: 1_000 });
		await test.step('Renderer answers before observer cleanup', () => page.evaluate(() => {
			document.documentElement.dataset.collectorPauseDone = 'true';
		}), { timeout: 1_000 });
		await test.step('Attach independent collector cleanup proof', () => testInfo.attach('main-focus-cleanup-witness', {
			body: JSON.stringify({
				closedCollectorSessions: collectorSessions.length,
				rendererAnsweredBeforeObserverCleanup: true,
				modalReleasedBeforeProof,
			}),
			contentType: 'application/json',
		}), { timeout: 1_000 });
	} finally {
		context.newCDPSession = createPageSession;
		browser.newBrowserCDPSession = createBrowserSession;
		testInfo.attach = attach;
		if (!page.isClosed()) {
			await release?.();
			if (dialog !== undefined) await dialog.dismiss();
			// Disabling the observer is safe both before and after the diagnostic resumes.
			await session.send('Debugger.disable');
			await session.detach();
		}
	}
	await expect(page.locator('#main-content')).toHaveAttribute('data-focus-event', 'received');
});
}
