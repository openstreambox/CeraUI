import { beforeEach, expect, mock, test } from "bun:test";
import { call } from "@orpc/server";
import { createContext } from "../rpc/context.ts";
import type { AppWebSocket } from "../rpc/types.ts";

const start = mock(async (_peer: string, _radio: string, _via?: string) => ({
	phase: "signing_in",
}));
const finish = mock(async (_peer: string, _via?: string) => ({
	phase: "needs_sign_in" as const,
}));
const refresh = mock(async (_peer: string, _via?: string) => ({
	phase: "idle" as const,
}));
const { createCaptivePortalProcedure } = await import(
	"../rpc/procedures/captive-portal.procedure.ts"
);
let enabled: boolean | undefined = true;
let failSave = false;
let failRead = false;
let ownerPhase: "idle" | "signing_in" = "idle";
const config: { captive_portal_enabled?: boolean | undefined } = {};
const captivePortalProcedure = createCaptivePortalProcedure({
	owner: async () => ({
		start,
		status: () => ({ phase: ownerPhase }),
		finish,
		refresh,
	}),
	settings: async () => ({
		getConfig: () => {
			if (failRead) throw Error("config unavailable");
			return config;
		},
		saveConfig: () => {
			if (failSave) throw Error("disk full");
		},
		broadcastMsg: () => undefined,
	}),
});
const context = (authenticated = true) =>
	createContext({
		remoteAddress: "::ffff:10.42.0.2",
		data: { isAuthenticated: authenticated, lastActive: 0 },
	} as unknown as AppWebSocket);
beforeEach(() => {
	start.mockClear();
	finish.mockClear();
	refresh.mockClear();
	enabled = true;
	config.captive_portal_enabled = enabled;
	failSave = false;
	failRead = false;
	ownerPhase = "idle";
});
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
	expect(start).toHaveBeenCalledWith("10.42.0.2", "2", undefined);
});

const frontDoor = (holds: () => boolean) =>
	createContext({
		remoteAddress: "127.0.0.1",
		data: {
			isAuthenticated: true,
			lastActive: 0,
			ingressPath: {
				peer: "10.42.0.13",
				interface: "wlan1",
				local: "10.42.0.1",
			},
			ingressPathValid: holds,
		},
	} as unknown as AppWebSocket);
test("behind the front door the window is keyed by the phone and its AP", async () => {
	const proxied = frontDoor(() => true);
	await call(
		captivePortalProcedure,
		{ action: "start", radio: 2 },
		{ context: proxied },
	);
	expect(start).toHaveBeenCalledWith("10.42.0.13", "2", "wlan1");
	await call(
		captivePortalProcedure,
		{ action: "finish" },
		{ context: proxied },
	);
	expect(finish).toHaveBeenCalledWith("10.42.0.13", "wlan1");
	await call(
		captivePortalProcedure,
		{ action: "status" },
		{ context: proxied },
	);
	expect(refresh).toHaveBeenCalledWith("10.42.0.13", "wlan1");
});
test("a front-door path that no longer holds drives nothing", async () => {
	let checks = 0;
	const stale = frontDoor(() => {
		checks++;
		return false;
	});
	for (const input of [
		{ action: "start" as const, radio: 2 },
		{ action: "finish" as const },
		{ action: "status" as const },
	])
		await expect(
			call(captivePortalProcedure, input, { context: stale }),
		).rejects.toThrow("not_on_box_wifi");
	expect(checks).toBe(3);
	expect(start).not.toHaveBeenCalled();
	expect(finish).not.toHaveBeenCalled();
	expect(refresh).not.toHaveBeenCalled();
});
test("disabled and absent gates refuse starts but permit retirement", async () => {
	for (const value of [undefined, false]) {
		config.captive_portal_enabled = value;
		await expect(
			call(
				captivePortalProcedure,
				{ action: "start", radio: 2 },
				{ context: context() },
			),
		).rejects.toThrow("experimental_disabled");
		expect(
			(
				await call(
					captivePortalProcedure,
					{ action: "finish" },
					{ context: context() },
				)
			).phase,
		).toBe("needs_sign_in");
	}
	expect(start).not.toHaveBeenCalled();
});
test("setting is persisted, and a failed save restores the gate", async () => {
	await call(
		captivePortalProcedure,
		{ action: "configure", enabled: false },
		{ context: context() },
	);
	expect(config.captive_portal_enabled).toBe(false);
	failSave = true;
	await expect(
		call(
			captivePortalProcedure,
			{ action: "configure", enabled: true },
			{ context: context() },
		),
	).rejects.toThrow("disk full");
	expect(config.captive_portal_enabled).toBe(false);
});

test("cleanup and status remain available when settings cannot be read", async () => {
	failRead = true;
	expect(
		(
			await call(
				captivePortalProcedure,
				{ action: "finish" },
				{ context: context() },
			)
		).phase,
	).toBe("needs_sign_in");
	expect(
		(
			await call(
				captivePortalProcedure,
				{ action: "status" },
				{ context: context() },
			)
		).phase,
	).toBe("idle");
});

test("changing the gate does not report an active window as idle", async () => {
	ownerPhase = "signing_in";
	expect(
		(
			await call(
				captivePortalProcedure,
				{ action: "configure", enabled: false },
				{ context: context() },
			)
		).phase,
	).toBe("signing_in");
});

test("authenticated relayed sessions can configure but cannot open a window", async () => {
	const remote = context();
	remote.setSenderId("remote-helper");
	await call(
		captivePortalProcedure,
		{ action: "configure", enabled: false },
		{ context: remote },
	);
	expect(config.captive_portal_enabled).toBe(false);
	expect(start).not.toHaveBeenCalled();
	await expect(
		call(
			captivePortalProcedure,
			{ action: "start", radio: 2 },
			{ context: remote },
		),
	).rejects.toThrow("Sign in from the box's Wi-Fi");
});

test.each(["finish", "status"] as const)(
	"relayed %s cannot reach the owner",
	async (action) => {
		const remote = context();
		remote.setSenderId("remote-helper");
		await expect(
			call(captivePortalProcedure, { action }, { context: remote }),
		).rejects.toThrow("Sign in from the box's Wi-Fi");
	},
);
