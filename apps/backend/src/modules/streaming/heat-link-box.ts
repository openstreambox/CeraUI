import type { StreamLiveness } from "../system/disruptive-action-gate.ts";
import {
	advanceHeat,
	HEAT_SETTINGS,
	type HeatState,
	initialHeat,
} from "./heat-ladder.ts";
import type { BoxSample, LinkBoxHeatPolicy } from "./heat-link-box-share.ts";

/** Client owners must supply identities and measured capacity, never infer them
 * from carrying alone. An absent snapshot withholds the visible steps. */
export interface LinkBoxEvidence {
	/** Legacy identity/headroom fields do not authorize a restriction. Only a
	 * complete measured snapshot through the session policy can do so. */
	measured?: { sample: BoxSample; policy: LinkBoxHeatPolicy };
	at: number;
	carrying: StreamLiveness;
	encoder: boolean;
	mainLink: string | null;
	phone: string | null;
	links: {
		id: string;
		healthy: boolean;
		headroom: number | null;
		recovering: boolean;
	}[];
	clients: { id: string; management: boolean }[] | null;
}
export function planLinkBoxHeat(
	stage: number,
	known: boolean,
	keep: boolean,
	e: LinkBoxEvidence,
	now: number,
): { usb: boolean; lend: string | null; pause: string[] } {
	const fresh =
		Number.isFinite(e.at) && now >= e.at && now - e.at <= HEAT_SETTINGS.staleMs;
	const eligible = fresh && e.carrying === "streaming" && !e.encoder && known;
	const result: { usb: boolean; lend: string | null; pause: string[] } = {
		usb: eligible && stage >= 1,
		lend: null,
		pause: [],
	};
	if (!e.measured) return result;
	const { sample, policy } = e.measured;
	// A veto must reach the stateful policy as well as the returned plan, so a
	// later eligible snapshot cannot resume an old restriction without dwell.
	const matches =
		sample.now === now &&
		sample.encoder === e.encoder &&
		sample.keepQuality === keep;
	const measured = policy.tick({
		...sample,
		now,
		carrying: eligible && matches && sample.carrying,
		encoder: e.encoder,
		keepQuality: keep,
		soc: known ? sample.soc : null,
	});
	return {
		usb: result.usb,
		lend: stage >= 2 ? measured.lend : null,
		pause: stage >= 3 ? measured.pause : [],
	};
}

/** Sensor composition for a carrying-only session. Missing path/client evidence
 * intentionally leaves both traffic restrictions empty on this base. */
export function linkBoxHeatTick(
	previous: HeatState,
	soc: number | null,
	now: number,
	carrying: StreamLiveness,
	encoder: boolean,
) {
	if (encoder || carrying === "idle")
		return {
			owned: false,
			heat: initialHeat(),
			key: "",
			plan: { usb: false, lend: null, pause: [] },
		};
	const heat = advanceHeat(previous, { soc }, now);
	const plan = planLinkBoxHeat(
		heat.stage,
		!heat.unknown,
		heat.keepQuality,
		{
			at: now,
			carrying,
			encoder,
			mainLink: null,
			phone: null,
			links: [],
			clients: null,
		},
		now,
	);
	return {
		owned: true,
		heat,
		plan,
		key:
			heat.stage >= 2
				? "notifications.linkBoxHeatWaiting"
				: heat.stage >= 1
					? "live.heat.warm"
					: "",
	};
}
