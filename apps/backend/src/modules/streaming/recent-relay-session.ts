import { createHash } from "node:crypto";

export function relaySessionKey(
	host: string,
	port: number,
	streamid: string,
): string {
	return createHash("sha256")
		.update(JSON.stringify([host, port, streamid]))
		.digest("hex");
}

/** A peer reject is ambiguous: never grant a retry from the reject alone. */
export function createRecentRelaySession(now = Date.now) {
	let key: string | undefined;
	let validAt = Number.NEGATIVE_INFINITY;
	let active = false;
	return {
		valid(next: string) {
			key = next;
			active = true;
			validAt = now();
		},
		stopped() {
			if (active) validAt = now();
			active = false;
		},
		possiblyBusy(next: string, message: string | undefined) {
			return (
				next === key &&
				now() - validAt <= 45000 &&
				/SRT connect failed \(reason 1000\)/.test(message ?? "")
			);
		},
	};
}

export const recentRelaySession = createRecentRelaySession();
