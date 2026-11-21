import { afterEach, describe, expect, test } from "bun:test";
import {
	streamReadinessSchema,
	type UplinkHealthRecord,
} from "@ceraui/rpc/schemas";
import type { LinkCarryingState } from "./link-progress.ts";
import {
	evaluateStreamReadiness,
	getStreamReadiness,
	noteReceiverEvidence,
	READINESS_CARRYING_UNKNOWN,
	READINESS_NO_LINK_CARRYING,
	READINESS_NO_UPLINK,
	READINESS_NO_UPLINK_PASSES,
	READINESS_RECEIVER_NOT_SET,
	READINESS_RECEIVER_REFUSED,
	READINESS_RECEIVER_UNRESOLVED,
	READINESS_RECEIVER_UNTESTED,
	RECEIVER_EVIDENCE_TTL_MS,
	type ReadinessInputs,
	receiverEvidenceFor,
	receiverKey,
	resetStreamReadinessForTest,
	setReadinessDepsForTest,
	uplinkPasses,
} from "./stream-readiness.ts";

type Uplink = ReadinessInputs["uplinks"][number];

const up = (iface: string): Uplink => ({ iface, state: "up" });
const down = (iface: string): Uplink => ({
	iface,
	state: "down",
	reason: "probe_failed",
});

function inputs(overrides: Partial<ReadinessInputs> = {}): ReadinessInputs {
	return {
		now: 1_000,
		live: false,
		lock: undefined,
		source: undefined,
		receiver: { configured: true, evidence: "reachable" },
		uplinks: [up("wwan0")],
		carrying: () => "unknown",
		...overrides,
	};
}

afterEach(() => resetStreamReadinessForTest());

describe("evaluateStreamReadiness, before going live", () => {
	test("everything ok is ready with no reason", () => {
		const r = evaluateStreamReadiness(inputs());
		expect(r.ready).toBe(true);
		expect(r.live).toBe(false);
		expect(r.reason).toBeUndefined();
		expect(r.checks.map((c) => [c.id, c.state])).toEqual([
			["lock", "ok"],
			["source", "ok"],
			["receiver", "ok"],
			["uplinks", "ok"],
		]);
		expect(r.uplinks).toEqual({ usable: 1, total: 1 });
		expect(streamReadinessSchema.safeParse(r).success).toBe(true);
	});

	test("a Start lock blocks and is the reason, ahead of every other check", () => {
		const r = evaluateStreamReadiness(
			inputs({
				lock: "update_in_progress",
				source: "source_lost",
				receiver: { configured: false, evidence: undefined },
				uplinks: [],
			}),
		);
		expect(r.ready).toBe(false);
		expect(r.reason).toEqual({ check: "lock", code: "update_in_progress" });
		expect(r.checks.filter((c) => c.state === "blocked")).toHaveLength(4);
	});

	test("the source code is passed through as Start words it", () => {
		const r = evaluateStreamReadiness(inputs({ source: "source_lost" }));
		expect(r.ready).toBe(false);
		expect(r.reason).toEqual({ check: "source", code: "source_lost" });
	});

	test("no receiver configured blocks", () => {
		const r = evaluateStreamReadiness(
			inputs({ receiver: { configured: false, evidence: undefined } }),
		);
		expect(r.ready).toBe(false);
		expect(r.reason).toEqual({
			check: "receiver",
			code: READINESS_RECEIVER_NOT_SET,
		});
	});

	test("an untested receiver is reported but does not block", () => {
		const r = evaluateStreamReadiness(
			inputs({ receiver: { configured: true, evidence: undefined } }),
		);
		expect(r.ready).toBe(true);
		expect(r.reason).toEqual({
			check: "receiver",
			code: READINESS_RECEIVER_UNTESTED,
		});
	});

	test.each([
		["refused", READINESS_RECEIVER_REFUSED],
		["unresolved", READINESS_RECEIVER_UNRESOLVED],
	] as const)("a %s receiver blocks", (evidence, code) => {
		const r = evaluateStreamReadiness(
			inputs({ receiver: { configured: true, evidence } }),
		);
		expect(r.ready).toBe(false);
		expect(r.reason).toEqual({ check: "receiver", code });
	});

	test("no uplink at all and no passing uplink are told apart", () => {
		expect(evaluateStreamReadiness(inputs({ uplinks: [] })).reason).toEqual({
			check: "uplinks",
			code: READINESS_NO_UPLINK,
		});
		const r = evaluateStreamReadiness(
			inputs({ uplinks: [down("wwan0"), down("eth0")] }),
		);
		expect(r.ready).toBe(false);
		expect(r.reason).toEqual({
			check: "uplinks",
			code: READINESS_NO_UPLINK_PASSES,
		});
		expect(r.uplinks).toEqual({ usable: 0, total: 2 });
	});

	test("one passing uplink among dead ones is enough", () => {
		const r = evaluateStreamReadiness(
			inputs({ uplinks: [down("wwan0"), up("wwan1")] }),
		);
		expect(r.ready).toBe(true);
		expect(r.uplinks).toEqual({ usable: 1, total: 2 });
	});

	test("idle ignores carrying state entirely", () => {
		const r = evaluateStreamReadiness(
			inputs({ carrying: () => "not_carrying" }),
		);
		expect(r.ready).toBe(true);
	});
});

