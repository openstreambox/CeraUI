import { afterEach, describe, expect, test } from "bun:test";
import { streamReadinessSchema } from "@ceraui/rpc/schemas";
import {
	endpointKey,
	evaluateStreamReadiness,
	getStreamReadiness,
	noteReceiverEvidence,
	OK,
	READINESS_CARRYING_UNKNOWN,
	READINESS_NO_LINK_CARRYING,
	READINESS_NO_UPLINK,
	READINESS_NO_UPLINK_PASSES,
	READINESS_RECEIVER_INVALID,
	READINESS_RECEIVER_NOT_SET,
	READINESS_RECEIVER_REFUSED,
	READINESS_RECEIVER_UNRESOLVED,
	READINESS_RECEIVER_UNTESTED,
	READINESS_UPLINK_UNCHECKED,
	RECEIVER_EVIDENCE_MAX,
	RECEIVER_EVIDENCE_TTL_MS,
	type ReadinessInputs,
	receiverEvidenceFor,
	resetStreamReadinessForTest,
	setReadinessDepsForTest,
	type UplinkCandidate,
	uplinkPasses,
} from "./stream-readiness.ts";

const NOW = 1_000_000;

const fresh = (
	iface: string,
	state: "up" | "degraded" | "down" = "up",
	reason?: "probe_failed" | "passive_congestion",
): UplinkCandidate => ({
	iface,
	health: { state, ...(reason ? { reason } : {}), staleAt: NOW + 10_000 },
});

