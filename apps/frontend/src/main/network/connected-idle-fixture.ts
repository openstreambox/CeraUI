import type { LinkTelemetryMessage } from "@ceraui/rpc/schemas";
import type { LinkSignal } from "$lib/types/hud";
export const links = ["SIM 2", "Ethernet"].map(
	(label, linkIndex) =>
		({
			id: `eth${linkIndex}`,
			label,
			linkIndex,
			type: linkIndex ? "ethernet" : "modem",
			enabled: true,
			isConnected: true,
			isStale: false,
			connectionState: "connected",
			signal: null,
			throughputKbps: 0,
			rateTxKbps: 0,
			rateRxKbps: 0,
		}) as LinkSignal,
);
export function telemetry(bitrate = 0): LinkTelemetryMessage {
	return {
		lastReadMs: Date.now(),
		links: links.map((link, i) => ({
			iface: link.id,
			conn_id: String(i),
			rtt_ms: 20,
			nak_count: 0,
			weight_percent: 50,
			stale: false,
			bitrate_bps: i ? 1_000_000 : bitrate,
		})),
	};
}
