import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { TailscaleStatus } from "@ceraui/rpc/schemas";
import {
	statusResponseSchema,
	tailscaleJoinInputSchema,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { logger } from "../helpers/logger.ts";
import * as mockService from "../mocks/mock-service.ts";
import { isNonUplinkIfname } from "../modules/network/network-interfaces.ts";
import { buildControlContext } from "../modules/remote-control/control-context.ts";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import {
	getCachedTailscaleStatus,
	getTailscaleStatus,
	joinTailscale,
	logoutTailscale,
	parseTailscaleStatusJson,
	resetTailscaleForTest,
	scrubSecret,
	setTailscaleDepsForTest,
	setTailscaleEnabled,
	type TailscaleDeps,
} from "../modules/system/tailscale.ts";
import { resetOrchestratorRuntimeForTest } from "../modules/system/update-orchestrator/runtime.ts";
import { notificationRemove } from "../modules/ui/notifications.ts";
import {
	tailscaleJoinProcedure,
	tailscaleLogoutProcedure,
	tailscaleSetEnabledProcedure,
} from "../rpc/procedures/system.procedure.ts";

const KEY = "tskey-auth-kPRIVACY7CNTRL-0123456789abcdefFEDCBA";

function statusJson(backend: string): string {
	return JSON.stringify({
		BackendState: backend,
		Self: {
			HostName: "studio-box",
			DNSName: "studio-box.example-tailnet.ts.net.",
			TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
		},
		CurrentTailnet: {
			Name: "owner@example.com",
			MagicDNSSuffix: "example-tailnet.ts.net",
		},
		MagicDNSSuffix: "example-tailnet.ts.net",
	});
}

/** A fake tailscaled: a running flag, a login flag, and a call log. */
function fakeDaemon(initial: { active: boolean; backend: string }) {
	const state = { ...initial };
	const calls: string[] = [];
	const broadcasts: TailscaleStatus[] = [];
	const deps: Partial<TailscaleDeps> = {
		isInstalled: async () => true,
		isDaemonActive: async () => state.active,
		statusJson: async () => statusJson(state.backend),
		setUnit: async (enabled) => {
			calls.push(enabled ? "enable --now" : "disable --now");
			state.active = enabled;
		},
		up: async (authKey) => {
			calls.push(authKey === undefined ? "up" : "up --auth-key");
			state.backend = "Running";
		},
		down: async () => {
			calls.push("down");
			state.backend = "Stopped";
		},
		logout: async () => {
			calls.push("logout");
			state.backend = "NeedsLogin";
		},
		broadcast: (status) => broadcasts.push(status),
	};
	return { state, calls, broadcasts, deps };
}

const env = { ...process.env };
beforeEach(() => {
	process.env.NODE_ENV = "production";
	delete process.env.MOCK_MODE;
	spyOn(mockService, "shouldUseMocks").mockReturnValue(false);
	resetOrchestratorRuntimeForTest();
	updateStatus(false);
	updateStreamLifecycleState("idle");
	notificationRemove("disruptive_action_refused");
});
afterEach(() => {
	resetTailscaleForTest();
	resetOrchestratorRuntimeForTest();
	updateStatus(false);
	updateStreamLifecycleState("idle");
	notificationRemove("disruptive_action_refused");
	for (const key of ["NODE_ENV", "MOCK_MODE"]) {
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}
});

describe("parseTailscaleStatusJson", () => {
	test("maps each backend state", () => {
		const cases: Array<[string, TailscaleStatus["state"]]> = [
			["Running", "connected"],
			["Starting", "joining"],
			["NeedsLogin", "needs_key"],
			["NoState", "needs_key"],
			["NeedsMachineAuth", "needs_approval"],
			["Stopped", "off"],
			["SomethingNew", "unknown"],
		];
		for (const [backend, state] of cases) {
			expect(parseTailscaleStatusJson(statusJson(backend)).state).toBe(state);
		}
	});

	test("carries only the hostname and IPv4 address, and only when connected", () => {
		expect(parseTailscaleStatusJson(statusJson("Running"))).toEqual({
			state: "connected",
			hostname: "studio-box",
			address: "100.101.102.103",
		});
		expect(parseTailscaleStatusJson(statusJson("NeedsLogin"))).toEqual({
			state: "needs_key",
		});
	});

	test("never reports success for unreadable output", () => {
		expect(parseTailscaleStatusJson("not json").state).toBe("unknown");
		expect(parseTailscaleStatusJson("null").state).toBe("unknown");
	});
});

describe("status probe", () => {
	test("an image without tailscale reports unavailable and runs nothing else", async () => {
		const seen: string[] = [];
		setTailscaleDepsForTest({
			isInstalled: async () => false,
			isDaemonActive: async () => {
				seen.push("is-active");
				return true;
			},
			statusJson: async () => {
				seen.push("status");
				return "{}";
			},
			broadcast: () => {},
		});
		expect(await getTailscaleStatus()).toEqual({ state: "unavailable" });
		expect(seen).toEqual([]);
	});

	test("a stopped daemon is off", async () => {
		const daemon = fakeDaemon({ active: false, backend: "Running" });
		setTailscaleDepsForTest(daemon.deps);
		expect(await getTailscaleStatus()).toEqual({ state: "off" });
	});

	test("broadcasts once per change", async () => {
		const daemon = fakeDaemon({ active: true, backend: "Running" });
		setTailscaleDepsForTest(daemon.deps);
		await getTailscaleStatus();
		await getTailscaleStatus();
		expect(daemon.broadcasts).toHaveLength(1);
		daemon.state.backend = "NeedsLogin";
		await getTailscaleStatus();
		expect(daemon.broadcasts.map((s) => s.state)).toEqual([
			"connected",
			"needs_key",
		]);
	});

	test("the status wire schema accepts the field", () => {
		const parsed = statusResponseSchema.parse({
			tailscale: { state: "connected", hostname: "box", address: "100.64.0.1" },
		});
		expect(parsed.tailscale?.state).toBe("connected");
		expect(
			statusResponseSchema.safeParse({ tailscale: { state: "maybe" } }).success,
		).toBe(false);
	});
});

describe("join", () => {
	test("starts a stopped daemon, then joins with the key", async () => {
		const daemon = fakeDaemon({ active: false, backend: "NeedsLogin" });
		setTailscaleDepsForTest(daemon.deps);
		expect(await joinTailscale(KEY)).toBe(true);
		expect(daemon.calls).toEqual(["enable --now", "up --auth-key"]);
		expect(getCachedTailscaleStatus()?.state).toBe("connected");
	});

	test("the key is passed to tailscale and nowhere else", async () => {
		const daemon = fakeDaemon({ active: true, backend: "NeedsLogin" });
		let received: string | undefined;
		const logged: string[] = [];
		const spies = (["debug", "info", "warn", "error"] as const).map((level) =>
			spyOn(logger, level).mockImplementation((...args: unknown[]) => {
				logged.push(args.map((a) => JSON.stringify(a)).join(" "));
				return logger;
			}),
		);
		setTailscaleDepsForTest({
			...daemon.deps,
			up: async (authKey) => {
				received = authKey;
				// A CLI that echoes its input in the error must not leak it.
				throw Object.assign(new Error(`invalid key ${authKey}`), {
					code: 1,
					stderr: `backend error: invalid key ${authKey}`,
				});
			},
		});
		try {
			expect(await joinTailscale(KEY)).toBe(false);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
		expect(received).toBe(KEY);
		expect(logged.join("\n")).not.toContain(KEY);
		expect(logged.join("\n")).toContain("***");
		expect(JSON.stringify(daemon.broadcasts)).not.toContain(KEY);
		expect(JSON.stringify(getCachedTailscaleStatus())).not.toContain(KEY);
	});

	test("refuses a second join while one runs", async () => {
		const daemon = fakeDaemon({ active: true, backend: "NeedsLogin" });
		const release = Promise.withResolvers<void>();
		setTailscaleDepsForTest({
			...daemon.deps,
			up: async () => {
				await release.promise;
				daemon.state.backend = "Running";
			},
		});
		const first = joinTailscale(KEY);
		expect(await joinTailscale(KEY)).toBe(false);
		expect(getCachedTailscaleStatus()?.state).toBe("joining");
		release.resolve();
		expect(await first).toBe(true);
	});
});

describe("off switch and forget", () => {
	test("off runs tailscale down, then stops and disables the unit", async () => {
		const daemon = fakeDaemon({ active: true, backend: "Running" });
		setTailscaleDepsForTest(daemon.deps);
		expect(await setTailscaleEnabled(false)).toBe(true);
		expect(daemon.calls).toEqual(["down", "disable --now"]);
		expect(getCachedTailscaleStatus()).toEqual({ state: "off" });
	});

	test("on reconnects a logged-in device without a key", async () => {
		const daemon = fakeDaemon({ active: false, backend: "Stopped" });
		setTailscaleDepsForTest(daemon.deps);
		expect(await setTailscaleEnabled(true)).toBe(true);
		expect(daemon.calls).toEqual(["enable --now", "up"]);
		expect(getCachedTailscaleStatus()?.state).toBe("connected");
	});

	test("on never starts a login for a device without one", async () => {
		const daemon = fakeDaemon({ active: false, backend: "NeedsLogin" });
		setTailscaleDepsForTest(daemon.deps);
		expect(await setTailscaleEnabled(true)).toBe(true);
		expect(daemon.calls).toEqual(["enable --now"]);
		expect(getCachedTailscaleStatus()?.state).toBe("needs_key");
	});

	test("forget logs out and leaves the daemon running", async () => {
		const daemon = fakeDaemon({ active: true, backend: "Running" });
		setTailscaleDepsForTest(daemon.deps);
		expect(await logoutTailscale()).toBe(true);
		expect(daemon.calls).toEqual(["logout"]);
		expect(getCachedTailscaleStatus()?.state).toBe("needs_key");
	});

	test("every action is a no-op on an image without tailscale", async () => {
		const calls: string[] = [];
		setTailscaleDepsForTest({
			isInstalled: async () => false,
			setUnit: async () => {
				calls.push("unit");
			},
			up: async () => {
				calls.push("up");
			},
			logout: async () => {
				calls.push("logout");
			},
			broadcast: () => {},
		});
		expect(await joinTailscale(KEY)).toBe(false);
		expect(await setTailscaleEnabled(true)).toBe(false);
		expect(await logoutTailscale()).toBe(false);
		expect(calls).toEqual([]);
	});
});

describe("procedures", () => {
	for (const [name, run] of [
		[
			"join",
			() =>
				call(
					tailscaleJoinProcedure,
					{ authKey: KEY },
					{ context: buildControlContext() },
				),
		],
		[
			"off",
			() =>
				call(
					tailscaleSetEnabledProcedure,
					{ enabled: false },
					{ context: buildControlContext() },
				),
		],
		[
			"forget",
			() =>
				call(tailscaleLogoutProcedure, undefined, {
					context: buildControlContext(),
				}),
		],
	] as const) {
		test(`${name} is refused while streaming, like SSH`, async () => {
			const daemon = fakeDaemon({ active: true, backend: "Running" });
			setTailscaleDepsForTest(daemon.deps);
			updateStatus(true);
			expect(await run()).toEqual({ success: false, error: "streaming" });
			expect(daemon.calls).toEqual([]);
		});
	}

	test("a malformed key is rejected without echoing it", async () => {
		const bad = `${KEY}\n--reset`;
		const parsed = tailscaleJoinInputSchema.safeParse({ authKey: bad });
		expect(parsed.success).toBe(false);
		expect(JSON.stringify(parsed.error?.issues)).not.toContain(KEY);
		let thrown: unknown;
		try {
			await call(
				tailscaleJoinProcedure,
				{ authKey: bad },
				{ context: buildControlContext() },
			);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeDefined();
		const text = JSON.stringify(thrown, Object.getOwnPropertyNames(thrown));
		expect(text).not.toContain(KEY);
	});

	test("the key schema rejects flags, whitespace and extra fields", () => {
		for (const authKey of ["--advertise-exit-node", "short", "a b".repeat(10)])
			expect(tailscaleJoinInputSchema.safeParse({ authKey }).success).toBe(
				false,
			);
		expect(
			tailscaleJoinInputSchema.safeParse({ authKey: KEY, ssh: true }).success,
		).toBe(false);
		expect(tailscaleJoinInputSchema.parse({ authKey: ` ${KEY} ` })).toEqual({
			authKey: KEY,
		});
	});
});

describe("helpers", () => {
	test("scrubSecret removes every copy", () => {
		expect(scrubSecret(`a ${KEY} b ${KEY}`, KEY)).toBe("a *** b ***");
		expect(scrubSecret("plain", undefined)).toBe("plain");
	});

	test("tunnel interfaces are never uplinks", () => {
		expect(isNonUplinkIfname("tailscale0")).toBe(true);
		expect(isNonUplinkIfname("lo")).toBe(true);
		expect(isNonUplinkIfname("docker0")).toBe(true);
		expect(isNonUplinkIfname("wwan0")).toBe(false);
		expect(isNonUplinkIfname("eth0")).toBe(false);
	});
});