function inputs(overrides: Partial<ReadinessInputs> = {}): ReadinessInputs {
	return {
		now: NOW,
		live: false,
		lock: OK,
		source: OK,
		receiver: { configured: "yes", evidence: "reachable", local: false },
		candidates: [fresh("wwan0")],
		senderLinks: [],
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
				lock: { state: "blocked", code: "recovery_pending" },
				source: { state: "blocked", code: "source_lost" },
				receiver: { configured: "no", evidence: undefined, local: false },
				candidates: [],
			}),
		);
		expect(r.ready).toBe(false);
		expect(r.reason).toEqual({ check: "lock", code: "recovery_pending" });
		expect(r.checks.filter((c) => c.state === "blocked")).toHaveLength(4);
	});

	test("an unknown lock is reported but does not block", () => {
		const r = evaluateStreamReadiness(
			inputs({ lock: { state: "unknown", code: "update_state_unconfirmed" } }),
		);
		expect(r.ready).toBe(true);
		expect(r.reason).toEqual({
			check: "lock",
			code: "update_state_unconfirmed",
		});
	});

	test("the source code is passed through as Start words it", () => {
		const r = evaluateStreamReadiness(
			inputs({ source: { state: "blocked", code: "source_lost" } }),
		);
		expect(r.ready).toBe(false);
		expect(r.reason).toEqual({ check: "source", code: "source_lost" });
	});

	test("no destination, or one Start cannot resolve, blocks", () => {
		expect(
			evaluateStreamReadiness(
				inputs({
					receiver: { configured: "no", evidence: undefined, local: false },
				}),
			).reason,
		).toEqual({ check: "receiver", code: READINESS_RECEIVER_NOT_SET });
		expect(
			evaluateStreamReadiness(
				inputs({
					receiver: {
						configured: "invalid",
						evidence: undefined,
						local: false,
					},
				}),
			).reason,
		).toEqual({ check: "receiver", code: READINESS_RECEIVER_INVALID });
	});

	test.each([
		[undefined, true, READINESS_RECEIVER_UNTESTED],
		["inconclusive", true, READINESS_RECEIVER_UNTESTED],
		["unresolved", true, READINESS_RECEIVER_UNRESOLVED],
		["refused", false, READINESS_RECEIVER_REFUSED],
	] as const)(
		"destination evidence %s: ready=%s, %s",
		(evidence, ready, code) => {
			const r = evaluateStreamReadiness(
				inputs({ receiver: { configured: "yes", evidence, local: false } }),
			);
			expect(r.ready).toBe(ready);
			expect(r.reason).toEqual({ check: "receiver", code });
		},
	);

	test("no bond candidate at all blocks", () => {
		const r = evaluateStreamReadiness(inputs({ candidates: [] }));
		expect(r.ready).toBe(false);
		expect(r.reason).toEqual({ check: "uplinks", code: READINESS_NO_UPLINK });
	});

	test("candidates that all fail a fresh check block", () => {
		const r = evaluateStreamReadiness(
			inputs({
				candidates: [
					fresh("wwan0", "down", "probe_failed"),
					fresh("eth0", "degraded", "probe_failed"),
				],
			}),
		);
		expect(r.ready).toBe(false);
		expect(r.reason).toEqual({
			check: "uplinks",
			code: READINESS_NO_UPLINK_PASSES,
		});
		expect(r.uplinks).toEqual({ usable: 0, total: 2 });
	});

	test("an expired or missing health record is unknown, not passing", () => {
		const expired: UplinkCandidate = {
			iface: "eth0",
			health: { state: "up", staleAt: NOW - 1 },
		};
		for (const candidates of [[expired], [{ iface: "eth0" }]]) {
			const r = evaluateStreamReadiness(inputs({ candidates }));
			expect(r.ready).toBe(true);
			expect(r.uplinks.usable).toBe(0);
			expect(r.reason).toEqual({
				check: "uplinks",
				code: READINESS_UPLINK_UNCHECKED,
			});
		}
	});

	test("a receiver on the LAN needs a same-subnet interface, not the internet", () => {
		const lan = {
			configured: "yes" as const,
			evidence: undefined,
			local: true,
		};
		const r = evaluateStreamReadiness(
			inputs({
				receiver: lan,
				candidates: [fresh("eth0", "down", "probe_failed")],
			}),
		);
		expect(r.ready).toBe(true);
		expect(r.checks[3]).toEqual({ id: "uplinks", state: "ok" });
		expect(
			evaluateStreamReadiness(inputs({ receiver: lan, candidates: [] })).reason,
		).toEqual({ check: "uplinks", code: READINESS_NO_UPLINK });
	});

	test("one passing candidate among dead ones is enough", () => {
		const r = evaluateStreamReadiness(
			inputs({
				candidates: [fresh("wwan0", "down", "probe_failed"), fresh("wwan1")],
			}),
		);
		expect(r.ready).toBe(true);
		expect(r.uplinks).toEqual({ usable: 1, total: 2 });
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
	test("lock and source are ok while the stream runs", () => {
		const r = evaluateStreamReadiness(
			inputs({
				live: true,
				lock: { state: "blocked", code: "START_IN_PROGRESS" },
				source: { state: "blocked", code: "source_lost" },
				senderLinks: [{ iface: "wwan0", carrying: true }],
			}),
		);
		expect(r.ready).toBe(true);
		expect(r.checks[0]).toEqual({ id: "lock", state: "ok" });
		expect(r.checks[1]).toEqual({ id: "source", state: "ok" });
	});

	test("while live the saved destination is not judged", () => {
		for (const configured of ["no", "invalid"] as const) {
			const r = evaluateStreamReadiness(
				inputs({
					live: true,
					receiver: { configured, evidence: "refused", local: false },
					senderLinks: [{ iface: "wwan0", carrying: true }],
				}),
			);
			expect(r.ready).toBe(true);
			expect(r.checks[2]).toEqual({ id: "receiver", state: "ok" });
		}
		const silent = evaluateStreamReadiness(
			inputs({
				live: true,
				receiver: { configured: "invalid", evidence: undefined, local: false },
				senderLinks: [{ iface: "wwan0" }],
			}),
		);
		expect(silent.checks[2]).toEqual({
			id: "receiver",
			state: "unknown",
			code: READINESS_RECEIVER_UNTESTED,
		});
	});

	test("one carrying sender link is ready and covers the destination", () => {
		const r = evaluateStreamReadiness(
			inputs({
				live: true,
				receiver: { configured: "yes", evidence: undefined, local: false },
				senderLinks: [
					{ iface: "wwan0", carrying: false },
					{ iface: "wwan1", carrying: true },
				],
			}),
		);
		expect(r.ready).toBe(true);
		expect(r.reason).toBeUndefined();
		expect(r.uplinks).toEqual({ usable: 1, total: 2 });
	});

	test("every sender link positively carrying nothing blocks", () => {
		const r = evaluateStreamReadiness(
			inputs({
				live: true,
				senderLinks: [
					{ iface: "wwan0", carrying: false },
					{ iface: "wwan1", carrying: false },
				],
			}),
		);
		expect(r.ready).toBe(false);
		expect(r.reason).toEqual({
			check: "uplinks",
			code: READINESS_NO_LINK_CARRYING,
		});
	});

	test("only the sender's rows count: idle health records are ignored", () => {
		const r = evaluateStreamReadiness(
			inputs({
				live: true,
				candidates: [fresh("eth0")],
				senderLinks: [{ iface: "wwan0", carrying: false }],
			}),
		);
		expect(r.ready).toBe(false);
		expect(r.uplinks).toEqual({ usable: 0, total: 1 });
	});

	test("no claim, or no rows, is unknown and does not block", () => {
		for (const senderLinks of [
			[{ iface: "wwan0", carrying: false }, { iface: "wwan1" }],
			[],
		]) {
			const r = evaluateStreamReadiness(inputs({ live: true, senderLinks }));
			expect(r.ready).toBe(true);
			expect(r.checks[3]).toEqual({
				id: "uplinks",
				state: "unknown",
				code: READINESS_CARRYING_UNKNOWN,
			});
		}
	});
});

