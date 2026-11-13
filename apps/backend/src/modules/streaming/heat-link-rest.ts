import { HEAT_SETTINGS } from "./heat-ladder";
export interface HeatLinkEvidence {
	name: string;
	modem: boolean;
	healthy: boolean;
	/** Fraction of spare carrying capacity. Null means unknown. */
	headroom: number | null;
}

/** Why the last wanted rest did not happen: no capacity figures, or too few strong peers. */
export type HeatRestBlocked = "capacity" | "peers" | null;

/** Memory-only, single-link rest. Losing peer evidence immediately returns the link. */
export class HeatLinkRest {
	resting: string | null = null;
	blocked: HeatRestBlocked = null;
	private strongPeers(name: string, links: readonly HeatLinkEvidence[]) {
		return links.filter(
			(l) =>
				l.name !== name &&
				l.healthy &&
				l.headroom !== null &&
				Number.isFinite(l.headroom) &&
				l.headroom >= HEAT_SETTINGS.spareLinkHeadroom,
		).length;
	}
	/**
	 * The return half alone: bring the resting link back when it is gone or its
	 * peers no longer carry the stream with room to spare. Never starts a rest,
	 * so it may run on any event, whatever the heat state or engine connection.
	 */
	release(links: readonly HeatLinkEvidence[]): string | null {
		if (
			this.resting !== null &&
			(!links.some((l) => l.name === this.resting && l.modem) ||
				this.strongPeers(this.resting, links) <
					HEAT_SETTINGS.spareLinkHealthyPeers)
		)
			this.resting = null;
		return this.resting;
	}
	update(wanted: boolean, links: readonly HeatLinkEvidence[]): string | null {
		this.blocked = null;
		if (!wanted) {
			this.resting = null;
			return null;
		}
		this.release(links);
		if (this.resting === null) {
			const candidates = links.filter((l) => l.modem && l.healthy);
			this.resting =
				candidates.find(
					(l) =>
						this.strongPeers(l.name, links) >=
						HEAT_SETTINGS.spareLinkHealthyPeers,
				)?.name ?? null;
			if (this.resting === null)
				this.blocked = links.some((l) => l.healthy && l.headroom === null)
					? "capacity"
					: "peers";
		}
		return this.resting;
	}
}
