// @vitest-environment jsdom
/**
 * RemoteAccessDialog: remote access over Tailscale, asserted on the rendered
 * DOM because each of these is a claim made to the owner:
 *
 *   1. Every device state reads in plain words, and "connected" names the device.
 *   2. The off switch is pessimistic: it shows the device's state, never the click.
 *   3. A pasted key is sent once, and the field is empty before the answer arrives.
 *   4. Forget takes two clicks.
 *   5. Refusals while streaming or updating explain themselves.
 *   6. There is no login link anywhere.
 */
import { m } from "@ceraui/i18n/svelte";
import type { TailscaleStatus } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	destroyAsyncOperations,
	initAsyncOperations,
} from "../../lib/rpc/async-operation.svelte.js";
import {
	publishTailscale,
	resetTailscaleFeed,
} from "../../tests/helpers/tailscale-feed.svelte.js";
import RemoteAccessDialog from "./RemoteAccessDialog.svelte";
import { formatExpiryDate } from "./remote-access-expiry";

const DAY = 24 * 60 * 60 * 1000;

const tailscaleJoin = vi.hoisted(() => vi.fn());
const tailscaleSetEnabled = vi.hoisted(() => vi.fn());
const tailscaleLogout = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

const KEY = "tskey-auth-kTEST0000CNTRL-0123456789abcdef";

vi.mock("$lib/rpc/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/rpc/client")>()),
	rpc: { system: { tailscaleJoin, tailscaleSetEnabled, tailscaleLogout } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const { getTailscaleFeed } = await import(
		"../../tests/helpers/tailscale-feed.svelte.js"
	);
	return { getTailscale: getTailscaleFeed };
});

vi.mock("svelte-sonner", () => ({
	toast: { error: toastError, success: vi.fn() },
}));

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
	if (!window.HTMLElement.prototype.hasPointerCapture) {
		window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
	}
	initAsyncOperations();
});

beforeEach(() => {
	for (const fn of [tailscaleJoin, tailscaleSetEnabled, tailscaleLogout]) {
		fn.mockReset();
		fn.mockResolvedValue({ success: true });
	}
	toastError.mockReset();
	resetTailscaleFeed();
});

afterEach(() => {
	destroyAsyncOperations();
	initAsyncOperations();
});

async function open(status: TailscaleStatus) {
	publishTailscale(status);
	render(RemoteAccessDialog, { props: { open: true } });
	await waitFor(() => {
		expect(screen.getByTestId("remote-access-status")).toBeTruthy();
	});
}

const stateText = () => screen.getByTestId("remote-access-state").textContent;
const switchEl = () => screen.getByTestId("remote-access-switch");

