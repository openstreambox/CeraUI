import { describe, expect, test } from "bun:test";
import { logRedact } from "../helpers/logger.ts";
import { redactSupportJournal } from "../modules/system/support-export.ts";
import { logRpcCall } from "../rpc/rpc-logging.ts";

// Synthetic review reproductions, including historical records predating redaction.
const historicalRpc =
	'{"msg":"RPC relay.validate ok","meta":{"cid":"a1b2c3d4","procedure":"relay.validate","latency_ms":1.25,"ok":true,"client":"192.0.2.23","args":{"addr":"ingest.example.net","port":5000,"streamid":"publish:KEYVALUE","passphrase":"hunter2hunter2"}}}';

describe("support export privacy regressions", () => {
	test("historical RPC args and client are never exported, safe call timing survives", () => {
		const output = redactSupportJournal(historicalRpc);
		for (const value of [
			"a1b2c3d4",
			"192.0.2.23",
			"ingest.example.net",
			"publish:KEYVALUE",
			"hunter2hunter2",
		])
			expect(output).not.toContain(value);
		expect(output).toContain("RPC relay.validate ok");
		expect(JSON.parse(output).meta).toEqual({
			procedure: "relay.validate",
			latency_ms: 1.25,
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
		const output = redactSupportJournal(line);
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
		'ModemManager[600]: <debug> [ttyUSB2/at] <-- \'<CR><LF>+CEREG: 2,1,"00AA","0A0B0C0D",7<CR><LF>\'',
		'+CGREG: 2,1,"00AA","0A0B0C0D",7',
		'+C5GREG: 2,1,"00AA","0A0B0C0D",7',
		'+QENG: "servingcell",…,001,01,A0B0C0D,123,…,00AA,…',
		"ModemManager[600]: [/dev/cdc-wdm0] <<<<<<   value       = 33:35:31:37:35:36:30:35:31:35:32:33:39:39:39",
		"98:43:70:11:00:00:83:26:01:f5",
		"value = 33 35 31 37 35 36 30 35 31 35 32 33 39 39 39",
		"35 175605 152399 9",
		"35-175605-152399-9",
		"sms received from 0000 1234567",
		"$GNGNS,120000,0000.000,N,00000.000,E,AA,12,0.9,0.0,0.0,,*00",
		"latitude: 0.000000 longitude: 0.000000",
		"latitude 0.000000 longitude 0.000000",
		"$PTEST,0000.000,N,00000.000,E*00",
		"adapter address aa:bb:cc:dd:ee:ff",
		"passphrase=hunter2hunter2",
		"streamid=publish:KEYVALUE",
		"psk=private-wifi-key",
	])(
		"drops opaque modem, identifier, position and credential evidence: %s",
		(line) => {
			expect(redactSupportJournal(line)).toBe("[REDACTED support log line]");
		},
	);
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
		const line =
			'{"ts":"2026-11-13T00:00:00Z","level":"warn","msg":"connection failed","meta":{"reason":"no_route","attempt":2,"retryable":true}}';
		const output = redactSupportJournal(line);
		expect(JSON.parse(output)).toEqual(JSON.parse(line));
		expect(
			redactSupportJournal(
				"Nov 13 00:00:00 host kernel: usb 1-2: USB disconnect, device number 8",
			),
		).toContain("USB disconnect");
	});

	test("unknown structured metadata and pretty-printed fragments fail closed", () => {
		const output = redactSupportJournal(
			'{"ts":"2026-11-13T00:00:00Z","level":"warn","msg":"connection failed","meta":{"reason":"no_route","opaque_future_field":"unlabelled-private-value","nested":{"value":"another-private-value"}}}\n  "unlabelled-private-array-value",\n  "future": "private-fragment"\n2026-11-13T00:00:00 host service: "private-prefixed-fragment"',
		);
		for (const value of [
			"unlabelled-private-value",
			"another-private-value",
			"unlabelled-private-array-value",
			"private-fragment",
			"private-prefixed-fragment",
		])
			expect(output).not.toContain(value);
		expect(output).toContain("connection failed");
		expect(output).toContain("no_route");
	});
});
