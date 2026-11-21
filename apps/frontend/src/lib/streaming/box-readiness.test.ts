import type { StreamReadiness } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import en from "../../../../../packages/i18n/messages/en.json";
import {
	BOX_NOT_READY_KEY,
	BOX_READINESS_KEYS,
	boxNotReadyKey,
	boxReadinessKey,
} from "./box-readiness";

function readiness(over: Partial<StreamReadiness> = {}): StreamReadiness {
	const reason = over.reason;
	const checks: StreamReadiness["checks"] = (
		["lock", "source", "receiver", "uplinks"] as const
	).map((id) =>
		over.ready === false && reason?.check === id
			? { id, state: "blocked", code: reason.code }
			: { id, state: "ok" },
	);
	return {
		ready: true,
		live: false,
		checks,
		uplinks: { usable: 1, total: 1 },
		at: 0,
		...over,
	};
}

describe("box readiness line", () => {
	it("says nothing without an answer, when ready, or while live", () => {
		expect(boxNotReadyKey(undefined)).toBeUndefined();
		expect(boxNotReadyKey(readiness({}))).toBeUndefined();
		expect(
			boxNotReadyKey(
				readiness({
					reason: { check: "receiver", code: "receiver_untested" },
				}),
			),
		).toBeUndefined();
		expect(
			boxNotReadyKey(
				readiness({
					ready: false,
					live: true,
					reason: { check: "uplinks", code: "no_link_carrying" },
				}),
			),
		).toBeUndefined();
	});

	it("maps the reason code to its line", () => {
		expect(
			boxNotReadyKey(
				readiness({
					ready: false,
					reason: { check: "uplinks", code: "no_uplink_passes" },
				}),
			),
		).toBe("live.goLive.box.noUplink");
		expect(boxReadinessKey("MODEM_TRANSITION_ACTIVE")).toBe(
			"live.goLive.box.busyModem",
		);
	});

	it("an implicit source skips only the source check's no_source", () => {
		const notReady = readiness({
			ready: false,
			reason: { check: "source", code: "no_source" },
			checks: [
				{ id: "lock", state: "ok" },
				{ id: "source", state: "blocked", code: "no_source" },
				{ id: "receiver", state: "blocked", code: "receiver_invalid" },
				{ id: "uplinks", state: "ok" },
			],
		});
		expect(boxNotReadyKey(notReady)).toBe("live.goLive.box.noSource");
		expect(boxNotReadyKey(notReady, { implicitSource: true })).toBe(
			"live.goLive.box.invalidDestination",
		);
	});

	it("a code this build does not know gets the generic line", () => {
		expect(boxReadinessKey("something_new")).toBe(BOX_NOT_READY_KEY);
		expect(boxNotReadyKey(readiness({ ready: false, reason: undefined }))).toBe(
			BOX_NOT_READY_KEY,
		);
	});

	it("every line exists in the base catalog", () => {
		const catalog = en as Record<string, unknown>;
		for (const key of BOX_READINESS_KEYS)
			expect(typeof catalog[key], key).toBe("string");
	});
});
