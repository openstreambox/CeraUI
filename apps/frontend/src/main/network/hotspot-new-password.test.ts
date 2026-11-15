/**
 * New Wi-Fi password changes ONLY the password of the live hotspot, through the
 * dialog's own reconfigure and keyed op, and never sends a partial setup.
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
	destroyAsyncOperations,
	getOperationPhase,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";

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
		radio_identity: { id: "radio-1" },
		hotspot: {
			name: "Box",
			password: "old-password",
			channel: "auto_50",
			security: "wpa2",
		},
		...overrides,
	} as WifiInterface;
}

beforeEach(() => initAsyncOperations());
afterEach(() => {
	destroyAsyncOperations();
	hotspotConfigure.mockClear();
});

describe("newHotspotPasswordInput", () => {
	it("keeps name, channel, security and binding; swaps the password", () => {
		expect(newHotspotPasswordInput("0", iface(), "n3wPassw0rd")).toEqual({
			device: "0",
			incarnation: "inc-1",
			radio_id: "radio-1",
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

describe("renewHotspotPassword", () => {
	it("dispatches one reconfigure under the dialog's Save key and stays pending", async () => {
		const sent = await renewHotspotPassword(
			"0",
			iface(),
			() => "fresh-password",
		);
		expect(sent).toBe("fresh-password");
		expect(hotspotConfigure).toHaveBeenCalledTimes(1);
		expect(hotspotConfigure).toHaveBeenCalledWith(
			expect.objectContaining({
				password: "fresh-password",
				name: "Box",
				channel: "auto_50",
			}),
		);
		// The device's later hotspot.config reply settles it, not the dispatch ack.
		expect(getOperationPhase(newHotspotPasswordKey("0", iface()))).toBe(
			"pending",
		);
		// A second press while pending sends nothing.
		expect(
			await renewHotspotPassword("0", iface(), () => "another-password"),
		).toBeUndefined();
		expect(hotspotConfigure).toHaveBeenCalledTimes(1);
	});

	it("sends nothing without a complete hotspot", async () => {
		expect(
			await renewHotspotPassword("0", iface({ incarnation: undefined })),
		).toBeUndefined();
		expect(hotspotConfigure).not.toHaveBeenCalled();
	});
});
