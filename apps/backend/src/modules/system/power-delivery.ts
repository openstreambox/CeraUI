import { type Frame, PROTOCOL_VERSION } from "../remote-control/protocol.ts";
import { nextRelaySeq } from "../remote-control/status-relay.ts";

export interface PowerDeliveryDeps {
	legacy: () =>
		| { authenticated: boolean; send: (text: string) => void }
		| undefined;
	controlConnected: () => boolean;
	sendControl: (frame: Frame) => unknown;
}

/** Dedicated telemetry fan-out; never enables a command or generic relay path. */
export function deliverPowerSensors(
	sensors: Record<string, string>,
	deps: PowerDeliveryDeps,
) {
	const legacy = deps.legacy();
	if (legacy?.authenticated) {
		try {
			legacy.send(JSON.stringify({ sensors }));
		} catch {
			/* Reconnect gets a fresh snapshot. */
		}
	}
	if (deps.controlConnected()) {
		try {
			deps.sendControl({
				v: PROTOCOL_VERSION,
				kind: "status",
				type: "sensors",
				cid: crypto.randomUUID(),
				seq: nextRelaySeq("sensors"),
				payload: sensors,
			});
		} catch {
			/* A remote failure must not interrupt local monitoring. */
		}
	}
}
