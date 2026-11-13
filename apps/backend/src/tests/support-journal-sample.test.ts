import { describe, expect, test } from "bun:test";
import { exported } from "./support/journal-records.ts";
import {
	type Generation,
	journalSampleFor,
	sampleSecrets,
} from "./support/journal-sample.ts";

// The sample is assembled from the daemons' own format strings and the
// backend's own warn/error messages, not captured from a device. It pins that
// the evidence for three incidents (modem did not connect, Wi-Fi dropped,
// stream stopped) survives on both daemon generations, so a privacy change
// that silently withholds diagnosis shows up here. It does not measure how
// much of a real device journal is shown: lines without a shape are withheld.
const expected: Record<Generation, { records: number; shown: number }> = {
	bookworm: { records: 110, shown: 105 },
	trixie: { records: 114, shown: 110 },
};

describe.each(["bookworm", "trixie"] as const)(
	"journal sample, %s formats",
	(generation) => {
		const sample = journalSampleFor(generation);
		const output = exported(...sample);
		const shown = sample.filter(
			(record) => !exported(record).startsWith("[REDACTED"),
		).length;

		test("no sample secret reaches the export", () => {
			for (const secret of sampleSecrets) expect(output).not.toContain(secret);
		});
		test("the incident evidence survives", () => {
			expect(sample.length).toBe(expected[generation].records);
			expect(shown).toBe(expected[generation].shown);
			for (const evidence of [
				"modem couldn't be initialized: Couldn't check unlock status: SIM PIN required",
				"3GPP registration state changed (searching -> denied)",
				"connection attempt #1 failed: Missing or unknown APN",
				"failed to connect modem: Missing or unknown APN",
				"(reason 'gsm-apn-failed', ",
				"reason=WRONG_KEY",
				"CTRL-EVENT-DISCONNECTED bssid=[address] reason=4",
				"(reason 'supplicant-timeout', ",
				"AP-STA-CONNECTED [address]",
				"srtla_send exited (code=1, signal=null)",
				'"class":"engine_unavailable"',
				'"retry":{"state":"exhausted","attempt":3,"maxAttempts":3,"suppressed":false}',
				"Main process exited, code=killed, status=9/KILL",
				"call end reason (3): generic-unspecified",
				"cannot enable/disable modem: locked",
				'Connected to wireless network "[name]"',
				...(generation === "trixie"
					? [
							"modem is locked with 'sim-pin'",
							"failed sending SIM PIN: Incorrect password",
							"verbose call end reason (6,33): [3gpp] option-unsubscribed",
							"couldn't start IPv4 network: QMI protocol error (14): 'CallFailed'",
						]
					: []),
			])
				expect(output).toContain(evidence);
		});
	},
);
