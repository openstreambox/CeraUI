import type { Locator, Page, WebSocketRoute } from "@playwright/test";

import { type BackendRpc, expect, test } from "./fixtures/index.js";
import { isBackendSocket } from "./helpers/backend-socket.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * Bond-toggle reconnect harness, end to end at the backend boundary.
 *
 * `bond-toggle-flash.spec.ts` proves the toggle's display rules with the
 * configure RPC dropped and faked in the page. This spec keeps the real path:
 * every toggle goes through the app's control socket to this test's own mock
 * backend (`workerBackend`), and the backend's bond state is read back over a
 * separate authenticated socket (`backendRpc`). Only the transport is
 * controlled, from outside the app:
 *
 *   - `page.routeWebSocket` proxies the control socket, so a test can hold the
 *     backend's frames for one connection (a reply lost in flight) and close
 *     that connection;
 *   - an init script records each control-socket object the app creates, so a
 *     test can close the page's socket and later deliver a frame through the
 *     message handler the app installed on the replaced one (captured before
 *     the close; calling it is a late message event on the old socket).
 *
 * Reconnects are genuine: the old socket closes, the client's reconnect timer
 * opens a new one, re-authenticates, and the backend sends a fresh snapshot.
 * So the harness reconnects onto a really new socket while stale-socket
 * rejection stays covered.
 */

interface NetifEntry {
	enabled?: boolean;
	[key: string]: unknown;
}

type NetifMap = Record<string, NetifEntry>;

/** Records control-socket objects in creation order. Runs before app boot. */
function recordControlSockets(): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__ctlSockets) return;
	w.__ctlSockets = [] as WebSocket[];
	const Native = w.WebSocket as typeof WebSocket;
	class RecordedWebSocket extends Native {
		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols);
			if (new URL(String(url), location.href).pathname === "/ws") {
				w.__ctlSockets.push(this);
			}
		}
	}
	w.WebSocket = RecordedWebSocket;
}

/** One proxied control connection as the route sees it. */
interface ControlLink {
	readonly route: WebSocketRoute;
	/** `netif` frames the backend sent on this connection (held ones included). */
	netifFrames: number;
	/** While true, backend frames for this connection are dropped, not delivered. */
	holdServerFrames: boolean;
}

function isNetifFrame(message: string | Buffer): boolean {
	try {
		const frame: unknown = JSON.parse(typeof message === "string" ? message : message.toString());
		return typeof frame === "object" && frame !== null && Object.hasOwn(frame, "netif");
	} catch {
		return false;
	}
}

class ControlProxy {
	readonly links: ControlLink[] = [];

	async install(page: Page): Promise<void> {
		await page.routeWebSocket(
			(url) => isBackendSocket(url) && url.pathname === "/ws",
			(route) => {
				const link: ControlLink = { route, netifFrames: 0, holdServerFrames: false };
				this.links.push(link);
				const server = route.connectToServer();
				route.onMessage((message) => server.send(message));
				server.onMessage((message) => {
					if (isNetifFrame(message)) link.netifFrames += 1;
					if (link.holdServerFrames) return;
					route.send(message);
				});
				route.onClose(() => server.close());
				server.onClose(() => route.close());
			},
		);
	}

	get current(): ControlLink {
		const link = this.links.at(-1);
		if (!link) throw new Error("no control connection was routed");
		return link;
	}
}

async function backendNetif(rpc: BackendRpc, name: string): Promise<NetifEntry | undefined> {
	const netif = await rpc.call<NetifMap>(["network", "getInterfaces"]);
	return netif[name];
}

function backendEnabled(rpc: BackendRpc, name: string): Promise<boolean | undefined> {
	return backendNetif(rpc, name).then((entry) => entry?.enabled);
}

/** Number of control sockets the app has created so far. */
function socketCount(page: Page): Promise<number> {
	return page.evaluate(() => (window as any).__ctlSockets.length as number);
}

/** Wait until the app has opened control socket number `count` (1-based). */
async function waitForSocket(page: Page, count: number): Promise<void> {
	await expect
		.poll(
			() =>
				page.evaluate((n) => {
					const sockets = (window as any).__ctlSockets as WebSocket[];
					return sockets.length >= n && sockets[n - 1].readyState === WebSocket.OPEN;
				}, count),
			{ timeout: 15_000, message: `control socket ${count} must open` },
		)
		.toBe(true);
}

/** Yield two animation frames so queued socket events and renders settle. */
function flush(page: Page): Promise<void> {
	return page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
}