describe("states", () => {
	it("connected names the device and its address", async () => {
		await open({
			state: "connected",
			hostname: "studio-box",
			address: "100.64.0.9",
		});
		expect(stateText()).toContain(m["advanced.remoteAccess.stateConnected"]());
		expect(screen.getByTestId("remote-access-hostname").textContent).toContain(
			m["advanced.remoteAccess.connectedAs"]({ hostname: "studio-box" }),
		);
		expect(document.body.textContent).toContain("100.64.0.9");
		expect(switchEl().getAttribute("aria-checked")).toBe("true");
		expect(screen.queryByTestId("remote-access-join")).toBeNull();
	});

	it("connected names the network and says the login does not expire", async () => {
		await open({
			state: "connected",
			hostname: "studio-box",
			address: "100.64.0.9",
			tailnet: "tail1234.ts.net",
		});
		expect(screen.getByTestId("remote-access-tailnet").textContent).toContain(
			m["advanced.remoteAccess.network"]({ tailnet: "tail1234.ts.net" }),
		);
		const expiry = screen.getByTestId("remote-access-expiry");
		expect(expiry.dataset.expiry).toBe("never");
		expect(expiry.textContent).toContain(
			m["advanced.remoteAccess.keyNoExpiry"](),
		);
	});

	it("a login that lasts a while shows its date quietly", async () => {
		const at = new Date(Date.now() + 90 * DAY);
		await open({
			state: "connected",
			hostname: "studio-box",
			keyExpiry: at.toISOString(),
		});
		const expiry = screen.getByTestId("remote-access-expiry");
		expect(expiry.dataset.expiry).toBe("later");
		expect(expiry.getAttribute("role")).toBeNull();
		expect(expiry.textContent).toContain(
			m["advanced.remoteAccess.keyExpires"]({
				date: formatExpiryDate(at, "en"),
			}),
		);
	});

	it("a login that expires within 30 days warns and says how to keep it", async () => {
		const at = new Date(Date.now() + 10 * DAY);
		await open({
			state: "connected",
			hostname: "studio-box",
			keyExpiry: at.toISOString(),
		});
		const expiry = screen.getByTestId("remote-access-expiry");
		expect(expiry.dataset.expiry).toBe("soon");
		expect(expiry.getAttribute("role")).toBe("status");
		expect(expiry.textContent).toContain(
			m["advanced.remoteAccess.keyExpiresSoon"]({
				date: formatExpiryDate(at, "en"),
			}),
		);
		expect(stateText()).toContain(m["advanced.remoteAccess.stateConnected"]());
	});

	it("an expired login reads Expired, names its network and offers the key field", async () => {
		const at = new Date(Date.now() - 2 * DAY);
		await open({
			state: "needs_key",
			tailnet: "tail1234.ts.net",
			keyExpiry: at.toISOString(),
		});
		expect(stateText()).toContain(m["advanced.remoteAccess.stateExpired"]());
		const expiry = screen.getByTestId("remote-access-expiry");
		expect(expiry.dataset.expiry).toBe("expired");
		expect(expiry.textContent).toContain(
			m["advanced.remoteAccess.keyExpired"]({
				date: formatExpiryDate(at, "en"),
			}),
		);
		expect(expiry.textContent).toContain("tail1234.ts.net");
		expect(screen.getByTestId("remote-access-join")).toBeTruthy();
	});

	it("a device without a login shows no expiry or network", async () => {
		await open({ state: "needs_key" });
		expect(stateText()).toContain(m["advanced.remoteAccess.stateNeedsKey"]());
		expect(screen.queryByTestId("remote-access-expiry")).toBeNull();
		expect(screen.queryByTestId("remote-access-tailnet")).toBeNull();
	});

	it("off says so, and the switch is off", async () => {
		await open({ state: "off" });
		expect(stateText()).toContain(m["advanced.remoteAccess.stateOff"]());
		expect(screen.getByTestId("remote-access-body").textContent).toContain(
			m["advanced.remoteAccess.offBody"](),
		);
		expect(switchEl().getAttribute("aria-checked")).toBe("false");
		expect(screen.queryByTestId("remote-access-forget")).toBeNull();
	});

	for (const [state, label, body] of [
		["needs_key", "stateNeedsKey", "needsKeyBody"],
		["needs_approval", "stateNeedsApproval", "needsApprovalBody"],
		["joining", "stateJoining", "joiningBody"],
		["unknown", "stateUnknown", "unknownBody"],
	] as const) {
		it(`${state} reads in plain words`, async () => {
			await open({ state });
			expect(stateText()).toContain(m[`advanced.remoteAccess.${label}`]());
			expect(document.body.textContent).toContain(
				m[`advanced.remoteAccess.${body}`](),
			);
		});
	}

	it("offers no login link or QR code in any state", async () => {
		for (const state of [
			"off",
			"needs_key",
			"needs_approval",
			"joining",
			"connected",
			"unknown",
		] as const) {
			publishTailscale({ state });
			const { unmount } = render(RemoteAccessDialog, {
				props: { open: true },
			});
			await waitFor(() => screen.getByTestId("remote-access-status"));
			expect(document.querySelector("a[href]")).toBeNull();
			expect(document.querySelector("canvas, img[alt*='QR' i]")).toBeNull();
			unmount();
		}
	});
});

