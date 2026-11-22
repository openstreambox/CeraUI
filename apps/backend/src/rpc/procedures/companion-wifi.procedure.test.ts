import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { logger } from "../../helpers/logger.ts";
import * as nm from "../../modules/network/network-manager.ts";
import {
	companionConsentPrompt,
	parseCompanionWifiInput,
	visibleSsid,
} from "../../modules/wifi/companion-wifi-input.ts";
import {
	companionWifiSettings,
	stationProfileWithSsid,
} from "../../modules/wifi/companion-wifi-profile.ts";
import { wifiUpdateSavedConns } from "../../modules/wifi/wifi.ts";
import * as hotspotDiscovery from "../../modules/wifi/wifi-hotspot-discovery.ts";
import { handleORPCMessage, parseMessage } from "../adapter.ts";
import { localIngressPresent } from "../local-ingress-presence.ts";
import { logRpcCall } from "../rpc-logging.ts";
import type { AppWebSocket, RPCContext, SocketData } from "../types.ts";
import {
	createCompanionWifiProcedure,
	refreshCompanionStationProfiles,
	saveCompanionNetwork,
} from "./companion-wifi.procedure.ts";

afterEach(() => {
	mock.restore();
});

const network = {
	ssid: "Sample",
	security: "wpa-psk",
	password: "sample-only",
};
const request = { consent: true, network };

function socket(
	peer = "127.0.0.1",
	data: Partial<SocketData> = {},
	send: (frame: string) => void = () => undefined,
) {
	return {
		remoteAddress: peer,
		data: {
			isAuthenticated: true,
			lastActive: 0,
			nativeTcpClient: true,
			...data,
		},
		send,
	} as unknown as AppWebSocket;
}

function context(ws = socket()) {
	return {
		ws,
		getSenderId: () => ws.data.senderId,
		isAuthenticated: () => ws.data.isAuthenticated,
		markActive: () => {},
	} as RPCContext;
}

