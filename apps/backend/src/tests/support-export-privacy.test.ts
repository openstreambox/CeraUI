import { describe, expect, test } from "bun:test";
import { logRedact } from "../helpers/logger.ts";
import { logRpcCall } from "../rpc/rpc-logging.ts";
import {
	event,
	exported,
	kernel,
	modemManager,
} from "./support/journal-records.ts";

// Synthetic review reproductions, including historical records predating redaction.
const historicalRpc =
	'{"msg":"RPC relay.validate ok","meta":{"cid":"a1b2c3d4","procedure":"relay.validate","latency_ms":1.25,"ok":true,"client":"192.0.2.23","args":{"addr":"ingest.example.net","port":5000,"streamid":"publish:KEYVALUE","passphrase":"hunter2hunter2"}}}';

describe("support export privacy regressions", () => {
	test("historical RPC args and client are never exported, safe call timing survives", () => {
		const output = exported(event(JSON.parse(historicalRpc)));
		for (const value of [
			"a1b2c3d4",
			"192.0.2.23",
			"ingest.example.net",
			"publish:KEYVALUE",
			"hunter2hunter2",
		])
			expect(output).not.toContain(value);
		expect(output).toContain("RPC relay.validate ok");
		expect(JSON.parse(output.slice(output.indexOf("{"))).meta).toEqual({
			procedure: "relay.validate",
			latency_ms: 1,
			ok: true,
		});
	});
	test("real RPC traces discard streaming input and client identity", () => {
		let line = "";
		logRpcCall(
			{
				path: ["streaming", "start"],
				cid: "abcd1234",
				latencyMs: 2,
				ok: true,
				client: "192.0.2.23",
				input: {
					srt_streamid: "publish:KEYVALUE",
					relay_streamid_override: "private-stream",
					relay_account: "private-account",
					passphrase: "hunter2hunter2",
				},
			},
			{
				isEnabled: () => true,
				genCorrelationId: () => "unused",
				now: () => 0,
				sink: {
					debug: (msg, meta) => {
						line = JSON.stringify({ msg, meta });
					},
				},
			},
		);
		const output = exported(event(JSON.parse(line)));
		expect(output).toContain("RPC streaming.start ok");
		for (const value of [
			"abcd1234",
			"192.0.2.23",
			"publish:KEYVALUE",
			"private-stream",
			"private-account",
			"hunter2hunter2",
		])
			expect(output).not.toContain(value);
	});
	test.each([
		modemManager(
			'<debug> [ttyUSB2/at] <-- \'<CR><LF>+CEREG: 2,1,"00AA","0A0B0C0D",7<CR><LF>\'',
		),
		modemManager('<info>  [modem0] +CGREG: 2,1,"00AA","0A0B0C0D",7'),
		event({ msg: '+C5GREG: 2,1,"00AA","0A0B0C0D",7' }),
		event({ msg: '+QENG: "servingcell",…,001,01,A0B0C0D,123,…,00AA,…' }),
		event({ msg: "98:43:70:11:00:00:83:26:01:f5" }),
		event({ msg: "35 175605 152399 9" }),
		event({ msg: "$PTEST,0000.000,N,00000.000,E*00" }),
		event({ msg: "latitude 0.000000 longitude 0.000000" }),
		kernel("98:43:70:11:00:00:83:26:01:f5"),
	])("withholds opaque modem, identifier, position evidence (%#)", (record) => {
		expect(exported(record)).toBe("[REDACTED support log line]");
	});
	test("reduces a system-call error to its call and code", () => {
		const output = exported(
			event({
				msg: "Failed to start stream",
				meta: {
					err: {
						name: "Error",
						message: "connect ECONNREFUSED 203.0.113.7:5000",
					},
				},
			}),
		);
		expect(output).toContain('"message":"connect ECONNREFUSED [value]"');
		expect(output).not.toContain("203.0.113.7");
	});

	test("logger masks passphrases and GNS positions before persistence", () => {
		const output = JSON.stringify(
			logRedact({
				passphrase: "hunter2hunter2",
				nested: { srtPassphrase: "private-passphrase" },
			}),
		);
		expect(output).not.toContain("hunter2hunter2");
		expect(output).not.toContain("private-passphrase");
		expect(logRedact("$GNGNS,120000,0000.000,N,00000.000,E,AA")).toBe(
			"[REDACTED]",
		);
	});
	test("diagnostic events retain status, reason, severity, timing and USB failures", () => {
		const entry = {
			ts: "2026-11-13T00:00:00Z",
			level: "warn",
			msg: "Failed to start stream",
			meta: { reason: "no_route", attempt: 2, retryable: true },
		};
		const output = exported(event(entry));
		expect(JSON.parse(output.slice(output.indexOf("{")))).toEqual({
			msg: entry.msg,
			level: entry.level,
			meta: entry.meta,
		});
		expect(
			exported(kernel("usb 1-2: USB disconnect, device number 8")),
		).toContain("USB disconnect");
	});
});
