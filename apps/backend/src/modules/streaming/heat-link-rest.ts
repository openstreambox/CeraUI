import { HEAT_SETTINGS } from "./heat-ladder";
export interface HeatLinkEvidence {
	name: string;
	modem: boolean;
	healthy: boolean;
	/** Fraction of spare carrying capacity. Null means unknown. */
	headroom: number | null;
}

/** Memory-only, single-link rest. Losing peer evidence immediately returns the link. */
export class HeatLinkRest {
	resting: string | null = null;
	update(wanted: boolean, links: readonly HeatLinkEvidence[]): string | null {
		const eligible = (name: string) =>
			links.filter(
				(l) =>
					l.name !== name &&
					l.healthy &&
					l.headroom !== null &&
					Number.isFinite(l.headroom) &&
					l.headroom >= HEAT_SETTINGS.spareLinkHeadroom,
			).length >= HEAT_SETTINGS.spareLinkHealthyPeers;
		if (
			!wanted ||
			(this.resting !== null &&
				(!links.some((l) => l.name === this.resting && l.modem) ||
					!eligible(this.resting)))
		)
			this.resting = null;
		if (wanted && this.resting === null)
			this.resting =
				links.find((l) => l.modem && l.healthy && eligible(l.name))?.name ??
				null;
		return this.resting;
	}
}
