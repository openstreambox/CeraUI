/**
 * New Wi-Fi password changes ONLY the password of the live hotspot, through the
 * dialog's own bound config write (`{device, incarnation}`, keyed op, terminal
 * receipt), and never sends a partial setup or renews a stopped hotspot.
 */
import type { StatusResponse, WifiInterface } from "@ceraui/rpc/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hotspotConfigure = vi.hoisted(() =>
	vi.fn(async () => ({ success: true })),
);
vi.mock("$lib/rpc/client", () => ({
	rpc: { wifi: { hotspotConfigure } },
	rpcClient: {
		onConnectionChange: () => () => {},
		getConnectionState: () => "connected",
	},
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

import {
	confirmOperation,
	destroyAsyncOperations,
	failOperation,
	getOperationAttempt,
	getOperationPhase,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import { noteLinkState } from "$lib/rpc/session-epoch.svelte";
import { noteWifiConfig } from "$lib/rpc/wifi-status-receipt";

import {
	canRenewHotspotPassword,
	mayCarryStream,
	newHotspotPasswordInput,
	newHotspotPasswordKey,
	renewHotspotPassword,
} from "./hotspot-new-password";

function iface(overrides: Partial<WifiInterface> = {}): WifiInterface {
	return {
		ifname: "wlan0",
		conn: "hotspot-uuid",
		hw: "58:02:05:e1:79:1c",
		saved: {},
		mode: "hotspot",
		incarnation: "inc-1",
		hotspot: {
			name: "Box",
			password: "old-password",
			channel: "auto_50",
			security: "wpa2",
		},
		...overrides,
	} as WifiInterface;
}

beforeEach(() => {
	initAsyncOperations();
	// A fresh link, so no earlier test's dispatch can own this test's terminal.
	noteLinkState("disconnected");
	noteLinkState("connected");
});
afterEach(() => {
	destroyAsyncOperations();
	hotspotConfigure.mockClear();
});

describe("newHotspotPasswordInput", () => {
	it("keeps name, channel, security and binding; swaps the password", () => {
		expect(newHotspotPasswordInput("0", iface(), "n3wPassw0rd")).toEqual({
			device: "0",
			incarnation: "inc-1",
			name: "Box",
			password: "n3wPassw0rd",
			channel: "auto_50",
			security: "wpa2",
		});
	});

	it("omits security when the device stated none (keep the adapter's own)", () => {
		const input = newHotspotPasswordInput(
			"0",
			iface({ hotspot: { name: "Box", password: "x", channel: "auto" } }),
			"n3wPassw0rd",
		);
		expect(input).not.toHaveProperty("security");
	});

	it("sends nothing for a hotspot it cannot fully name", () => {
		for (const broken of [
			undefined,
			iface({ incarnation: undefined }),
			iface({ hotspot: { password: "x", channel: "auto" } }),
			iface({ hotspot: { name: "Box", password: "x" } }),
			// Stopped: no live AP to renew (a hotspot block means the AP is up).
			iface({ hotspot: undefined, mode: "station" }),
			iface({ degraded_reason: "permanent-mac-unresolved" }),
		]) {
			expect(
				newHotspotPasswordInput("0", broken, "n3wPassw0rd"),
			).toBeUndefined();
			expect(canRenewHotspotPassword("0", broken)).toBe(false);
		}
		expect(canRenewHotspotPassword("0", iface())).toBe(true);
	});
});

describe("mayCarryStream", () => {
	it("is true while the box streams or a link box carries or cannot say yet", () => {
		const status = (s: Partial<StatusResponse>) => s as StatusResponse;
		expect(mayCarryStream(undefined)).toBe(false);
		expect(mayCarryStream(status({ is_streaming: false }))).toBe(false);
		expect(mayCarryStream(status({ is_streaming: true }))).toBe(true);
		expect(
			mayCarryStream(status({ phone_box: true, carrying: { state: "idle" } })),
		).toBe(false);
		expect(
			mayCarryStream(
				status({ phone_box: true, carrying: { state: "streaming" } }),
			),
		).toBe(true);
		expect(
			mayCarryStream(
				status({ phone_box: true, carrying: { state: "unknown" } }),
			),
		).toBe(true);
		expect(mayCarryStream(status({ phone_box: true }))).toBe(true);
	});
});

/** The device's terminal `hotspot.config` frame, routed as the subscription layer does. */
function terminal(success: boolean, incarnation = "inc-1", error?: string) {
	const config = {
		device: "0",
		incarnation,
		success,
		...(error !== undefined ? { error } : {}),
	} as Parameters<typeof noteWifiConfig>[0];
	const owned = noteWifiConfig(config);
	const key = newHotspotPasswordKey("0", iface({ incarnation }));
	if (owned && success) confirmOperation(key);
	else if (owned && error !== "radio-changed")
		failOperation(key, error ?? "failed");
	return owned;
}

const flush = async () => {
	for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe("renewHotspotPassword", () => {
	it("dispatches one bound write under the dialog's Save key, pending until the device's terminal", async () => {
		const renewal = renewHotspotPassword("0", iface(), {
			generate: () => "fresh-password",
		});
		await flush();
		expect(hotspotConfigure).toHaveBeenCalledTimes(1);
		expect(hotspotConfigure).toHaveBeenCalledWith({
			device: "0",
			incarnation: "inc-1",
			name: "Box",
			password: "fresh-password",
			channel: "auto_50",
			security: "wpa2",
		});
		// The dispatch ack settles nothing: the device's terminal frame does.
		expect(getOperationPhase(newHotspotPasswordKey("0", iface()))).toBe(
			"pending",
		);
		// A second press while pending sends nothing.
		expect(
			await renewHotspotPassword("0", iface(), {
				generate: () => "another-password",
			}),
		).toBeUndefined();
		expect(hotspotConfigure).toHaveBeenCalledTimes(1);

		// The terminal is owned by this dispatch's receipt and confirms the op.
		expect(terminal(true)).toBe(true);
		expect(await renewal).toBe("fresh-password");
		expect(getOperationPhase(newHotspotPasswordKey("0", iface()))).toBe(
			"confirmed",
		);
	});

	it("a radio-changed terminal turns the accepted dispatch into a refusal", async () => {
		const renewal = renewHotspotPassword("0", iface(), {
			generate: () => "fresh-password",
		});
		await flush();
		terminal(false, "inc-1", "radio-changed");
		expect(await renewal).toBeUndefined();
		expect(getOperationPhase(newHotspotPasswordKey("0", iface()))).toBe(
			"failed",
		);
	});

	it("a terminal for another radio is not this renewal's", async () => {
		const renewal = renewHotspotPassword("0", iface(), {
			generate: () => "fresh-password",
		});
		await flush();
		terminal(true, "inc-other");
		expect(getOperationPhase(newHotspotPasswordKey("0", iface()))).toBe(
			"pending",
		);
		terminal(true);
		expect(await renewal).toBe("fresh-password");
	});

	it("sends nothing without a complete live hotspot", async () => {
		for (const broken of [
			iface({ incarnation: undefined }),
			iface({ hotspot: undefined, mode: "station" }),
		]) {
			expect(await renewHotspotPassword("0", broken)).toBeUndefined();
		}
		expect(hotspotConfigure).not.toHaveBeenCalled();
	});

	it("names its own attempt once the op has begun", async () => {
		const seen: Array<symbol | undefined> = [];
		const renewal = renewHotspotPassword("0", iface(), {
			generate: () => "fresh-password",
			onDispatch: (attempt) => seen.push(attempt),
		});
		await flush();
		const current = getOperationAttempt(newHotspotPasswordKey("0", iface()));
		expect(current).toBeTypeOf("symbol");
		expect(seen).toEqual([current]);
		terminal(true);
		await renewal;
	});

	it("reports nothing sent when the device refuses the dispatch", async () => {
		hotspotConfigure.mockResolvedValueOnce(
			JSON.parse('{"success":false,"error":"saving"}'),
		);
		expect(
			await renewHotspotPassword("0", iface(), {
				generate: () => "fresh-password",
			}),
		).toBeUndefined();
		expect(getOperationPhase(newHotspotPasswordKey("0", iface()))).toBe(
			"failed",
		);
	});

	it("an aborted wait releases the receipt without a terminal", async () => {
		const controller = new AbortController();
		const renewal = renewHotspotPassword("0", iface(), {
			generate: () => "fresh-password",
			signal: controller.signal,
		});
		await flush();
		controller.abort();
		// The accepted ack stands; the op stays pending for its own valve.
		expect(await renewal).toBe("fresh-password");
		expect(getOperationPhase(newHotspotPasswordKey("0", iface()))).toBe(
			"pending",
		);
	});
});
