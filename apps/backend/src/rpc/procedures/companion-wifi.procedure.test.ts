import { describe, expect, spyOn, test } from "bun:test";
import { call } from "@orpc/server";
import { logger } from "../../helpers/logger.ts";
import { parseCompanionWifiInput } from "../../modules/wifi/companion-wifi-input.ts";
import { handleORPCMessage, parseMessage } from "../adapter.ts";
import { logRpcCall } from "../rpc-logging.ts";
import type { AppWebSocket, RPCContext, SocketData } from "../types.ts";
import { createCompanionWifiProcedure } from "./companion-wifi.procedure.ts";

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
			return "profile";
		};
		const denied = createCompanionWifiProcedure(save, () => false);
		const enabled = createCompanionWifiProcedure(save, () => true);
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
		const procedure = createCompanionWifiProcedure(
			async (value) => {
				received.push(value);
				return "profile";
			},
			() => true,
		);
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
		const procedure = createCompanionWifiProcedure(
			async () => {
				throw Error(input.qr);
			},
			() => true,
		);
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

	test("omits raw frame text from native import diagnostics", () => {
		const warn = spyOn(logger, "warn");
		const error = spyOn(logger, "error");
		try {
			expect(
				parseMessage('{"qr":"WIFI:T:WPA;P:sample-only;;"}', socket()),
			).toBeNull();
			expect(parseMessage("WIFI:T:WPA;P:sample-only;;", socket())).toBeNull();
			expect(warn).toHaveBeenCalledTimes(1);
			expect(error).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(warn.mock.calls)).not.toContain("sample-only");
			expect(JSON.stringify(error.mock.calls)).not.toContain("sample-only");
		} finally {
			warn.mockRestore();
			error.mockRestore();
		}
	});
});
