import { os } from "@orpc/server";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import {
	type CompanionWifiNetwork,
	parseCompanionWifiInput,
} from "../../modules/wifi/companion-wifi-input.ts";
import {
	broadcastWifiState,
	wifiUpdateSavedConns,
} from "../../modules/wifi/wifi.ts";
import { localIngressPresent } from "../local-ingress-presence.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

export type CompanionSaveResult =
	| { status: "saved"; uuid: string }
	| { status: "already_saved" };

type ImportResult =
	| CompanionSaveResult
	| { status: "disabled" | "local_only" | "invalid" | "save_failed" };

export interface CompanionWifiDeps {
	save(network: CompanionWifiNetwork): Promise<CompanionSaveResult>;
	enabled?(): boolean;
	/** The image's front door may proxy any client to loopback TCP. */
	frontDoor?(): boolean;
}

export function createCompanionWifiProcedure({
	save,
	enabled = () => process.env.CERAUI_EXPERIMENTAL_COMPANION_WIFI === "1",
	frontDoor = localIngressPresent,
}: CompanionWifiDeps) {
	return os
		.$context<RPCContext>()
		.use(authMiddleware)
		.handler(async ({ input, context }): Promise<ImportResult> => {
			if (!enabled()) return { status: "disabled" };
			const { ws } = context;
			const peer = ws.remoteAddress.replace(/^::ffff:/, "");
			// A loopback peer means "on the box or an SSH forward" only when no
			// front door forwards network clients to the same listener.
			if (
				frontDoor() ||
				context.getSenderId() !== undefined ||
				ws.data.nativeTcpClient !== true ||
				ws.data.ingressPath !== undefined ||
				(peer !== "127.0.0.1" && peer !== "::1")
			) {
				return { status: "local_only" };
			}
			// Read validation locally so errors never echo a QR or Zod issue.
			const network = parseCompanionWifiInput(input);
			if (!network) return { status: "invalid" };
			try {
				return await save(network);
			} catch {
				return { status: "save_failed" };
			}
		});
}

export interface CompanionSaveDeps {
	stationProfileWithSsid(ssid: string): Promise<boolean>;
	addProfile(network: CompanionWifiNetwork): Promise<string>;
	refresh(): Promise<void>;
}

/**
 * CeraUI lists one saved profile per SSID and Forget removes every profile
 * for it, so an import never adds a second profile for an SSID the box
 * already has: the existing one would win on join.
 */
export async function saveCompanionNetwork(
	network: CompanionWifiNetwork,
	deps: CompanionSaveDeps,
): Promise<CompanionSaveResult> {
	if (await deps.stationProfileWithSsid(network.ssid))
		return { status: "already_saved" };
	const uuid = await deps.addProfile(network);
	void deps.refresh().catch(() => {
		// The saved profile remains authoritative if the UI refresh fails.
	});
	return { status: "saved", uuid };
}

/** Station rows only: an import must never adopt or rewrite a hotspot profile. */
export function refreshCompanionStationProfiles(): Promise<void> {
	return wifiUpdateSavedConns(undefined, broadcastWifiState, {
		hotspots: false,
	});
}

export const companionWifiProcedure = createCompanionWifiProcedure({
	save: async (network) => {
		if (shouldUseMocks())
			throw Error("NetworkManager unavailable in mock mode");
		const { saveCompanionWifiProfile, stationProfileWithSsid } = await import(
			"../../modules/wifi/companion-wifi-profile.ts"
		);
		return saveCompanionNetwork(network, {
			stationProfileWithSsid,
			addProfile: saveCompanionWifiProfile,
			refresh: refreshCompanionStationProfiles,
		});
	},
});