/** Record every aria-checked transition (old value) on `toggle`. */
async function observeAria(toggle: Locator): Promise<void> {
	await toggle.evaluate((el) => {
		const win = window as any;
		win.__ariaLog = [] as (string | null)[];
		new MutationObserver((records) => {
			for (const r of records) win.__ariaLog.push(r.oldValue);
		}).observe(el, { attributes: true, attributeFilter: ["aria-checked"], attributeOldValue: true });
	});
}

function ariaLog(page: Page): Promise<(string | null)[]> {
	return page.evaluate(() => (window as any).__ariaLog ?? []);
}

/** Every in-bond, enabled bond toggle and its interface name. */
async function inBondToggles(page: Page): Promise<{ toggle: Locator; name: string }[]> {
	const toggles = page.locator('[role="switch"][data-testid^="bond-toggle-"]');
	await expect(toggles.first()).toBeVisible({ timeout: 10_000 });
	const found: { toggle: Locator; name: string }[] = [];
	const count = await toggles.count();
	for (let i = 0; i < count; i++) {
		const candidate = toggles.nth(i);
		if ((await candidate.getAttribute("aria-checked")) !== "true") continue;
		if (!(await candidate.isEnabled())) continue;
		const testid = (await candidate.getAttribute("data-testid")) as string;
		found.push({ toggle: page.getByTestId(testid), name: testid.slice("bond-toggle-".length) });
	}
	return found;
}

async function firstInBondToggle(page: Page): Promise<{ toggle: Locator; name: string }> {
	const [first] = await inBondToggles(page);
	if (!first) throw new Error("the mock scenario must offer at least one in-bond interface");
	return first;
}

/** Change a link's bond membership from outside the page, as another client would. */
async function configureFromBackend(rpc: BackendRpc, name: string, enabled: boolean): Promise<void> {
	const entry = await backendNetif(rpc, name);
	const ip = typeof entry?.ip === "string" ? entry.ip : undefined;
	const result = await rpc.call<{ success: boolean }>(["network", "configure"], { name, ip, enabled });
	expect(result.success, `backend configure ${name} enabled=${enabled}`).toBe(true);
}

/** Wait for a toggle to settle: not busy, operable, showing `checked`. */
async function expectSettled(toggle: Locator, checked: boolean): Promise<void> {
	await expect(toggle).toHaveAttribute("aria-busy", "false");
	await expect(toggle).toBeEnabled();
	await expect(toggle).toHaveAttribute("aria-checked", String(checked));
}

