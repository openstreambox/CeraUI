import { describe, expect, test } from "bun:test";
import { redactSupportJournal } from "../modules/system/support-export.ts";
import {
	diagnosticLines,
	privateLines,
} from "./support/support-export-corpus.ts";

describe("support export paired privacy and diagnostics corpora", () => {
	test.each(privateLines)("withholds $secret in $line", ({ line, secret }) => {
		expect(redactSupportJournal(line)).not.toContain(secret);
	});
	test.each(diagnosticLines)("preserves $evidence", ({ line, evidence }) => {
		expect(redactSupportJournal(line)).toContain(evidence);
	});
	test("keeps the error reason, exit status and signal without stacks or unknown fields", () => {
		const out = redactSupportJournal(
			'ceralive[1234]: {"level":"error","msg":"Failed to start stream","meta":{"err":{"name":"Error","message":"engine start rejected: capture device busy","code":"EBUSY","stack":"private-stack"},"exitCode":1,"signal":"SIGTERM","code":32,"ifname":"wwan0","reason":"capture device is busy"}}',
		);
		expect(out).toContain("engine start rejected: capture device busy");
		expect(out).toContain('"exitCode":1');
		expect(out).toContain('"signal":"SIGTERM"');
		expect(out).toContain('"code":32');
		expect(out).toContain('"ifname":"wwan0"');
		expect(out).toContain('"reason":"capture device is busy"');
		expect(out).not.toContain("private-stack");
	});
	test("filters bounded error messages while keeping safe failure codes", () => {
		const out = redactSupportJournal(
			'ceralive[1234]: {"msg":"operation failed","meta":{"error":{"name":"Error","code":"EACCES","message":"relay account: private-error-value","stack":"private-stack"}}}',
		);
		expect(out).toContain("EACCES");
		expect(out).not.toContain("private-error-value");
		expect(out).not.toContain("private-stack");
	});

	test("retains bounded string errors and omits oversized error messages", () => {
		const out = redactSupportJournal(
			JSON.stringify({
				msg: "operation failed",
				meta: {
					err: "Network timeout",
					error: { name: "Error", message: "x".repeat(301) },
				},
			}),
		);
		expect(out).toContain("Network timeout");
		expect(out).not.toContain("x".repeat(301));
	});

	test("rejects unconstrained code fields and requires RPC procedure agreement", () => {
		const out = redactSupportJournal(
			'{"msg":"RPC system.getLog err","meta":{"procedure":"private-key-value","reason":"osbkey7f3a9c2e","state":"Tr0ub4dorXyz","count":27447299}}',
		);
		for (const value of [
			"private-key-value",
			"osbkey7f3a9c2e",
			"Tr0ub4dorXyz",
			"27447299",
		])
			expect(out).not.toContain(value);
	});
	test("rejects oversized pathological records before content matching", () => {
		const start = performance.now();
		expect(redactSupportJournal(`kernel: trace ${"[x ".repeat(131072)}`)).toBe(
			"[REDACTED support log line]",
		);
		expect(performance.now() - start).toBeLessThan(1000);
	});
});