describe("uplinkPasses", () => {
	test("only up, or degraded by passive congestion, passes", () => {
		expect(uplinkPasses({ state: "up" })).toBe(true);
		expect(
			uplinkPasses({ state: "degraded", reason: "passive_congestion" }),
		).toBe(true);
		expect(uplinkPasses({ state: "degraded", reason: "probe_failed" })).toBe(
			false,
		);
		expect(uplinkPasses({ state: "degraded", reason: "captive_portal" })).toBe(
			false,
		);
		expect(uplinkPasses({ state: "down", reason: "definitive_loss" })).toBe(
			false,
		);
	});
});

describe("evaluateStreamReadiness, while live", () => {
	const carryingBy =
		(map: Record<string, LinkCarryingState>) =>
		(iface: string): LinkCarryingState =>
			map[iface] ?? "unknown";

	test("lock and source are ok while the stream runs", () => {
		const r = evaluateStreamReadiness(
			inputs({
				live: true,
				lock: "START_IN_PROGRESS",
				source: "source_lost",
				carrying: () => "carrying",
			}),
		);
		expect(r.ready).toBe(true);
		expect(r.live).toBe(true);
		expect(r.checks[0]).toEqual({ id: "lock", state: "ok" });
		expect(r.checks[1]).toEqual({ id: "source", state: "ok" });
	});

	test("one carrying link is ready and vouches for the receiver", () => {
		const r = evaluateStreamReadiness(
			inputs({
				live: true,
				receiver: { configured: true, evidence: undefined },
				uplinks: [up("wwan0"), up("wwan1")],
				carrying: carryingBy({ wwan0: "not_carrying", wwan1: "carrying" }),
			}),
		);
		expect(r.ready).toBe(true);
		expect(r.reason).toBeUndefined();
		expect(r.uplinks).toEqual({ usable: 1, total: 2 });
	});

	test("every link positively carrying nothing blocks", () => {
		const r = evaluateStreamReadiness(
			inputs({
				live: true,
				uplinks: [up("wwan0"), up("wwan1")],
				carrying: () => "not_carrying",
			}),
		);
		expect(r.ready).toBe(false);
		expect(r.reason).toEqual({
			check: "uplinks",
			code: READINESS_NO_LINK_CARRYING,
		});
	});

	test("no claim either way is unknown, not blocked", () => {
		const r = evaluateStreamReadiness(
			inputs({
				live: true,
				uplinks: [up("wwan0"), up("wwan1")],
				carrying: carryingBy({ wwan0: "not_carrying" }),
			}),
		);
		expect(r.ready).toBe(true);
		expect(r.reason).toEqual({
			check: "uplinks",
			code: READINESS_CARRYING_UNKNOWN,
		});
	});

	test("the health check state does not matter while live", () => {
		const r = evaluateStreamReadiness(
			inputs({
				live: true,
				uplinks: [down("wwan0")],
				carrying: () => "carrying",
			}),
		);
		expect(r.ready).toBe(true);
	});
});

