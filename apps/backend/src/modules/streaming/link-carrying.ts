/*
  IS ANY OTHER LINK CARRYING THE STREAM?

  Decides what a link stuck on an old address costs. If another link carried
  traffic within the window, the stream is going out on it and a restart would
  cost a few seconds of BRB for nothing the viewers lack. If no other link
  carried anything for the whole window, the stream is already down and a
  restart costs nothing extra.

  The evidence is the sender's own per-link telemetry: a fresh row whose
  throughput is above zero, or whose sent-bytes counter moved. A gap in fresh
  telemetry is "can't tell", which never counts as "none carrying".
*/

import type { LinkTelemetryMessage } from "./link-telemetry-rows.ts";

export type CarryVerdict = "others_carrying" | "none_carrying" | "unknown";

export const CARRY_WINDOW_MS = 10_000;

export function createCarryTracker(
	now: () => number,
	windowMs = CARRY_WINDOW_MS,
) {
	const lastCarriedAt = new Map<string, number>();
	const lastBytes = new Map<string, number>();
	// Start of the current unbroken run of fresh telemetry.
	let freshSince: number | undefined;
	return {
		sample(telemetry: LinkTelemetryMessage | null): void {
			const at = now();
			const rows = telemetry?.links ?? [];
			if (rows.length === 0 || rows.some((row) => row.stale)) {
				freshSince = undefined;
				return;
			}
			freshSince ??= at;
			for (const row of rows) {
				const previous = lastBytes.get(row.iface);
				const bytes = row.bytes_sent_total;
				const moved =
					bytes !== undefined && previous !== undefined && bytes > previous;
				if (bytes !== undefined) lastBytes.set(row.iface, bytes);
				if (row.bitrate_bps > 0 || moved) lastCarriedAt.set(row.iface, at);
			}
		},
		/**
		 * `stuck` are the interfaces of the stale sources; `bonded` every
		 * interface in the published bond. An unknown stuck interface is "can't
		 * tell": the device would not know which link it judges.
		 */
		judge(
			stuck: readonly (string | undefined)[],
			bonded: readonly string[],
		): CarryVerdict {
			if (stuck.length === 0 || stuck.some((iface) => iface === undefined))
				return "unknown";
			const others = new Set(bonded.filter((iface) => !stuck.includes(iface)));
			for (const [iface, at] of lastCarriedAt)
				if (!stuck.includes(iface) && now() - at <= windowMs)
					return "others_carrying";
			// No other link in the bond at all: nothing else can be carrying.
			if (others.size === 0) return "none_carrying";
			return freshSince !== undefined && now() - freshSince >= windowMs
				? "none_carrying"
				: "unknown";
		},
	};
}
