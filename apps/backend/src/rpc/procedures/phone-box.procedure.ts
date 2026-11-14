import { phoneBoxSettingsSchema, phoneWaySchema } from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import { setup } from "../../modules/setup";
import {
	readPhoneWay,
	writePhoneWay,
} from "../../modules/system/phone-preferences";
import { authMiddleware } from "../middleware/auth.middleware";
import type { RPCContext } from "../types";

const authed = os.$context<RPCContext>().use(authMiddleware);
export const getPhoneBoxProcedure = authed
	.output(phoneBoxSettingsSchema)
	.handler(async () => ({
		way: await readPhoneWay(),
		// setup owns the persisted generated secret and disables unavailable listeners.
		srt: setup.srt_forward
			? {
					address: `srt://${setup.srt_forward.host}:${setup.srt_forward.port}`,
					passphrase: setup.srt_forward.passphrase,
				}
			: null,
	}));
export const setPhoneWayProcedure = authed
	.input(phoneWaySchema)
	.output(phoneWaySchema)
	.handler(async ({ input }) => {
		await writePhoneWay(input);
		return input;
	});
