import { expect, test } from "bun:test";
import { logRedact, REDACTED } from "../helpers/logger.ts";
import { buildRedactor } from "../modules/device-logs/redaction.ts";
import { SUPPORT_LOG_TEMPLATES } from "../modules/system/support-log-messages.generated.ts";

/*
  "Bearer" is both an HTTP auth scheme and a cellular data session. Both the
  logger and the journal export redact any word after "bearer", in any case,
  because a short opaque token looks like a word. So the backend's own log
  lines never say "bearer" before a word: these name the data session, and
  reach the support log whole.
*/

const DATA_SESSION_LINES = [
	"modem data session carries no traffic; reconnecting",
	"modem data session reconnect finished",
	"modem data session reconnect withdrawn",
	"data session check did not complete",
	"automatic data session IP family reconciliation deferred",
];

test.each(DATA_SESSION_LINES)("%s survives both redactors", (line) => {
	const templates = new Set(SUPPORT_LOG_TEMPLATES.map((t) => t.join("")));
	expect(templates.has(line)).toBe(true);
	expect(logRedact({ msg: line })).toEqual({ msg: line });
	expect(buildRedactor([]).text(line)).toEqual({ text: line, redactions: 0 });
});

test('no backend log text puts a word after "bearer"', () => {
	const offenders = SUPPORT_LOG_TEMPLATES.map((t) => t.join("")).filter(
		(text) => /\bbearer\s+[A-Za-z0-9\-._~+/]/i.test(text),
	);
	expect(offenders).toEqual([]);
});

test.each([
	"Bearer abc123XYZ.token",
	"Bearer private",
	"bearer alphaword",
	"BEARER alphaword",
	"header snapshot: bearer alphaword",
	'{"bearer":"BEARER alphaword"}',
	"bearer abc.def_ghi",
	"bearer abcdefghijklmnopqrstuvwxyz",
	"request failed with Bearer QWxhZGRpbjpvcGVuIHNlc2FtZQ== attached",
	"Authorization: bearer alphaword",
])("a bearer credential is redacted however short or cased: %s", (line) => {
	expect(logRedact({ note: line })).toEqual({ note: REDACTED });
});
