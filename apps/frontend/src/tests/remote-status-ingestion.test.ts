import { beforeEach, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({
	message: undefined as
		| undefined
		| ((t: string, d: unknown, s?: number) => void),
}));
vi.mock("$lib/rpc/client", () => ({
	rpc: {},
	rpcClient: {
		onMessage: (fn: typeof handlers.message) => {
			handlers.message = fn;
		},
		onConnectionChange: () => undefined,
		connect: () => undefined,
		getSocket: () => undefined,
		sendLegacy: () => undefined,
	},
}));

import {
	getIsStreaming,
	getModems,
	getNetif,
	getWifi,
	initSubscriptions,
	resetState,
} from "$lib/rpc/subscriptions.svelte";
import { projectRemoteLegacyFrame } from "../../../backend/src/modules/remote/remote-status.ts";

beforeEach(() => {
	resetState();
	initSubscriptions();
});
it("remote consumers receive neutral network labels and useful streaming/link metrics", () => {
	const frame = projectRemoteLegacyFrame({
		status: {
			is_streaming: true,
			wifi: {
				radio: {
					ifname: "private-iface",
					hw: "private-mac",
					conn: "private-profile",
					saved: { "private-network": "private-profile" },
				},
			},
			modems: {
				modem: {
					name: "private-modem",
					status: { signal: 78, connection: "connected" },
				},
			},
		},
		netif: {
			"private-iface": { enabled: true, tx_bps: 1200000, ip: "192.0.2.10" },
		},
	});
	for (const [type, payload] of Object.entries(frame))
		handlers.message?.(type, payload, 1);
	expect(getIsStreaming()).toBe(true);
	expect(JSON.stringify(getWifi())).toMatch(/Wi-Fi \d+/);
	expect(JSON.stringify(getModems())).toMatch(/Modem \d+/);
	expect(Object.values(getNetif() ?? {})[0]).toHaveProperty("tx_bps", 1200000);
	for (const value of [getWifi(), getModems(), getNetif()])
		expect(JSON.stringify(value)).not.toMatch(/private-|192\.0\.2\.10/);
});
