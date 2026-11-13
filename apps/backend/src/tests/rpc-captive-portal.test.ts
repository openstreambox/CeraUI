import { beforeEach, expect, mock, test } from "bun:test";
import { call } from "@orpc/server";
import { createContext } from "../rpc/context.ts";
import type { AppWebSocket } from "../rpc/types.ts";

const start = mock(async (_peer: string, _radio: string) => ({
	phase: "signing_in",
}));
mock.module("../modules/wifi/captive-portal-runtime.ts", () => ({
	signInWindow: { start },
}));
const { captivePortalProcedure } = await import(
	"../rpc/procedures/captive-portal.procedure.ts"
);
const context = (authenticated = true) =>
	createContext({
		remoteAddress: "::ffff:10.42.0.2",
		data: { isAuthenticated: authenticated, lastActive: 0 },
	} as unknown as AppWebSocket);
beforeEach(() => start.mockClear());
test("anonymous and relayed callers never reach the forwarding owner", async () => {
	await expect(
		call(
			captivePortalProcedure,
			{ action: "start", radio: 2 },
			{ context: context(false) },
		),
	).rejects.toThrow("Authentication required");
	const remote = context();
	remote.setSenderId("remote-helper");
	await expect(
		call(
			captivePortalProcedure,
			{ action: "start", radio: 2 },
			{ context: remote },
		),
	).rejects.toThrow("Sign in from the box's Wi-Fi");
	expect(start).not.toHaveBeenCalled();
});
test("the transport peer wins over a caller's requested phone", async () => {
	const input = {
		action: "start" as const,
		radio: 2,
		phone: "10.42.0.99",
		mac: "02:00:00:00:00:99",
	};
	await call(captivePortalProcedure, input, { context: context() });
	expect(start).toHaveBeenCalledWith("10.42.0.2", "2");
});