test.describe("bond-toggle reconnect (real backend, genuine control-socket reconnect)", () => {
	test.skip(({ browserName }) => browserName !== "chromium", "single-browser behavioral proof");

	let proxy: ControlProxy;

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop layout drives the bond toggles");
		proxy = new ControlProxy();
		// Route first: Playwright's routing replaces `WebSocket` in the page, and
		// the recorder must wrap that replacement (the class the app constructs),
		// not the native class the routing keeps for its own pass-through.
		await proxy.install(page);
		await page.addInitScript(recordControlSockets);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
		// The recorder must see the same control sockets the route sees; if a
		// Playwright upgrade reorders the init scripts it would see none.
		expect(await socketCount(page), "recorded control sockets match routed ones").toBe(
			proxy.links.length,
		);
		expect(proxy.links.length).toBeGreaterThan(0);
	});

	test("a link leaves the bond, survives a reconnect, ignores the replaced socket and rejoins", async ({
		page,
		backendRpc,
	}) => {
		const links = await inBondToggles(page);
		expect(links.length, "need two in-bond links").toBeGreaterThanOrEqual(2);
		const [{ toggle, name }, other] = links;
		expect(await backendEnabled(backendRpc, name), "backend starts with the link in the bond").toBe(true);

		// Out of the bond through the real configure RPC.
		await observeAria(toggle);
		await toggle.click();
		await expectSettled(toggle, false);
		await expect.poll(() => backendEnabled(backendRpc, name)).toBe(false);

		// While this connection hears nothing, another client takes a second link
		// out of the bond. The page can only learn that over its next connection.
		const before = await socketCount(page);
		const linksBefore = proxy.links.length;
		proxy.current.holdServerFrames = true;
		await configureFromBackend(backendRpc, other.name, false);
		await flush(page);
		await expect(other.toggle, "held connection: the page has not heard yet").toHaveAttribute(
			"aria-checked",
			"true",
		);

		// Genuine reconnect: the page's socket closes, the client opens a new one,
		// re-authenticates and receives the backend's snapshot on it.
		await page.evaluate(() => {
			const w = window as any;
			const old = (w.__ctlSockets as WebSocket[]).at(-1) as WebSocket;
			w.__replacedSocket = { socket: old, onmessage: old.onmessage };
			old.close();
		});
		await waitForSocket(page, before + 1);
		expect(proxy.links.length).toBeGreaterThan(linksBefore);
		await expect(other.toggle, "the new connection's state reaches the UI").toHaveAttribute(
			"aria-checked",
			"false",
		);
		await expectSettled(toggle, false);
		expect(await ariaLog(page), "one ON to OFF transition, no flash across the reconnect").toEqual(["true"]);

		// A frame arriving on the replaced socket is stale and must be ignored, even
		// when it disagrees with the backend.
		const snapshot = await backendRpc.call<NetifMap>(["network", "getInterfaces"]);
		const stale = JSON.stringify({ netif: { ...snapshot, [name]: { ...snapshot[name], enabled: true } } });
		await page.evaluate((frame) => {
			const { socket, onmessage } = (window as any).__replacedSocket as {
				socket: WebSocket;
				onmessage: ((this: WebSocket, event: MessageEvent) => void) | null;
			};
			if (typeof onmessage !== "function") throw new Error("the app installed no message handler");
			onmessage.call(socket, new MessageEvent("message", { data: frame }));
		}, stale);
		for (let i = 0; i < 4; i++) {
			await flush(page);
			expect(
				await toggle.getAttribute("aria-checked"),
				"a netif frame on the replaced socket must not reach the UI",
			).toBe("false");
		}
		// Positive control: the same frame on the current socket does reach it.
		await page.evaluate((frame) => {
			const current = ((window as any).__ctlSockets as WebSocket[]).at(-1) as WebSocket;
			current.onmessage?.call(current, new MessageEvent("message", { data: frame }));
		}, stale);
		await expect(toggle, "the frame itself is one the UI applies").toHaveAttribute("aria-checked", "true");
		// The backend's next netif broadcast restores its truth.
		await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: 15_000 });

		// Back into the bond over the new socket.
		await toggle.click();
		await expectSettled(toggle, true);
		await expect.poll(() => backendEnabled(backendRpc, name)).toBe(true);
	});

	test("a configure reply lost in a reconnect: the toggle converges to what the backend applied", async ({
		page,
		backendRpc,
	}) => {
		const { toggle, name } = await firstInBondToggle(page);
		expect(await backendEnabled(backendRpc, name)).toBe(true);
		await observeAria(toggle);

		// The backend applies the change, but neither its reply nor its netif
		// broadcasts reach this connection.
		const before = await socketCount(page);
		const lossy = proxy.current;
		lossy.holdServerFrames = true;
		await toggle.click();
		await expect
			.poll(() => backendEnabled(backendRpc, name), { message: "the backend applied the removal" })
			.toBe(false);
		await expect(toggle).toHaveAttribute("aria-busy", "true");
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		// The connection drops with the request unanswered. The client rejects it,
		// reconnects, and must adopt the backend's state from the new connection,
		// not stay on its pre-click value.
		await lossy.route.close();
		await waitForSocket(page, before + 1);
		await expect
			.poll(() => proxy.current !== lossy && proxy.current.netifFrames > 0, {
				timeout: 15_000,
				message: "the new connection must deliver a fresh netif snapshot",
			})
			.toBe(true);
		await expectSettled(toggle, false);
		for (let i = 0; i < 6; i++) {
			await flush(page);
			expect(await toggle.getAttribute("aria-checked"), "no oscillation after convergence").toBe(
				"false",
			);
		}
		// The whole window, observed from the click (old values of aria-checked):
		// the optimistic OFF, then at most one revert to the last confirmed ON
		// before the new connection's OFF. Nothing else.
		const transitions = await ariaLog(page);
		console.log(`lost-reply aria-checked transitions: ${JSON.stringify(transitions)}`);
		expect([["true"], ["true", "false", "true"]]).toContainEqual(transitions);
		expect(await backendEnabled(backendRpc, name)).toBe(false);

		// The field lock released with the reset: a change made elsewhere flows in.
		await configureFromBackend(backendRpc, name, true);
		await expect(toggle, "an unlocked field follows the backend").toHaveAttribute("aria-checked", "true");
		await configureFromBackend(backendRpc, name, false);
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		// And the link rejoins normally from the page.
		await toggle.click();
		await expectSettled(toggle, true);
		await expect.poll(() => backendEnabled(backendRpc, name)).toBe(true);
	});
});
