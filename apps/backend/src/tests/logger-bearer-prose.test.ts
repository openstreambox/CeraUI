import { expect, test } from "bun:test";
import { logRedact, REDACTED } from "../helpers/logger.ts";
import { buildRedactor } from "../modules/device-logs/redaction.ts";
import { SUPPORT_LOG_TEMPLATES } from "../modules/system/support-log-messages.generated.ts";

/*
  "Bearer" is both an HTTP auth scheme and a cellular data session. The
  logger's value rule used to blank any string with "bearer" and a word after
  it, so every dead-bearer recovery line (and upstream's bearer family
  reconciliation line) reached the support log as "[REDACTED]".
*/

test.each([
	"automatic bearer family reconciliation deferred",
	"synchronizing all bearer status failed",
	"modem bearer re-dial pending",
	"modem BEARER reconnect finished",
	"modem data session carries no traffic; reconnecting",
])("prose about a data bearer passes the logger: %s", (line) => {
	expect(logRedact({ msg: line })).toEqual({ msg: line });
});

test.each([
	"Bearer abc123XYZ.token",
	"Bearer private",
	"bearer abc123XYZ.tok",
	"BEARER 0123456789abcdef",
	"Bearer v4local_sig.part",
	"Bearer abcdefghijklmnopqrstuvwxyz",
	"request failed with Bearer QWxhZGRpbjpvcGVuIHNlc2FtZQ== attached",
	"Authorization: bearer plainword",
	'{"authorization": "Bearer short"}',
])("a bearer credential is still redacted: %s", (line) => {
	expect(logRedact({ note: line })).toEqual({ note: REDACTED });
});

test("dead-bearer recovery's support log lines survive both redactors", () => {
	const lines = [
		"modem data session carries no traffic; reconnecting",
		"modem data session reconnect finished",
		"data session check did not complete",
	];
	const journal = buildRedactor([]);
	const templates = new Set(SUPPORT_LOG_TEMPLATES.map((t) => t.join("")));
	for (const line of lines) {
		expect(templates.has(line)).toBe(true);
		expect(logRedact({ msg: line })).toEqual({ msg: line });
		expect(journal.text(line)).toEqual({ text: line, redactions: 0 });
	}
});
