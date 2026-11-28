import type { WifiInterface } from "@ceraui/rpc/schemas";

/**
 * The operator's hotspot radio choice: the row id plus the runtime incarnation
 * it carried when chosen. Both are per backend process, so the pair expires on
 * a backend restart, a replug or a degraded row and is never carried over.
 */
export type HotspotRadioSelection = readonly [
	id: string,
	incarnation: string | undefined,
];

/**
 * The picker's state. `lost` keeps the id of a selection that expired, so the
 * card does not drift onto a different radio the operator never picked.
 */
export type HotspotRadioChoice = {
	readonly selected?: HotspotRadioSelection;
	readonly lost?: string;
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

function findSelected(
	radios: readonly [string, WifiInterface][],
	[id, incarnation]: HotspotRadioSelection,
): [string, WifiInterface] | undefined {
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
	return row ? { selected: [row[0], row[1].incarnation] } : {};
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
	if (!choice.selected || findSelected(radios, choice.selected)) return choice;
	return { lost: choice.selected[0] };
}

/**
 * The radio the hotspot card targets. A valid selection wins; an invalid one
 * targets nothing. Without a selection only a single capable radio is
 * preselected, and not when it is a different radio from one whose selection
 * just expired. Several capable radios always need an explicit choice.
 */
export function chooseHotspotRadio(
	radios: readonly [string, WifiInterface][],
	choice: HotspotRadioChoice = {},
): [string, WifiInterface] | undefined {
	if (choice.selected) return findSelected(radios, choice.selected);
	const capable = hotspotCapableRadios(radios);
	const only = capable.length === 1 ? capable[0] : undefined;
	return only && (choice.lost === undefined || only[0] === choice.lost)
		? only
		: undefined;
}

const MAC_SHAPED = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;

/** The picker label: adapter name and interface, never a hardware address. */
export function hotspotRadioLabel(radio: WifiInterface): string {
	const hw = radio.hw.trim();
	return hw && !MAC_SHAPED.test(hw) && hw !== radio.ifname
		? `${hw} · ${radio.ifname}`
		: radio.ifname;
}
