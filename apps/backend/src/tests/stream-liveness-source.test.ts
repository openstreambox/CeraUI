import { expect, test } from "bun:test";
import {
	deriveStreamLiveness,
	type StreamLivenessEvidence,
} from "../modules/system/stream-liveness-source.ts";

const idle: StreamLivenessEvidence = {
	reconciled: true,
	live: false,
	lifecycle: "idle",
	sentinel: "absent",
};
for (const [name, delta, expected] of [
	["initial projection", { reconciled: false }, "unknown"],
	["reconciling", { lifecycle: "reconciling" }, "unknown"],
	["starting", { lifecycle: "starting" }, "unknown"],
	["unknown sentinel", { sentinel: "unknown" }, "unknown"],
	["present sentinel", { sentinel: "present" }, "unknown"],
	["confirmed live", { live: true }, "streaming"],
	["confirmed idle", {}, "idle"],
] as const) {
	test(`liveness adapter preserves ${name}`, () => {
		// Given explicit evidence differing from confirmed idle.
		const evidence = { ...idle, ...delta };
		// When the adapter projects permission evidence.
		const result = deriveStreamLiveness(evidence);
		// Then only positive idle proves idle.
		expect(result).toBe(expected);
	});
}

test("a phone carried through an engine-less box overrides reconciled boot idle", () => {
	expect(deriveStreamLiveness({ ...idle, carrying: "streaming" })).toBe(
		"streaming",
	);
	expect(deriveStreamLiveness({ ...idle, carrying: "unknown" })).toBe(
		"unknown",
	);
});
