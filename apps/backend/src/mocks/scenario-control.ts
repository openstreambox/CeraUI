/*
	CeraUI - Scripted mock scenarios (dev only)

	The `dev.scenario` procedures call into this module; nothing else does, so a
	production build, where the dev namespace is not registered, drops it along
	with the setters it alone uses.

	A scenario driver plays a script in steps of scenario time. Each step:

	  1. pins the mock clock at (seed, t_ms) — see mock-clock.ts;
	  2. on the first step (t_ms 0, or a new seed) re-seeds the random walk;
	  3. applies one fluctuation, then the step's events;
	  4. broadcasts every surface the scenario drives (modems, Wi-Fi, link
	     telemetry, health, relays) before it returns.

	Because a step's values depend only on its seed, its time and the events up
	to it, two runs of the same script give the same frames at every step. Only
	mock values follow the scenario clock; the real health and staleness logic
	keeps the host's clock.
*/

import type {
	DevScenarioApplyInput,
	DevScenarioEvent,
	DevScenarioStatus,
} from "@ceraui/rpc/schemas";
import { logger } from "../helpers/logger.ts";
import { buildRelaysMsg, getRelays } from "../modules/remote/remote-relays.ts";
import { broadcastHealthIfChanged } from "../modules/streaming/health.ts";
import { broadcastLinkTelemetryIfChanged } from "../modules/streaming/link-telemetry.ts";
import { broadcastMsg } from "../modules/ui/websocket-server.ts";
import {
	getMockClockState,
	pinMockClock,
	unpinMockClock,
} from "./mock-clock.ts";
import {
	getMockState,
	type MockLinkOverride,
	reseedMockWalk,
	runMockFeedbackBroadcast,
	setMockBitrateTarget,
	setMockLinkOverride,
	setMockModemState,
	stepMockFluctuations,
	updateMockState,
} from "./mock-service.ts";

const LINK_FIELDS = [
	"rtt_ms",
	"nak_count",
	"weight_scale",
	"stale",
	"gone",
] as const satisfies readonly (keyof MockLinkOverride)[];

function applyLinkEvent(
	event: Extract<DevScenarioEvent, { type: "box.link" }>,
): void {
	const next: Record<string, number | boolean> = event.reset
		? {}
		: { ...(getMockState().linkOverrides[event.iface] ?? {}) };
	for (const field of LINK_FIELDS) {
		const value = event[field];
		if (value !== undefined) next[field] = value;
	}
	setMockLinkOverride(
		event.iface,
		Object.keys(next).length ? (next as MockLinkOverride) : null,
	);
}

async function applyEvent(event: DevScenarioEvent): Promise<void> {
	switch (event.type) {
		case "box.link":
			applyLinkEvent(event);
			return;
		case "box.bitrate":
			setMockBitrateTarget("reset" in event ? null : event.target_kbps);
			return;
		case "box.modem":
			await setMockModemState(event.id, event.state);
			return;
	}
}

export function getScenarioStatus(): DevScenarioStatus {
	const clock = getMockClockState();
	const state = getMockState();
	return {
		pinned: clock !== null,
		seed: clock?.seed ?? null,
		t_ms: clock?.stepMs ?? null,
		links: structuredClone(state.linkOverrides),
		bitrate_target_kbps: state.bitrateTargetKbps,
	};
}

/** Play one step. The caller has checked the dev, mock and driver gates. */
export async function applyScenarioStep(
	input: DevScenarioApplyInput,
): Promise<DevScenarioStatus> {
	const previous = getMockClockState();
	pinMockClock(input.seed, input.t_ms);
	if (input.t_ms === 0 || previous === null || previous.seed !== input.seed) {
		reseedMockWalk();
	}
	stepMockFluctuations();
	for (const event of input.events) await applyEvent(event);

	// Every driven surface, now, rather than on the coalesced 5 s ticks: those
	// would show the step up to five seconds late, at a host-timed moment.
	await runMockFeedbackBroadcast();
	broadcastLinkTelemetryIfChanged();
	broadcastHealthIfChanged();
	if (getRelays()) broadcastMsg("relays", buildRelaysMsg());
	return getScenarioStatus();
}

/** Back to unscripted mocks: host clock, no overrides. */
export function resetScenario(): DevScenarioStatus {
	unpinMockClock();
	updateMockState({ linkOverrides: {}, bitrateTargetKbps: null });
	broadcastLinkTelemetryIfChanged();
	logger.info("🎭 Scenario control reset: mock clock unpinned");
	return getScenarioStatus();
}
