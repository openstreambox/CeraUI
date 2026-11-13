import { buttonInputSchema, buttonOutputSchema } from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import { buttonAdmission } from "../../modules/system/button-admission.ts";
import { buttonFlow } from "../../modules/system/button-flow-instance.ts";
import { isStreamConfirmedIdle } from "../../modules/system/stream-liveness-source.ts";
import { getClients } from "../events.ts";
import type { RPCContext } from "../types.ts";
import {
	issueButtonCredential,
	revokeButtonCredentials,
	settleButtonCredentials,
} from "./auth.procedure.ts";

const baseProcedure = os.$context<RPCContext>();
export const buttonProcedure = baseProcedure
	.input(buttonInputSchema)
	.output(buttonOutputSchema)
	.handler(async ({ input, context }) => {
		const owner = context.ws;
		if (input.action === "cancel") {
			buttonFlow.cancel(owner);
			return { state: "cancelled" as const };
		}
		if (input.action === "begin") {
			const refusal = buttonAdmission(
				owner.data.buttonLocal === true,
				!!context.getSenderId(),
				input.purpose,
				isStreamConfirmedIdle(),
			);
			if (refusal) return { state: refusal };
			const id = await buttonFlow.begin(owner, input.purpose);
			return id
				? { state: "waiting" as const, id }
				: { state: "unavailable" as const };
		}
		const result = buttonFlow.poll(owner, input.id);
		if (!result) return { state: "cancelled" as const };
		const refusal = buttonAdmission(
			owner.data.buttonLocal === true,
			!!context.getSenderId(),
			result.purpose,
			isStreamConfirmedIdle(),
		);
		if (refusal) {
			buttonFlow.cancel(owner);
			return { state: refusal };
		}
		if (result.state !== "confirmed") return { state: result.state };
		await settleButtonCredentials();
		// Recheck after the asynchronous store boundary, immediately before effects.
		const finalRefusal = buttonAdmission(
			owner.data.buttonLocal === true,
			!!context.getSenderId(),
			result.purpose,
			isStreamConfirmedIdle(),
		);
		if (finalRefusal) return { state: finalRefusal };
		if (result.purpose === "connect") {
			const token = issueButtonCredential();
			context.authenticate(token);
			return { state: "confirmed" as const, auth_token: token };
		}
		revokeButtonCredentials();
		// Existing WebSockets must lose authority as well as remembered tokens.
		for (const client of getClients()) {
			try {
				client.send(JSON.stringify({ auth: { success: false } }));
			} catch {
				/* Continue revoking other transports. */
			}
			client.data.isAuthenticated = false;
			delete client.data.authToken;
			try {
				client.close(1000, "Devices disconnected");
			} catch {
				/* Continue revoking other transports. */
			}
		}
		context.deauthenticate();
		return { state: "confirmed" as const };
	});
