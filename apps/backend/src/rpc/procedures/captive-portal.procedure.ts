import { os } from "@orpc/server";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

/** Peer is transport-derived; never accept an IP, MAC or forwarding header. */
export const captivePortalProcedure = os
	.$context<RPCContext>()
	.use(authMiddleware)
	.input(
		z.object({
			action: z.enum(["start", "finish", "status"]),
			radio: z.number().int().nonnegative().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const sender = context.getSenderId();
		const peer = context.ws.remoteAddress.replace(/^::ffff:/, "");
		if (sender) throw Error("Sign in from the box's Wi-Fi.");
		const { signInWindow } = await import(
			"../../modules/wifi/captive-portal-runtime.ts"
		);
		if (input.action === "start") {
			if (input.radio === undefined) throw Error("Choose Wi-Fi");
			return signInWindow.start(peer, String(input.radio));
		}
		if (input.action === "finish") return signInWindow.finish(peer);
		return signInWindow.refresh(peer);
	});
