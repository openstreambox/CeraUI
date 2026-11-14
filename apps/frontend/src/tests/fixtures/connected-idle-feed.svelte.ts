import type { LinkTelemetryMessage } from "@ceraui/rpc/schemas";
export const idleFeed = $state({
	live: true,
	connected: true,
	frame: null as LinkTelemetryMessage | null,
});
