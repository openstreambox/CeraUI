import { portalWindowInputSchema } from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

/** Peer is transport-derived; never accept an IP, MAC or forwarding header. */
type Owner = Pick<
	typeof import("../../modules/wifi/captive-portal-runtime.ts").signInWindow,
	"start" | "finish" | "refresh" | "status"
>;
interface PortalDeps {
	owner(): Promise<Owner>;
	settings(): Promise<{
		getConfig(): { captive_portal_enabled?: boolean | undefined };
		saveConfig(): void;
		broadcastMsg(
			type: "config",
			config: { captive_portal_enabled?: boolean | undefined },
		): void;
	}>;
}
export function createCaptivePortalProcedure(deps: PortalDeps) {
	return os
		.$context<RPCContext>()
		.use(authMiddleware)
		.input(portalWindowInputSchema)
		.handler(async ({ input, context }) => {
			const sender = context.getSenderId();
			const peer = context.ws.remoteAddress.replace(/^::ffff:/, "");
			if (sender) throw Error("Sign in from the box's Wi-Fi.");

			if (input.action === "start" || input.action === "configure") {
				const settings = await deps.settings();
				const config = settings.getConfig();
				if (input.action === "configure") {
					if (input.enabled === undefined) throw Error("Choose enabled state");
					const previous = config.captive_portal_enabled;
					config.captive_portal_enabled = input.enabled;
					try {
						settings.saveConfig();
					} catch (error) {
						config.captive_portal_enabled = previous;
						throw error;
					}
					settings.broadcastMsg("config", config);
					return (await deps.owner()).status(peer);
				}
				if (input.action === "start" && config.captive_portal_enabled !== true)
					throw Error("experimental_disabled");
			}
			const signInWindow = await deps.owner();
			if (input.action === "start") {
				if (input.radio === undefined) throw Error("Choose Wi-Fi");
				return signInWindow.start(peer, String(input.radio));
			}
			if (input.action === "finish") return signInWindow.finish(peer);
			return signInWindow.refresh(peer);
		});
}
export const captivePortalProcedure = createCaptivePortalProcedure({
	owner: async () =>
		(await import("../../modules/wifi/captive-portal-runtime.ts")).signInWindow,
	settings: async () => ({
		...(await import("../../modules/config.ts")),
		broadcastMsg: (await import("../../modules/ui/websocket-server.ts"))
			.broadcastMsg,
	}),
});
