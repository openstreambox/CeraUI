import { describe, expect, test } from "bun:test";
import { renderSupportJournal } from "../modules/system/support-journal.ts";
import {
	ceralive,
	event,
	exported,
	journal,
} from "./support/journal-records.ts";
import {
	diagnosticRecords,
	privateRecords,
} from "./support/support-export-corpus.ts";

const describeRecord = (entry: Record<string, unknown>) =>
	`${String(entry._COMM ?? entry._TRANSPORT)}: ${String(entry.MESSAGE).slice(0, 90)}`;

describe("support export paired corpora through the production renderer", () => {
	test.each(
		privateRecords.map((entry) => ({
			...entry,
			label: describeRecord(entry.record),
		})),
	)("withholds $secret ($label)", ({ record, secret }) => {
		expect(exported(record)).not.toContain(secret);
	});
	test.each(
		diagnosticRecords.map((entry) => ({
			...entry,
			label: describeRecord(entry.record),
		})),
	)("preserves $evidence ($label)", ({ record, evidence }) => {
		expect(exported(record)).toContain(evidence);
	});
	test("both corpora together keep every diagnostic and no secret", () => {
		const output = exported(
			...privateRecords.map((entry) => entry.record),
			...diagnosticRecords.map((entry) => entry.record),
		);
		for (const { secret } of privateRecords)
			expect(output).not.toContain(secret);
		for (const { evidence } of diagnosticRecords)
			expect(output).toContain(evidence);
	});
});

describe("structured backend events", () => {
	test("historical RPC args, correlation ids and client are never exported", () => {
		const output = exported(
			event({
				msg: "RPC relay.validate ok",
				meta: {
					cid: "a1b2c3d4",
					procedure: "relay.validate",
					latency_ms: 1.25,
					ok: true,
					client: "192.0.2.23",
					args: {
						addr: "ingest.example.net",
						streamid: "publish:KEYVALUE",
						passphrase: "hunter2hunter2",
					},
				},
			}),
		);
		for (const value of [
			"a1b2c3d4",
			"192.0.2.23",
			"ingest.example.net",
			"publish:KEYVALUE",
			"hunter2hunter2",
		])
			expect(output).not.toContain(value);
		expect(output).toContain(
			'ceralive: {"msg":"RPC relay.validate ok","meta":{"procedure":"relay.validate","latency_ms":1.25,"ok":true}}',
		);
	});
	test("keeps the error reason, exit status and signal without stacks or unknown fields", () => {
		const output = exported(
			event({
				level: "error",
				msg: "Failed to start stream",
				meta: {
					err: {
						name: "Error",
						message: "engine start rejected: capture device busy",
						code: "EBUSY",
						stack: "private-stack",
					},
					exitCode: 1,
					signal: "SIGTERM",
					code: 32,
					ifname: "wwan0",
					reason: "capture device is busy",
				},
			}),
		);
		for (const kept of [
			"engine start rejected: capture device busy",
			'"exitCode":1',
			'"signal":"SIGTERM"',
			'"code":32',
			'"ifname":"wwan0"',
			'"reason":"capture device is busy"',
		])
			expect(output).toContain(kept);
		expect(output).not.toContain("private-stack");
	});
	test("retains bounded string errors and omits oversized error messages", () => {
		const output = exported(
			event({
				msg: "operation failed",
				meta: {
					err: "Network timeout",
					error: { name: "Error", message: "x".repeat(301) },
				},
			}),
		);
		expect(output).toContain("Network timeout");
		expect(output).not.toContain("x".repeat(301));
	});
	test("rejects unconstrained code fields and requires RPC procedure agreement", () => {
		const output = exported(
			event({
				msg: "RPC system.getLog err",
				meta: {
					procedure: "private-key-value",
					reason: "osbkey7f3a9c2e",
					state: "Tr0ub4dorXyz",
					count: 27447299,
				},
			}),
		);
		for (const value of [
			"private-key-value",
			"osbkey7f3a9c2e",
			"Tr0ub4dorXyz",
			"27447299",
		])
			expect(output).not.toContain(value);
	});
	test("unknown metadata and pretty-printed fragments fail closed", () => {
		const output = exported(
			event({
				level: "warn",
				msg: "connection failed",
				meta: {
					reason: "no_route",
					opaque_future_field: "unlabelled-private-value",
					nested: { value: "another-private-value" },
				},
			}),
			ceralive('  "unlabelled-private-array-value",'),
			ceralive('  "future": "private-fragment"'),
		);
		for (const value of [
			"unlabelled-private-value",
			"another-private-value",
			"unlabelled-private-array-value",
			"private-fragment",
		])
			expect(output).not.toContain(value);
		expect(output).toContain("connection failed");
		expect(output).toContain("no_route");
	});
	test("withholds oversized pathological records before content matching", () => {
		const start = performance.now();
		const output = renderSupportJournal(
			journal(ceralive(`trace ${"[x ".repeat(131072)}`)),
		);
		expect(output).toBe("[REDACTED support log line]");
		expect(performance.now() - start).toBeLessThan(1000);
	});
});
