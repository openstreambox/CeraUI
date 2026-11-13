import type { Telemetry } from "@ceraui/srtla-send/telemetry";

/** A newly published map is intent, not a sender acknowledgement. Only a
 * subsequent fresh producer snapshot can prove its old sockets are absent.
 * Legacy snapshots without physical identity cannot certify a partial removal.
 */
export function cellularSourceWithdrawalConfirmed(
	snapshot: Telemetry | null,
	fresh: boolean,
	readAt: number,
	now: number,
	withdrawnAt: number,
	linkId: string,
	devices: readonly string[],
): boolean {
	if (
		!snapshot?.bind_map_status ||
		snapshot.bind_map_status.state === "absent" ||
		!snapshot.disposition ||
		!["mapped", "retained_last_valid", "required_binding_refused"].includes(
			snapshot.disposition.state,
		) ||
		!fresh ||
		!linkId ||
		readAt <= withdrawnAt ||
		snapshot.last_updated_ms <= withdrawnAt ||
		readAt > now ||
		snapshot.last_updated_ms > now ||
		now - readAt > 5000 ||
		now - snapshot.last_updated_ms > 5000
	)
		return false;
	return snapshot.connections.every(
		(connection) =>
			!!connection.link_id &&
			connection.link_id !== linkId &&
			(!connection.iface || !devices.includes(connection.iface)),
	);
}