describe("off switch", () => {
	it("asks before turning off, and says the session over Tailscale ends", async () => {
		await open({ state: "connected", hostname: "box" });
		await fireEvent.click(switchEl());
		expect(tailscaleSetEnabled).not.toHaveBeenCalled();
		// Still on: the switch shows the device, not the click.
		expect(switchEl().getAttribute("aria-checked")).toBe("true");
		expect(
			screen.getByTestId("remote-access-off-confirm").textContent,
		).toContain(m["advanced.remoteAccess.offHint"]());
		expect(m["advanced.remoteAccess.offHint"]()).toContain(
			"Tailscale, you'll lose it",
		);
	});

	it("Keep it on backs out without a request", async () => {
		await open({ state: "connected", hostname: "box" });
		await fireEvent.click(switchEl());
		await fireEvent.click(screen.getByTestId("remote-access-off-cancel"));
		expect(screen.queryByTestId("remote-access-off-confirm")).toBeNull();
		expect(switchEl().getAttribute("aria-checked")).toBe("true");
		expect(tailscaleSetEnabled).not.toHaveBeenCalled();
	});

	it("turning off sends enabled:false after the confirm and waits for the device", async () => {
		const reply = Promise.withResolvers<{ success: boolean }>();
		tailscaleSetEnabled.mockReturnValue(reply.promise);
		await open({ state: "connected", hostname: "box" });
		await fireEvent.click(switchEl());
		await fireEvent.click(screen.getByTestId("remote-access-off-yes"));
		expect(tailscaleSetEnabled).toHaveBeenCalledWith({ enabled: false });
		// Pessimistic: still on until the device reports off.
		expect(switchEl().getAttribute("aria-checked")).toBe("true");
		reply.resolve({ success: true });
		publishTailscale({ state: "off" });
		await waitFor(() =>
			expect(switchEl().getAttribute("aria-checked")).toBe("false"),
		);
	});

	it("turning on needs no confirm and sends enabled:true", async () => {
		await open({ state: "off" });
		await fireEvent.click(switchEl());
		expect(tailscaleSetEnabled).toHaveBeenCalledWith({ enabled: true });
	});

	for (const reason of [
		"streaming",
		"stream_liveness_unknown",
		"update_in_progress",
	]) {
		it(`explains a ${reason} refusal`, async () => {
			tailscaleSetEnabled.mockResolvedValue({ success: false, error: reason });
			await open({ state: "off" });
			await fireEvent.click(switchEl());
			await waitFor(() =>
				expect(toastError).toHaveBeenCalledWith(
					m["notifications.disruptiveActionRefused"](),
				),
			);
		});
	}

	it("announces state changes", async () => {
		await open({ state: "off" });
		const status = screen.getByTestId("remote-access-status");
		expect(status.getAttribute("role")).toBe("status");
		expect(status.getAttribute("aria-live")).toBe("polite");
	});
});

describe("join", () => {
	it("sends the trimmed key once and clears the field before the answer", async () => {
		const reply = Promise.withResolvers<{ success: boolean }>();
		tailscaleJoin.mockReturnValue(reply.promise);
		await open({ state: "needs_key" });
		const input = screen.getByTestId("remote-access-key") as HTMLInputElement;
		expect(input.type).toBe("password");
		expect(input.getAttribute("autocomplete")).toBe("off");
		await fireEvent.input(input, { target: { value: `  ${KEY}  ` } });
		await fireEvent.click(screen.getByTestId("remote-access-join-button"));
		expect(tailscaleJoin).toHaveBeenCalledTimes(1);
		expect(tailscaleJoin).toHaveBeenCalledWith({ authKey: KEY });
		await waitFor(() => expect(input.value).toBe(""));
		reply.resolve({ success: true });
	});

	it("keeps the join button disabled for text that is not a key", async () => {
		await open({ state: "needs_key" });
		const input = screen.getByTestId("remote-access-key");
		await fireEvent.input(input, {
			target: { value: "--advertise-exit-node" },
		});
		expect(screen.getByTestId("remote-access-key-hint").textContent).toContain(
			m["advanced.remoteAccess.keyInvalid"](),
		);
		expect(input.getAttribute("aria-invalid")).toBe("true");
		const button = screen.getByTestId(
			"remote-access-join-button",
		) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(tailscaleJoin).not.toHaveBeenCalled();
	});

	it("says plainly when the key did not work", async () => {
		tailscaleJoin.mockResolvedValue({ success: false });
		await open({ state: "needs_key" });
		await fireEvent.input(screen.getByTestId("remote-access-key"), {
			target: { value: KEY },
		});
		await fireEvent.click(screen.getByTestId("remote-access-join-button"));
		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith(
				m["advanced.remoteAccess.joinFailed"](),
			),
		);
		expect(JSON.stringify(toastError.mock.calls)).not.toContain(KEY);
	});
});

