import type { BindMapIdentity, Telemetry } from "@ceraui/srtla-send/telemetry";

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
	expected: BindMapIdentity,
): boolean {
	if (
		![readAt, now, withdrawnAt].every(Number.isFinite) ||
		!Number.isSafeInteger(expected.generation) ||
		expected.generation < 1 ||
		!/^[a-f0-9]{64}$/.test(expected.ips_file_sha256) ||
		snapshot?.bind_map_applied?.generation !== expected.generation ||
		snapshot.bind_map_applied.ips_file_sha256 !== expected.ips_file_sha256 ||
		!snapshot?.bind_map_status ||
		snapshot.bind_map_status.state === "absent" ||
		!snapshot.disposition ||
		!["mapped", "retained_last_valid", "required_binding_refused"].includes(
			snapshot.disposition.state,
		) ||
		!fresh ||
		!linkId ||
		readAt <= withdrawnAt ||
		readAt > now ||
		now - readAt > 5000
	)
		return false;
	return snapshot.connections.every(
		(connection) =>
			!!connection.link_id &&
			connection.link_id !== linkId &&
			(!connection.iface || !devices.includes(connection.iface)),
	);
}
