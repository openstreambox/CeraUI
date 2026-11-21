/**
 * Pure OS-toggle confirm predicates — T18 (ceraui-os-interaction-ux)
 *
 * The hotspot start/stop and SSH start/stop dialogs both keep their keyed
 * async-operation `pending` after dispatch and resolve it only when the live
 * authoritative snapshot reports the intended target state (the per-surface
 * confirm `$effect`). The two decisions that drive those effects — "is the
 * surface active?" and "does the snapshot match the pending target?" — are
 * extracted here as rune-free, side-effect-free predicates so they can be
 * unit-tested directly and reused verbatim by the dialogs.
 *
 * Keeping them pure is the same discipline the sibling T5–T7 outcome modules
 * follow ({@link ./wifi-connect-outcome}, {@link ./modem-config-echo}); the
 * dialog stays a thin reactive shell over a tested core.
 */

/** The pending intent of a hotspot start/stop op (null = no op in flight). */
export type HotspotToggleTarget = "hotspot" | "station" | null;

/**
 * Whether a WiFi interface is broadcasting a hotspot RIGHT NOW.
 *
 * `hotspot` alone is NOT that signal: a current device sends the saved setup
 * (name, password, channel map) on every radio that can host one, on or off,
 * so the dialog can be edited while the AP is down. Reading its presence as
 * "on" labelled a configured-off radio in Station mode Active, with Turn Off.
 *
 * The live answer comes from the radio's own mode plus the AP's own state:
 *  · `mode: "hotspot"` — an exclusive AP is up on the radio;
 *  · `mode: "station"` with a concurrent AP (hybrid) — the wire reports the
 *    station leg, so the AP shows as its client read (`hotspot.clients`, only
 *    ever sent from a live AP) or as the device's own `hybrid` observation;
 *  · no `mode` at all — a backend that predates the field; presence is the
 *    only signal it gives, so it keeps its earlier reading.
 *
 * `entry` is the device's own `getAdapterModes` answer for this radio. It is a
 * pull and can lag, so it only ever ADDS the hybrid case the wire cannot carry;
 * it never overrides a wire `mode` that says otherwise.
 */
export function hotspotIsActive(
	iface:
		| {
				hotspot?: { clients?: unknown } | null;
				mode?: "station" | "hotspot";
		  }
		| null
		| undefined,
	entry?: { mode?: "station" | "hotspot" | "hybrid" },
): boolean {
	if (!iface?.hotspot) return false;
	if (iface.mode === undefined) return true;
	if (iface.mode === "hotspot") return true;
	if (iface.hotspot.clients !== undefined) return true;
	return entry?.mode === "hybrid";
}

/**
 * Whether a pending hotspot start/stop should now confirm: a `hotspot` target
 * confirms once the interface is active, a `station` target once it is inactive.
 * A `null` target (no op in flight) never confirms.
 */
export function hotspotToggleConfirmed(
	target: HotspotToggleTarget,
	isActive: boolean,
	transition?: string,
): boolean {
	if (target === "hotspot") return isActive && transition !== "activating";
	if (target === "station") return !isActive;
	return false;
}

/**
 * Whether the SSH server is active. `ssh.active` is the authoritative status
 * field; an absent status is treated as inactive (mirrors SshDialog's `active`).
 */
export function sshIsActive(
	ssh: { active?: boolean } | null | undefined,
): boolean {
	return ssh?.active ?? false;
}

/**
 * Whether the SSH server survives a reboot — `systemctl is-enabled ssh`, a
 * SEPARATE axis from {@link sshIsActive}. An absent status is treated as not
 * persistent, which is the fail-safe direction: a device that has not told us
 * must never be rendered as "your access is safe across a reboot".
 */
export function sshIsPersistent(
	ssh: { enabled?: boolean } | null | undefined,
): boolean {
	return ssh?.enabled ?? false;
}

/**
 * Whether a pending SSH start/stop should now confirm: the live `ssh.active`
 * exactly matches the intended target. A `null` target (no op in flight) never
 * confirms — distinct from `active === false`, which is a real "now stopped"
 * confirm for a `stop` op.
 *
 * Shared verbatim by the boot-persistence toggle, whose confirm asks the same
 * question of `ssh.enabled` — one predicate, so the two independent controls
 * cannot drift into two different ideas of "the device agrees now".
 */
export function sshToggleConfirmed(
	active: boolean,
	target: boolean | null,
): boolean {
	return target !== null && active === target;
}
