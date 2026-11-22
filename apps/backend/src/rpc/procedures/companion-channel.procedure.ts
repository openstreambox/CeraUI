import { os } from "@orpc/server";

import {
	type ChannelIngress,
	type ChannelSession,
	CompanionChannel,
} from "../../modules/companion/channel.ts";
import {
	classifyCompanionIngress,
	DEFAULT_TLS_CERT,
	lazySetupHotspotCheck,
	setupHotspotInterface,
	tlsBindingFromCertificate,
} from "../../modules/companion/ingress.ts";
import {
	CompanionStore,
	DEFAULT_COMPANION_STATE_DIR,
} from "../../modules/companion/store.ts";
import {
	type CompanionWifiNetwork,
	parseCompanionWifiInput,
} from "../../modules/wifi/companion-wifi-input.ts";
import { localIngressPresent } from "../local-ingress-presence.ts";
import { runtimeAllowsDevelopment } from "../runtime-mode.ts";
import type { AppWebSocket, RPCContext } from "../types.ts";
import {
	type CompanionSaveResult,
	saveCompanionNetworkOnBox,
} from "./companion-wifi.procedure.ts";

/**
 * Experimental paired companion channel (`osb-companion/1`), behind
 * `CERAUI_EXPERIMENTAL_COMPANION_CHANNEL=1`.
 *
 * These procedures do not use the CeraUI password session: a companion proves
 * itself with its own device key (modules/companion/channel.ts). A socket that
 * passed `companion.auth` may call the companion procedures below and nothing
 * else; it is not signed in to CeraUI.
 */
export interface CompanionProcedureDeps {
	enabled?(): boolean;
	createChannel(onRevoked: (deviceId: string) => void): CompanionChannel;
	ingress(context: RPCContext): ChannelIngress | undefined;
	saveNetwork(network: CompanionWifiNetwork): Promise<CompanionSaveResult>;
}

const REVOKED_CLOSE_CODE = 4403;

export function createCompanionProcedures(deps: CompanionProcedureDeps) {
	const enabled =
		deps.enabled ??
		(() => process.env.CERAUI_EXPERIMENTAL_COMPANION_CHANNEL === "1");
	const sessions = new WeakMap<AppWebSocket, ChannelSession>();
	const deviceSockets = new Map<string, Set<AppWebSocket>>();
	let channel: CompanionChannel | undefined;

	const closeDevice = (deviceId: string) => {
		for (const ws of deviceSockets.get(deviceId) ?? []) {
			const session = sessions.get(ws);
			if (session) session.device = undefined;
			try {
				ws.close(REVOKED_CLOSE_CODE, "revoked");
			} catch {
				// Already closed.
			}
		}
		deviceSockets.delete(deviceId);
	};
	const getChannel = () => {
		channel ??= deps.createChannel(closeDevice);
		return channel;
	};
	const sessionOf = (ws: AppWebSocket) => {
		let session = sessions.get(ws);
		if (!session) {
			session = {};
			sessions.set(ws, session);
		}
		return session;
	};
	const remember = (ws: AppWebSocket, deviceId: string) => {
		const set = deviceSockets.get(deviceId) ?? new Set<AppWebSocket>();
		for (const other of set) if (other.readyState !== 1) set.delete(other);
		set.add(ws);
		deviceSockets.set(deviceId, set);
	};
	/** The adapter's close hook: forget a closed socket at once. */
	const socketClosed = (ws: AppWebSocket) => {
		const deviceId = sessions.get(ws)?.device?.id;
		sessions.delete(ws);
		for (const [id, set] of deviceSockets) {
			if (deviceId !== undefined && id !== deviceId) continue;
			set.delete(ws);
			if (set.size === 0) deviceSockets.delete(id);
		}
	};

	const base = os.$context<RPCContext>();
	const gated = <T>(
		run: (context: RPCContext, ingress: ChannelIngress, input: unknown) => T,
	) =>
		base.handler(async ({ context, input }) => {
			if (!enabled()) return { status: "disabled" as const };
			const ingress = deps.ingress(context);
			if (!ingress) return { status: "refused" as const };
			return run(context, ingress, input);
		});

	return {
		hello: gated((context, ingress, input) =>
			getChannel().hello(sessionOf(context.ws), input, ingress),
		),
		claim: gated((context, ingress, input) => {
			const result = getChannel().claim(sessionOf(context.ws), input, ingress);
			if (result.status === "ok") remember(context.ws, result.device);
			return result;
		}),
		auth: gated((context, ingress, input) => {
			const result = getChannel().auth(sessionOf(context.ws), input, ingress);
			if (result.status === "ok") remember(context.ws, result.device);
			return result;
		}),
		join: gated((context, ingress, input) =>
			getChannel().join(sessionOf(context.ws), input, ingress),
		),
		allow: gated((context, _ingress, input) =>
			getChannel().allow(sessionOf(context.ws), input),
		),
		invite: gated((context) => getChannel().invite(sessionOf(context.ws))),
		devices: gated((context) => getChannel().devices(sessionOf(context.ws))),
		revoke: gated((context, _ingress, input) =>
			getChannel().revoke(sessionOf(context.ws), input),
		),
		wifiImport: gated(async (context, _ingress, input) => {
			const device = getChannel().authorized(sessionOf(context.ws));
			if (device?.role !== "owner")
				return { status: "not_authenticated" as const };
			// Read validation locally so errors never echo a QR or Zod issue.
			const network = parseCompanionWifiInput(input);
			if (!network) return { status: "invalid" as const };
			try {
				return await deps.saveNetwork(network);
			} catch {
				return { status: "save_failed" as const };
			}
		}),
		closeDevice,
		socketClosed,
		trackedSockets: () =>
			[...deviceSockets.values()].reduce((sum, set) => sum + set.size, 0),
	};
}

/**
 * On the image: the interface running the box's own hotspot profile is the
 * setup ingress. The Wi-Fi state reader loads on first use, with the flag on.
 */
const isSetupHotspot = lazySetupHotspotCheck(async () => {
	const { getWifiInterfacesByMacAddress } = await import(
		"../../modules/wifi/wifi-connections.ts"
	);
	return (ifname: string) =>
		setupHotspotInterface(
			Object.values(getWifiInterfacesByMacAddress()),
			ifname,
		);
});

export const companionProcedures = createCompanionProcedures({
	createChannel: (onRevoked) =>
		new CompanionChannel({
			store: new CompanionStore(
				process.env.CERAUI_COMPANION_STATE_DIR ?? DEFAULT_COMPANION_STATE_DIR,
			),
			onRevoked,
		}),
	ingress: (context) =>
		classifyCompanionIngress(context, {
			frontDoor: localIngressPresent,
			isSetupHotspot,
			development: () =>
				process.env.NODE_ENV !== "production" && runtimeAllowsDevelopment(),
			tlsBinding: () =>
				tlsBindingFromCertificate(
					process.env.CERAUI_COMPANION_TLS_CERT ?? DEFAULT_TLS_CERT,
				),
		}),
	saveNetwork: saveCompanionNetworkOnBox,
});