describe("companion Wi-Fi import", () => {
	test("decodes a QR without losing escaped delimiters or hidden status", () => {
		expect(
			parseCompanionWifiInput({
				consent: true,
				qr: String.raw`WIFI:P:long\;pass\\;H:true;S:Venue\,\:\"\;;T:SAE;;`,
			}),
		).toEqual({
			ssid: 'Venue,:";',
			security: "sae",
			password: "long;pass\\",
			hidden: true,
		});
		expect(
			parseCompanionWifiInput({ consent: true, qr: "WIFI:S:Venue;" }),
		).toMatchObject({ ssid: "Venue", security: "open" });
	});

	test.each([
		{ ...request, consent: false },
		{ ...request, qr: "WIFI:S:Other;;" },
		{ ...request, network: { ...network, ssid: "😀".repeat(9) } },
		{ ...request, network: { ...network, ssid: "__proto__" } },
		{ ...request, network: { ...network, password: "short" } },
		{ ...request, network: { ...network, password: "sample-only\n" } },
		{ ...request, network: { ...network, security: "open" } },
		{ consent: true, qr: "WIFI:T:WPA2-EAP;S:Venue;P:sample-only;;" },
		{ consent: true, qr: "WIFI:T:WEP;S:Venue;P:sample-only;;" },
		{ consent: true, qr: "WIFI:T:nopass;S:Venue;S:Other;;" },
		{ consent: true, qr: "WIFI:T:nopass;S:Venue;;trailing" },
		{ consent: true, qr: "WIFI:T:nopass;S:Venue\\;" },
		{ consent: true, qr: "WIFI:T:nopass;S:Venue;H:unknown;;" },
	])("rejects invalid input %#", (input) => {
		expect(parseCompanionWifiInput(input)).toBeUndefined();
	});

	test("enforces authentication, flag and direct loopback before saving", async () => {
		let writes = 0;
		const save = async () => {
			writes++;
			return { status: "saved", uuid: "profile" } as const;
		};
		const denied = createCompanionWifiProcedure({
			save,
			enabled: () => false,
			frontDoor: () => false,
		});
		const enabled = createCompanionWifiProcedure({
			save,
			enabled: () => true,
			frontDoor: () => false,
		});
		await expect(
			call(enabled, request, {
				context: context(socket(undefined, { isAuthenticated: false })),
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(await call(denied, request, { context: context() })).toEqual({
			status: "disabled",
		});
		for (const ws of [
			socket("192.0.2.4"),
			socket(undefined, { nativeTcpClient: false }),
			socket(undefined, { senderId: "relay" }),
			socket(undefined, {
				ingressPath: {
					peer: "192.0.2.4",
					interface: "wlan0",
					local: "192.0.2.1",
				},
			}),
		]) {
			expect(await call(enabled, request, { context: context(ws) })).toEqual({
				status: "local_only",
			});
		}
		expect(
			await call(
				enabled,
				{ ...request, consent: false },
				{ context: context() },
			),
		).toEqual({ status: "invalid" });
		expect(writes).toBe(0);
	});

	test("passes both inputs to one saver and returns only the profile reference", async () => {
		const received: unknown[] = [];
		const procedure = createCompanionWifiProcedure({
			save: async (value) => {
				received.push(value);
				return { status: "saved", uuid: "profile" };
			},
			enabled: () => true,
			frontDoor: () => false,
		});
		for (const input of [
			request,
			{ consent: true, qr: "WIFI:S:Sample;T:WPA;P:sample-only;;" },
		]) {
			expect(await call(procedure, input, { context: context() })).toEqual({
				status: "saved",
				uuid: "profile",
			});
		}
		expect(received).toEqual([network, { ...network, hidden: false }]);
	});

	test("does not expose the QR or a secret-bearing failure in the RPC response or trace", async () => {
		const input = { consent: true, qr: "WIFI:S:Sample;T:WPA;P:sample-only;;" };
		const procedure = createCompanionWifiProcedure({
			save: async () => {
				throw Error(input.qr);
			},
			enabled: () => true,
			frontDoor: () => false,
		});
		const frames: string[] = [];
		const path = ["wifi", "addFromCompanion"];
		await handleORPCMessage(
			socket(undefined, {}, (frame) => frames.push(frame)),
			{
				id: "probe",
				path,
				input,
			},
			{ wifi: { addFromCompanion: procedure } },
		);
		expect(frames).toEqual([
			'{"id":"probe","result":{"status":"save_failed"}}',
		]);
		logRpcCall(
			{ path, input, ok: true, latencyMs: 1, cid: "test" },
			{
				sink: {
					debug: (_message, meta) => {
						expect(meta).not.toHaveProperty("args");
					},
				},
				now: () => 0,
				genCorrelationId: () => "test",
				isEnabled: () => true,
			},
		);
	});

	test("refuses a native loopback socket while the image's front door is present", async () => {
		let writes = 0;
		const procedure = createCompanionWifiProcedure({
			save: async () => {
				writes++;
				return { status: "saved", uuid: "profile" };
			},
			enabled: () => true,
			frontDoor: () => true,
		});
		// Behind the front door a routed or VPN client reaches the TCP listener
		// from 127.0.0.1 and, without a browser, sends no Origin.
		expect(await call(procedure, request, { context: context() })).toEqual({
			status: "local_only",
		});
		expect(writes).toBe(0);
	});

	test("treats the front door as present when its runtime directory exists or cannot be read", () => {
		const root = mkdtempSync(join(tmpdir(), "companion-front-door-"));
		try {
			expect(localIngressPresent(root)).toBe(true);
			expect(localIngressPresent(join(root, "absent"))).toBe(false);
			// A non-directory path component is not ENOENT: fail closed.
			expect(localIngressPresent(join("/dev/null", "absent"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true });
		}
	});

	test("omits raw frame text from diagnostics for every socket and flag state", () => {
		const warn = spyOn(logger, "warn");
		const error = spyOn(logger, "error");
		try {
			for (const ws of [
				socket(),
				socket(undefined, { nativeTcpClient: false }),
				socket("192.0.2.4", { nativeTcpClient: undefined }),
			]) {
				expect(
					parseMessage('{"qr":"WIFI:T:WPA;P:sample-only;;"}', ws),
				).toBeNull();
				expect(
					parseMessage('{"note":"sample-only plain text"}', ws),
				).toBeNull();
				expect(parseMessage("WIFI:T:WPA;P:sample-only;;", ws)).toBeNull();
				expect(parseMessage('{"qr":"sample-only', ws)).toBeNull();
			}
			expect(warn).toHaveBeenCalledTimes(6);
			expect(error).toHaveBeenCalledTimes(6);
			expect(JSON.stringify(warn.mock.calls)).not.toContain("sample-only");
			expect(JSON.stringify(error.mock.calls)).not.toContain("sample-only");
			for (const [message] of error.mock.calls)
				expect(message).toBe("Failed to parse WebSocket message");
		} finally {
			warn.mockRestore();
			error.mockRestore();
		}
	});

	test("redacts a QR sent to another route from the RPC trace", () => {
		const lines: unknown[] = [];
		for (const path of [
			["wifi", "connect"],
			["system", "getLog"],
		])
			logRpcCall(
				{
					path,
					input: { qr: "WIFI:S:Sample;T:WPA;P:sample-only;;", consent: true },
					ok: false,
					latencyMs: 1,
					cid: "test",
				},
				{
					sink: { debug: (_message, meta) => lines.push(meta) },
					now: () => 0,
					genCorrelationId: () => "test",
					isEnabled: () => true,
				},
			);
		expect(lines).toHaveLength(2);
		expect(JSON.stringify(lines)).not.toContain("sample-only");
	});

	test("reports an existing same-SSID station profile without saving", async () => {
		const added: unknown[] = [];
		let refreshes = 0;
		const deps = {
			stationProfileWithSsid: async (ssid: string) => ssid === "Sample",
			addProfile: async (value: unknown) => {
				added.push(value);
				return "profile";
			},
			refresh: async () => {
				refreshes++;
			},
		};
		expect(await saveCompanionNetwork(network as never, deps)).toEqual({
			status: "already_saved",
		});
		expect(added).toEqual([]);
		const other = { ...network, ssid: "Other" };
		expect(await saveCompanionNetwork(other as never, deps)).toEqual({
			status: "saved",
			uuid: "profile",
		});
		expect(added).toEqual([other]);
		expect(refreshes).toBe(1);

		const procedure = createCompanionWifiProcedure({
			save: async () => ({ status: "already_saved" }),
			enabled: () => true,
			frontDoor: () => false,
		});
		expect(await call(procedure, request, { context: context() })).toEqual({
			status: "already_saved",
		});
	});

	test("finds same-SSID station profiles and ignores hotspot profiles", async () => {
		const rows: Record<string, [string, string]> = {
			"11111111-1111-4111-8111-111111111111": ["ap", "Sample"],
			"22222222-2222-4222-8222-222222222222": ["infrastructure", "Other"],
		};
		spyOn(nm, "nmConnsGet").mockImplementation(async () => [
			...Object.keys(rows).map((uuid) => `${uuid}:802-11-wireless`),
			"33333333-3333-4333-8333-333333333333:802-3-ethernet",
		]);
		spyOn(nm, "nmConnGetFields").mockImplementation(
			(async (uuid: string) => rows[uuid]) as never,
		);
		expect(await stationProfileWithSsid("Sample")).toBe(false);
		rows["44444444-4444-4444-8444-444444444444"] = ["infrastructure", "Sample"];
		expect(await stationProfileWithSsid("Sample")).toBe(true);
		spyOn(nm, "nmConnsGet").mockImplementation(async () => undefined);
		await expect(stationProfileWithSsid("Sample")).rejects.toThrow();
	});

	test("refreshes saved station profiles without touching hotspot profiles", async () => {
		spyOn(nm, "nmConnsGet").mockImplementation(async () => [
			"11111111-1111-4111-8111-111111111111:802-11-wireless",
			"22222222-2222-4222-8222-222222222222:802-11-wireless",
		]);
		spyOn(nm, "nmConnGetFields").mockImplementation((async (uuid: string) =>
			uuid.startsWith("1")
				? ["ap", "Box hotspot", ""]
				: ["infrastructure", "Sample", ""]) as never);
		const hotspot = spyOn(
			hotspotDiscovery,
			"handleHotspotConn",
		).mockImplementation(async () => undefined);
		await refreshCompanionStationProfiles();
		expect(hotspot).not.toHaveBeenCalled();
	});

	test("a station-only refresh runs after a running full refresh instead of cancelling it", async () => {
		const release = Promise.withResolvers<void>();
		let lists = 0;
		spyOn(nm, "nmConnsGet").mockImplementation(async () => {
			// The full refresh's inventory read is still pending when the
			// import's refresh starts.
			if (++lists === 1) await release.promise;
			return ["11111111-1111-4111-8111-111111111111:802-11-wireless"];
		});
		spyOn(nm, "nmConnGetFields").mockImplementation((async () => [
			"ap",
			"Box hotspot",
			"",
		]) as never);
		const hotspot = spyOn(
			hotspotDiscovery,
			"handleHotspotConn",
		).mockImplementation(async () => undefined);
		const full = wifiUpdateSavedConns();
		const station = refreshCompanionStationProfiles();
		await Bun.sleep(10);
		expect(lists).toBe(1);
		release.resolve();
		await Promise.all([full, station]);
		// The full refresh still adopted the hotspot, and the station refresh
		// listed again afterwards, so it sees a profile saved meanwhile.
		expect(hotspot).toHaveBeenCalledTimes(1);
		expect(lists).toBe(2);
	});

	test("stores SAE with required PMF and leaves WPA2 negotiation to NetworkManager", () => {
		const security = (value: Parameters<typeof companionWifiSettings>[0]) =>
			JSON.stringify(
				companionWifiSettings(value).find(
					([name]) => name === "802-11-wireless-security",
				),
			);
		const sae = security({ ...network, security: "sae" } as never);
		expect(sae).toContain('["pmf",{"signature":"i","value":3}]');
		expect(security(network as never)).not.toContain('"pmf"');
	});

	test("shows invisible SSID characters and the destination in the consent prompt", () => {
		for (const [hidden, code] of [
			["​", "200B"],
			["‮", "202E"],
			["­", "00AD"],
			["﻿", "FEFF"],
			[" ", "00A0"],
		] as const) {
			expect(visibleSsid(`Cafe${hidden}`)).toBe(`"Cafe\\u{${code}}"`);
		}
		expect(visibleSsid("Café 5G")).toBe('"Café 5G"');
		// A literal backslash cannot imitate an escaped invisible character.
		expect(visibleSsid(String.raw`Cafe\u{200B}`)).toBe(
			String.raw`"Cafe\\u{200B}"`,
		);
		const prompt = companionConsentPrompt(
			{ ssid: "Cafe​", security: "wpa-psk", password: "sample-only" },
			new URL("ws://127.0.0.1:18080/ws"),
		);
		expect(prompt).toContain('"Cafe\\u{200B}"');
		expect(prompt).toContain("ws://127.0.0.1:18080/ws");
		expect(prompt).toContain("invisible");
		expect(prompt).not.toContain("sample-only");
		expect(
			companionConsentPrompt(
				{ ssid: "Cafe", security: "open" },
				new URL("ws://127.0.0.1:8080/ws"),
			),
		).not.toContain("invisible");
	});
});