describe("degraded joins", () => {
	it("says when the network turned Tailscale SSH off, and how to get it back", async () => {
		await open({
			state: "connected",
			hostname: "studio-box",
			notice: "ssh_off_by_tailnet",
		});
		const notice = screen.getByTestId("remote-access-notice");
		expect(notice.textContent).toContain(
			m["advanced.remoteAccess.noticeSshOff"](),
		);
		// The way back is on this card: Forget, then join with a new key.
		expect(screen.getByTestId("remote-access-forget")).toBeTruthy();
	});

	it("says when Tailscale's own updates are not switched off yet", async () => {
		await open({ state: "connected", notice: "updates_not_pinned" });
		expect(screen.getByTestId("remote-access-notice").textContent).toContain(
			m["advanced.remoteAccess.noticeUpdatesNotPinned"](),
		);
	});

	it("shows no notice on an ordinary connection", async () => {
		await open({ state: "connected", hostname: "studio-box" });
		expect(screen.queryByTestId("remote-access-notice")).toBeNull();
	});

	it("names a network without Tailscale SSH instead of blaming the key", async () => {
		tailscaleJoin.mockResolvedValue({
			success: false,
			error: "tailnet_ssh_not_allowed",
		});
		await open({ state: "needs_key" });
		await fireEvent.input(screen.getByTestId("remote-access-key"), {
			target: { value: KEY },
		});
		await fireEvent.click(screen.getByTestId("remote-access-join-button"));
		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith(
				m["advanced.remoteAccess.joinFailedTailnetSsh"](),
			),
		);
		expect(toastError).not.toHaveBeenCalledWith(
			m["advanced.remoteAccess.joinFailed"](),
		);
	});
});

describe("forget", () => {
	it("asks once more, and Keep it cancels", async () => {
		await open({ state: "connected", hostname: "box" });
		await fireEvent.click(screen.getByTestId("remote-access-forget"));
		expect(tailscaleLogout).not.toHaveBeenCalled();
		expect(
			screen.getByTestId("remote-access-forget-confirm").textContent,
		).toContain(m["advanced.remoteAccess.forgetHint"]());
		await fireEvent.click(screen.getByTestId("remote-access-forget-cancel"));
		expect(screen.queryByTestId("remote-access-forget-confirm")).toBeNull();
		expect(tailscaleLogout).not.toHaveBeenCalled();
	});

	it("warns that a session over Tailscale ends", async () => {
		await open({ state: "connected", hostname: "box" });
		await fireEvent.click(screen.getByTestId("remote-access-forget"));
		expect(m["advanced.remoteAccess.forgetHint"]()).toContain(
			"Tailscale, you'll lose it",
		);
	});

	it("logs out after the second click", async () => {
		await open({ state: "connected", hostname: "box" });
		await fireEvent.click(screen.getByTestId("remote-access-forget"));
		await fireEvent.click(screen.getByTestId("remote-access-forget-yes"));
		expect(tailscaleLogout).toHaveBeenCalledTimes(1);
	});
});
