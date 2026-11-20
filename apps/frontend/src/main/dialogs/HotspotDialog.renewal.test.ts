// @vitest-environment jsdom
/**
 * New Wi-Fi password through the real hotspot dialog: once a renewal completes,
 * the editable password field holds the NEW password, so a later Save can never
 * put the revoked one back. Only that renewal's own attempt writes the field,
 * from an authoritative signal: the device's `hotspot.config` confirmation
 * (which also re-enables Save, so the field must not wait for the dispatch ack),
 * or live credentials on the same radio that already carry the new password. A
 * timeout writes it too, so a later Save completes the renewal. A dispatch ack
 * alone changes nothing, and the operator's own edit always wins. A renewal
 * whose dialog closed or rebound, or that another dispatch replaced, never
 * writes into the form.
 */
import type { WifiInterface } from "@ceraui/rpc/schemas";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
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
	clearOperation,
	destroyAsyncOperations,
	getOperationPhase,
	initAsyncOperations,
	timeoutOperation,
} from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";
import { noteLinkState } from "$lib/rpc/session-epoch.svelte";
import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";
import { wifiHotspotConfigOpKey } from "$main/network/wifi-station-lock";
import HotspotDialog from "./HotspotDialog.svelte";

const wire = vi.hoisted(() => ({
	message: (_type: string, _data: unknown) => {},
}));
vi.mock("$lib/rpc/client", () => ({
	rpc: {
		wifi: {
			hotspotPrepare: vi.fn(),
			hotspotStart: vi.fn(),
			hotspotStop: vi.fn(),
			hotspotConfigure: vi.fn(),
			getAdapterModes: vi.fn(async () => ({})),
			setAdapterMode: vi.fn(),
		},
	},
	rpcClient: {
		onMessage: (fn: typeof wire.message) => {
			wire.message = fn;
		},
		onConnectionChange: () => () => {},
		connect: () => {},
		getConnectionState: () => "connected",
		getSocket: () => undefined,
		sendLegacy: () => {},
	},
}));
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "") } }));
vi.mock("svelte-sonner", () => ({
	toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
const generated = vi.hoisted(() => ({ next: "renewed-pass-1" }));
vi.mock("$main/network/hotspot-password", async (original) => ({
	...(await original<typeof import("$main/network/hotspot-password")>()),
	generateHotspotPassword: () => generated.next,
}));

const configure = vi.mocked(rpc.wifi.hotspotConfigure);
type ConfigureResult = Awaited<ReturnType<typeof rpc.wifi.hotspotConfigure>>;

function row(
	incarnation = "radio-A",
	livePassword = "revoked-password",
): WifiInterface {
	return {
		ifname: "wlan0",
		hw: "same-model",
		conn: "ap-uuid",
		saved: {},
		supports_hotspot: true,
		incarnation,
		mode: "hotspot",
		hotspot: {
			name: `${incarnation}-box`,
			password: livePassword,
			channel: "auto",
			available_channels: {
				auto: { name: "Automatic" },
				ch_6: { name: "Channel 6" },
			},
			security: "wpa2",
		},
	};
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const flush = async () => {
	for (let i = 0; i < 4; i++) {
		await Promise.resolve();
		await tick();
	}
};

function nameField(): HTMLInputElement {
	const element = document.querySelector<HTMLInputElement>("#hotspot-name");
	if (!element) throw new Error("name field did not render");
	return element;
}

function passwordField(): HTMLInputElement {
	const element = document.querySelector<HTMLInputElement>("#hotspot-password");
	if (!element) throw new Error("password field did not render");
	return element;
}

/** The device's deferred reply to a reconfigure on `incarnation`. */
function confirmFrame(incarnation = "radio-A", success = true) {
	wire.message("wifi", {
		hotspot: {
			config: {
				device: "0",
				incarnation,
				success,
				...(success ? {} : { error: "failed" }),
			},
		},
	});
}

async function renew() {
	await fireEvent.click(
		screen.getByRole("button", { name: "New Wi-Fi password" }),
	);
	await fireEvent.click(
		screen.getByRole("button", { name: "Change the password" }),
	);
}

async function save() {
	await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
}

function open(incarnation = "radio-A") {
	wire.message("status", { wifi: { "0": row(incarnation) } });
	return render(HotspotDialog, {
		open: true,
		deviceId: "0",
		iface: row(incarnation),
	});
}

beforeAll(() => {
	window.matchMedia ??= vi.fn().mockImplementation((query: string) => ({
		matches: true,
		media: query,
		onchange: null,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}));
});
beforeEach(() => {
	vi.clearAllMocks();
	resetState();
	initAsyncOperations();
	initSubscriptions();
	noteLinkState("connected");
	generated.next = "renewed-pass-1";
	configure.mockResolvedValue({ success: true });
});
afterEach(() => {
	cleanup();
	destroyAsyncOperations();
	resetState();
});

describe("a completed renewal refreshes the editable password", () => {
	it("ack first, then confirmation: the form takes the new password", async () => {
		const ack = deferred<ConfigureResult>();
		configure.mockReturnValueOnce(ack.promise);
		open();
		await renew();
		expect(configure).toHaveBeenCalledWith(
			expect.objectContaining({
				device: "0",
				incarnation: "radio-A",
				password: "renewed-pass-1",
			}),
		);
		ack.resolve({ success: true });
		await flush();
		// Accepted for dispatch is not applied: the field waits for the device.
		expect(passwordField().value).toBe("revoked-password");
		confirmFrame();
		await flush();
		expect(passwordField().value).toBe("renewed-pass-1");

		await save();
		expect(configure).toHaveBeenLastCalledWith(
			expect.objectContaining({ password: "renewed-pass-1" }),
		);
	});

	it("confirmation first: the form takes the new password at once, before the ack", async () => {
		const ack = deferred<ConfigureResult>();
		configure.mockReturnValueOnce(ack.promise);
		open();
		await renew();
		confirmFrame();
		await flush();
		expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-A"))).toBe(
			"confirmed",
		);
		// The device applied this attempt: the field follows without the ack.
		expect(passwordField().value).toBe("renewed-pass-1");
		ack.resolve({ success: true });
		await flush();
		expect(passwordField().value).toBe("renewed-pass-1");
	});

	it("Save after the confirmation and before the ack never re-sends the revoked password", async () => {
		const ack = deferred<ConfigureResult>();
		configure.mockReturnValueOnce(ack.promise);
		const view = open();
		await renew();
		confirmFrame();
		// The same radio reports its live credentials, now with the new password.
		wire.message("status", {
			wifi: { "0": row("radio-A", "renewed-pass-1") },
		});
		await view.rerender({
			open: true,
			deviceId: "0",
			iface: row("radio-A", "renewed-pass-1"),
		});
		await flush();
		// Save is enabled again in this gap; change another setting and press it.
		await fireEvent.input(nameField(), { target: { value: "renamed-box" } });
		await save();
		expect(configure).toHaveBeenCalledTimes(2);
		expect(configure).toHaveBeenLastCalledWith(
			expect.objectContaining({
				name: "renamed-box",
				password: "renewed-pass-1",
			}),
		);
		expect(configure).not.toHaveBeenLastCalledWith(
			expect.objectContaining({ password: "revoked-password" }),
		);
		ack.resolve({ success: true });
		await flush();
		expect(passwordField().value).toBe("renewed-pass-1");
	});

	it("timed out with no live update: the field takes the new password, so Save completes the renewal", async () => {
		open();
		await renew();
		timeoutOperation(wifiHotspotConfigOpKey("0", "radio-A"));
		await flush();
		expect(passwordField().value).toBe("renewed-pass-1");
		await fireEvent.input(nameField(), { target: { value: "renamed-box" } });
		await save();
		expect(configure).toHaveBeenCalledTimes(2);
		expect(configure).toHaveBeenLastCalledWith(
			expect.objectContaining({
				name: "renamed-box",
				password: "renewed-pass-1",
			}),
		);
	});

	for (const signal of ["confirmation", "timeout", "live status"] as const) {
		it(`a password the operator types during the wait wins over the ${signal}`, async () => {
			const view = open();
			await renew();
			await fireEvent.input(passwordField(), {
				target: { value: "typed-password" },
			});
			if (signal === "confirmation") confirmFrame();
			if (signal === "timeout")
				timeoutOperation(wifiHotspotConfigOpKey("0", "radio-A"));
			if (signal === "live status") {
				wire.message("status", {
					wifi: { "0": row("radio-A", "renewed-pass-1") },
				});
				await view.rerender({
					open: true,
					deviceId: "0",
					iface: row("radio-A", "renewed-pass-1"),
				});
			}
			await flush();
			expect(passwordField().value).toBe("typed-password");
		});
	}

	it("a renewal replaced by another dispatch never writes the field, even from matching live credentials", async () => {
		const key = wifiHotspotConfigOpKey("0", "radio-A");
		const renewalAck = deferred<ConfigureResult>();
		configure.mockReturnValueOnce(renewalAck.promise);
		const view = open();
		await renew();
		// The renewal's op is released, and a Save takes the key over.
		clearOperation(key);
		await flush();
		await fireEvent.input(nameField(), { target: { value: "renamed-box" } });
		await save();
		expect(configure).toHaveBeenCalledTimes(2);
		expect(getOperationPhase(key)).toBe("pending");
		// A late status carries the old renewal's password: not this Save's.
		wire.message("status", {
			wifi: { "0": row("radio-A", "renewed-pass-1") },
		});
		await view.rerender({
			open: true,
			deviceId: "0",
			iface: row("radio-A", "renewed-pass-1"),
		});
		renewalAck.resolve({ success: true });
		await flush();
		expect(passwordField().value).toBe("revoked-password");
		confirmFrame();
		await flush();
		expect(passwordField().value).toBe("revoked-password");
	});

	it("a failed renewal leaves the form alone and is not applied by a later Save's confirmation", async () => {
		const ack = deferred<ConfigureResult>();
		configure.mockReturnValueOnce(ack.promise);
		open();
		await renew();
		ack.resolve({ success: true });
		await flush();
		confirmFrame("radio-A", false);
		await flush();
		expect(passwordField().value).toBe("revoked-password");

		await fireEvent.input(passwordField(), {
			target: { value: "typed-password" },
		});
		await save();
		confirmFrame();
		await flush();
		expect(passwordField().value).toBe("typed-password");
	});
});

describe("a renewal never writes into a form it no longer owns", () => {
	it("closed and reopened while the ack is pending: a later Save keeps the typed password", async () => {
		const ack = deferred<ConfigureResult>();
		configure.mockReturnValueOnce(ack.promise);
		const view = open();
		await renew();
		await view.rerender({ open: false, deviceId: "0", iface: row() });
		await view.rerender({ open: true, deviceId: "0", iface: row() });
		confirmFrame();
		ack.resolve({ success: true });
		await flush();
		// The reopened form loaded from the device, not from the old renewal.
		expect(passwordField().value).toBe("revoked-password");

		await fireEvent.input(passwordField(), {
			target: { value: "typed-password" },
		});
		await save();
		expect(configure).toHaveBeenLastCalledWith(
			expect.objectContaining({ password: "typed-password" }),
		);
		confirmFrame();
		await flush();
		expect(passwordField().value).toBe("typed-password");
	});

	it("rebound to another radio while the ack is pending: that radio's Save is not overwritten", async () => {
		const ack = deferred<ConfigureResult>();
		configure.mockReturnValueOnce(ack.promise);
		const view = open("radio-A");
		await renew();
		wire.message("status", { wifi: { "0": row("radio-B") } });
		await view.rerender({ open: true, deviceId: "0", iface: row("radio-B") });
		await flush();
		ack.resolve({ success: true });
		await flush();
		expect(passwordField().value).toBe("revoked-password");

		await fireEvent.input(passwordField(), {
			target: { value: "typed-for-b" },
		});
		await save();
		expect(configure).toHaveBeenLastCalledWith(
			expect.objectContaining({
				incarnation: "radio-B",
				password: "typed-for-b",
			}),
		);
		confirmFrame("radio-B");
		await flush();
		expect(passwordField().value).toBe("typed-for-b");
	});
});
