import {
	moblinkCredentialInputSchema,
	moblinkResultSchema,
	moblinkStatusSchema,
} from "@ceraui/rpc/schemas";
import { ORPCError, os } from "@orpc/server";
import type { MoblinkOwner } from "../../modules/moblink/owner";
import type { RPCContext } from "../types";

export function createMoblinkProcedures(owner: MoblinkOwner) {
	const localOperator = os
		.$context<RPCContext>()
		.use(async ({ context, next }) => {
			if (
				!context.isAuthenticated() ||
				context.getSenderId() !== undefined ||
				context.ws.remoteAddress === "control-channel"
			)
				throw new ORPCError("UNAUTHORIZED");
			context.markActive();
			return next();
		});
	return {
		getStatus: localOperator
			.output(moblinkStatusSchema)
			.handler(() => owner.status()),
		setCredential: localOperator
			.input(moblinkCredentialInputSchema)
			.output(moblinkResultSchema)
			.handler(({ input }) => owner.set(input.password)),
		clearCredential: localOperator
			.output(moblinkResultSchema)
			.handler(() => owner.clear()),
	};
}
