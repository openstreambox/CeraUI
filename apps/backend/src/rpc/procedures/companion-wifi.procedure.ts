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
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

type ImportResult =
	| { status: "saved"; uuid: string }
	| { status: "disabled" | "local_only" | "invalid" | "save_failed" };

export function createCompanionWifiProcedure(
	save: (network: CompanionWifiNetwork) => Promise<string>,
	enabled = () => process.env.CERAUI_EXPERIMENTAL_COMPANION_WIFI === "1",
) {
	return os
		.$context<RPCContext>()
		.use(authMiddleware)
		.handler(async ({ input, context }): Promise<ImportResult> => {
			if (!enabled()) return { status: "disabled" };
			const { ws } = context;
			const peer = ws.remoteAddress.replace(/^::ffff:/, "");
			if (
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
				return { status: "saved", uuid: await save(network) };
			} catch {
				return { status: "save_failed" };
			}
		});
}

export const companionWifiProcedure = createCompanionWifiProcedure(
	async (network) => {
		if (shouldUseMocks())
			throw Error("NetworkManager unavailable in mock mode");
		const { saveCompanionWifiProfile } = await import(
			"../../modules/wifi/companion-wifi-profile.ts"
		);
		const uuid = await saveCompanionWifiProfile(network);
		void wifiUpdateSavedConns(undefined, broadcastWifiState).catch(() => {
			// The saved profile remains authoritative if the UI refresh fails.
		});
		return uuid;
	},
);
