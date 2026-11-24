import type { WifiInterface } from "@ceraui/rpc/schemas";

/**
 * The operator's hotspot radio choice: the row id plus the runtime incarnation
 * it carried when chosen. Both are per backend process, so the pair expires on
 * a backend restart, a replug or a degraded row and is never carried over. A
 * row without an incarnation can never be picked or matched.
 */
export type HotspotRadioSelection = readonly [id: string, incarnation: string];

/**
 * The picker's state. `lost` records that a pick expired: from then on nothing
 * is preselected, not even a single remaining radio with the same id, until the
 * operator picks again.
 */
export type HotspotRadioChoice = {
	readonly selected?: HotspotRadioSelection;
	readonly lost?: true;
};

/**
 * Radios that can host the hotspot. A live AP stays listed even when its status
 * omits `supports_hotspot` (only a live AP carries a `hotspot` block).
 */
export function hotspotCapableRadios(
	radios: readonly [string, WifiInterface][],
): [string, WifiInterface][] {
	return radios.filter(
		([, radio]) =>
			(radio.supports_hotspot || radio.hotspot) && !radio.degraded_reason,
	);
}

/** The capable row carrying exactly this id and this (present) incarnation. */
export function findHotspotRadio(
	radios: readonly [string, WifiInterface][],
	[id, incarnation]: readonly [string, string | undefined],
): [string, WifiInterface] | undefined {
	if (!incarnation) return undefined;
	return hotspotCapableRadios(radios).find(
		([candidate, radio]) =>
			candidate === id && radio.incarnation === incarnation,
	);
}

/** Record a pick from the radio list as an expiring `[id, incarnation]` target. */
export function pickHotspotRadio(
	radios: readonly [string, WifiInterface][],
	id: string,
): HotspotRadioChoice {
	const row = hotspotCapableRadios(radios).find(
		([candidate]) => candidate === id,
	);
	const incarnation = row?.[1].incarnation;
	return row && incarnation ? { selected: [row[0], incarnation] } : {};
}

/**
 * Drop a selection whose radio is gone, changed incarnation or degraded. The
 * same object comes back while nothing expired, so callers can compare by
 * identity before writing state.
 */
export function expireHotspotChoice(
	radios: readonly [string, WifiInterface][],
	choice: HotspotRadioChoice,
): HotspotRadioChoice {
	if (!choice.selected || findHotspotRadio(radios, choice.selected))
		return choice;
	return { lost: true };
}

/**
 * The radio the hotspot card targets. A valid selection wins; an invalid one
 * targets nothing. Without a selection only a single capable radio that
 * carries an incarnation is preselected, and never after a pick expired.
 * Several capable radios always need an explicit choice.
 */
export function chooseHotspotRadio(
	radios: readonly [string, WifiInterface][],
	choice: HotspotRadioChoice = {},
): [string, WifiInterface] | undefined {
	if (choice.selected) return findHotspotRadio(radios, choice.selected);
	if (choice.lost) return undefined;
	const capable = hotspotCapableRadios(radios);
	const only = capable.length === 1 ? capable[0] : undefined;
	return only?.[1].incarnation ? only : undefined;
}

const MAC_SHAPED = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;

/** The picker label: adapter name and interface, never a hardware address. */
export function hotspotRadioLabel(radio: WifiInterface): string {
	const hw = radio.hw.trim();
	return hw && !MAC_SHAPED.test(hw) && hw !== radio.ifname
		? `${hw} · ${radio.ifname}`
		: radio.ifname;
}