describe("receiver evidence", () => {
	test("keys on the relay id, else on address and port", () => {
		expect(receiverKey({ relay_server: "r1", srtla_addr: "x" })).toBe(
			"relay:r1",
		);
		expect(
			receiverKey({ srtla_addr: " Relay.Example ", srtla_port: 5000 }),
		).toBe("addr:relay.example:5000");
		expect(receiverKey({ srtla_addr: "relay.example" })).toBeUndefined();
		expect(receiverKey({ srtla_addr: "  ", srtla_port: 5000 })).toBeUndefined();
		expect(receiverKey({})).toBeUndefined();
	});

	test("evidence for one destination never vouches for another", () => {
		noteReceiverEvidence("addr:a:1", "reachable", 0);
		expect(receiverEvidenceFor("addr:a:1", 10)).toBe("reachable");
		expect(receiverEvidenceFor("addr:b:1", 10)).toBeUndefined();
		expect(receiverEvidenceFor(undefined, 10)).toBeUndefined();
	});

	test("evidence expires", () => {
		noteReceiverEvidence("addr:a:1", "refused", 0);
		expect(receiverEvidenceFor("addr:a:1", RECEIVER_EVIDENCE_TTL_MS)).toBe(
			"refused",
		);
		expect(
			receiverEvidenceFor("addr:a:1", RECEIVER_EVIDENCE_TTL_MS + 1),
		).toBeUndefined();
	});
});

describe("getStreamReadiness", () => {
	const record = (iface: string): UplinkHealthRecord => ({
		iface,
		kind: "cellular",
		state: "up",
		weight: 100,
		lastTransition: 0,
		staleAt: 0,
		probes: { successes: 1, failures: 0 },
		signals: {},
	});

	test("reads its inputs from the deps and validates against the wire schema", () => {
		setReadinessDepsForTest({
			now: () => 5,
			live: () => false,
			lock: () => undefined,
			source: () => undefined,
			receiverKey: () => "addr:relay:5000",
			uplinks: () => [record("wwan0")],
		});
		const r = getStreamReadiness();
		expect(streamReadinessSchema.parse(r)).toEqual(r);
		expect(r.ready).toBe(true);
		expect(r.reason).toEqual({
			check: "receiver",
			code: READINESS_RECEIVER_UNTESTED,
		});
		expect(r.at).toBe(5);
	});

	test("a carrying live stream leaves reachability evidence for later", () => {
		let live = true;
		setReadinessDepsForTest({
			now: () => 100,
			live: () => live,
			lock: () => undefined,
			source: () => undefined,
			receiverKey: () => "addr:relay:5000",
			uplinks: () => [record("wwan0")],
			carrying: () => "carrying",
		});
		expect(getStreamReadiness().ready).toBe(true);
		live = false;
		const after = getStreamReadiness();
		expect(after.reason).toBeUndefined();
		expect(after.checks[2]).toEqual({ id: "receiver", state: "ok" });
	});

	test("a live stream with nothing carrying leaves no evidence", () => {
		let live = true;
		setReadinessDepsForTest({
			now: () => 100,
			live: () => live,
			lock: () => undefined,
			source: () => undefined,
			receiverKey: () => "addr:relay:5000",
			uplinks: () => [record("wwan0")],
			carrying: () => "unknown",
		});
		getStreamReadiness();
		live = false;
		expect(getStreamReadiness().reason?.code).toBe(READINESS_RECEIVER_UNTESTED);
	});
});
