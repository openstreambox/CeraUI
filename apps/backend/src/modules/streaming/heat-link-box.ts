import type { StreamLiveness } from "../system/disruptive-action-gate.ts";
import {
	advanceHeat,
	HEAT_SETTINGS,
	type HeatState,
	initialHeat,
} from "./heat-ladder.ts";

/** Client owners must supply identities and measured capacity, never infer them
 * from carrying alone. An absent snapshot withholds the visible steps. */
export interface LinkBoxEvidence {
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
	if (
		!eligible ||
		keep ||
		stage < 2 ||
		!e.mainLink ||
		!e.links.some((l) => l.id === e.mainLink) ||
		new Set(e.links.map((l) => l.id)).size !== e.links.length
	)
		return result;
	const strong = (l: LinkBoxEvidence["links"][number]) =>
		l.healthy &&
		!l.recovering &&
		l.headroom !== null &&
		Number.isFinite(l.headroom) &&
		l.headroom >= HEAT_SETTINGS.spareLinkHeadroom;
	result.lend =
		e.links.find(
			(l) =>
				l.id !== e.mainLink &&
				l.healthy &&
				!l.recovering &&
				e.links.filter((p) => p.id !== l.id && strong(p)).length >=
					HEAT_SETTINGS.spareLinkHealthyPeers,
		)?.id ?? null;
	if (
		stage >= 3 &&
		result.lend &&
		e.phone &&
		e.clients?.some((c) => c.id === e.phone) &&
		new Set(e.clients.map((c) => c.id)).size === e.clients.length
	)
		result.pause = e.clients
			.filter((c) => c.id !== e.phone && !c.management)
			.map((c) => c.id);
	return result;
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