describe("receiver evidence", () => {
	test("keys on the resolved host and port", () => {
		expect(endpointKey(" Relay.Example ", 5000)).toBe("relay.example:5000");
		expect(endpointKey("  ", 5000)).toBeUndefined();
	});

	test("testing one endpoint never evicts another", () => {
		noteReceiverEvidence("a:1", "reachable", 0);
		noteReceiverEvidence("b:1", "refused", 1);
		expect(receiverEvidenceFor("a:1", 10)).toBe("reachable");
		expect(receiverEvidenceFor("b:1", 10)).toBe("refused");
		expect(receiverEvidenceFor("c:1", 10)).toBeUndefined();
		expect(receiverEvidenceFor(undefined, 10)).toBeUndefined();
	});

	test("a newer inconclusive test supersedes an older verdict", () => {
		noteReceiverEvidence("a:1", "refused", 0);
		noteReceiverEvidence("a:1", "inconclusive", 5);
		expect(receiverEvidenceFor("a:1", 10)).toBe("inconclusive");
	});

	test("evidence expires and the store stays bounded", () => {
		noteReceiverEvidence("a:1", "refused", 0);
		expect(receiverEvidenceFor("a:1", RECEIVER_EVIDENCE_TTL_MS)).toBe(
			"refused",
		);
		expect(
			receiverEvidenceFor("a:1", RECEIVER_EVIDENCE_TTL_MS + 1),
		).toBeUndefined();
		for (let i = 0; i <= RECEIVER_EVIDENCE_MAX; i++)
			noteReceiverEvidence(`h${i}:1`, "reachable", 0);
		expect(receiverEvidenceFor("h0:1", 1)).toBeUndefined();
		expect(receiverEvidenceFor(`h${RECEIVER_EVIDENCE_MAX}:1`, 1)).toBe(
			"reachable",
		);
	});
});

describe("getStreamReadiness", () => {
	test("reads its inputs from the deps and validates against the wire schema", () => {
		setReadinessDepsForTest({
			now: () => NOW,
			live: () => false,
			lock: () => OK,
			source: () => OK,
			receiver: () => ({ configured: "yes", key: "relay:5000", local: false }),
			candidates: () => [fresh("wwan0")],
		});
		const r = getStreamReadiness();
		expect(streamReadinessSchema.parse(r)).toEqual(r);
		expect(r.ready).toBe(true);
		expect(r.reason).toEqual({
			check: "receiver",
			code: READINESS_RECEIVER_UNTESTED,
		});
		expect(r.at).toBe(NOW);
	});

	test("uses the evidence recorded for the resolved endpoint", () => {
		noteReceiverEvidence("relay:5000", "refused", NOW);
		setReadinessDepsForTest({
			now: () => NOW,
			live: () => false,
			lock: () => OK,
			source: () => OK,
			receiver: () => ({ configured: "yes", key: "relay:5000", local: false }),
			candidates: () => [fresh("wwan0")],
		});
		expect(getStreamReadiness().reason).toEqual({
			check: "receiver",
			code: READINESS_RECEIVER_REFUSED,
		});
	});

	test("is read-only: a carrying stream leaves no evidence for a later destination", () => {
		let live = true;
		setReadinessDepsForTest({
			now: () => NOW,
			live: () => live,
			lock: () => OK,
			source: () => OK,
			receiver: () => ({ configured: "yes", key: "next:5000", local: false }),
			candidates: () => [fresh("wwan0")],
			senderLinks: () => [{ iface: "wwan0", carrying: true }],
		});
		expect(getStreamReadiness().checks[2]).toEqual({
			id: "receiver",
			state: "ok",
		});
		live = false;
		expect(getStreamReadiness().reason?.code).toBe(READINESS_RECEIVER_UNTESTED);
		expect(receiverEvidenceFor("next:5000", NOW)).toBeUndefined();
	});

	test("while idle the lock and source deps are consulted; while live they are not", () => {
		let calls = 0;
		const counted = () => {
			calls += 1;
			return OK;
		};
		setReadinessDepsForTest({
			now: () => NOW,
			live: () => true,
			lock: counted,
			source: counted,
			receiver: () => ({ configured: "yes", key: "r:1", local: false }),
			senderLinks: () => [],
		});
		getStreamReadiness();
		expect(calls).toBe(0);
	});
});
