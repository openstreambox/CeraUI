import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { TailscaleStatus } from "@ceraui/rpc/schemas";
import {
	statusResponseSchema,
	tailscaleJoinInputSchema,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { logger, logRedact, REDACTED } from "../helpers/logger.ts";
import * as mockService from "../mocks/mock-service.ts";
import { isNonUplinkIfname } from "../modules/network/network-interfaces.ts";
import { buildControlContext } from "../modules/remote-control/control-context.ts";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import {
	getCachedTailscaleStatus,
	getTailscaleStatus,
	type JoinOutcome,
	joinTailscale,
	logoutTailscale,
	parseTailscaleStatusJson,
	pickRestorePrefs,
	type RestorePrefs,
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

/**
 * A fake tailscaled: a running flag, a backend state, remembered prefs, an
 * optional image enrolment, and a call log.
 */
function fakeDaemon(initial: {
	active: boolean;
	backend: string;
	joinOutcome?: JoinOutcome;
	enroll?: {
		hasState: boolean;
		result: "joined" | "gave-up" | "slow" | "retry";
	};
	prefs?: Record<string, unknown>;
	restore?: RestorePrefs;
}) {
	const state = {
		...initial,
		restore: initial.restore,
		pending: false,
		queued: false,
		enrollStatus: undefined as string | undefined,
	};
	const calls: string[] = [];
	const broadcasts: TailscaleStatus[] = [];
	const joins: Array<{ key: string; restore: RestorePrefs | undefined }> = [];
	const submits: Array<{ key: string; hostname: string }> = [];
	const deps: Partial<TailscaleDeps> = {
		isInstalled: async () => true,
		isDaemonActive: async () => state.active,
		statusJson: async () => statusJson(state.backend),
		setUnit: async (enabled) => {
			calls.push(enabled ? "enable --now" : "disable --now");
			// An image unit gated on state starts only once there is state.
			state.active = enabled && (!state.enroll || state.enroll.hasState);
		},
		reconnect: async () => {
			calls.push("up");
			state.backend = "Running";
		},
		pinAutoUpdateOff: async () => {
			calls.push("pin updates off");
		},
		down: async () => {
			calls.push("down");
			state.backend = "Stopped";
		},
		logout: async () => {
			calls.push("logout");
			state.backend = "NeedsLogin";
		},
		apiJoin: async (key, restore) => {
			calls.push("api join");
			joins.push({ key, restore });
			const outcome = state.joinOutcome ?? "joined";
			if (outcome === "joined") state.backend = "Running";
			if (outcome === "approval") state.backend = "NeedsMachineAuth";
			return outcome;
		},
		readPrefs: async () =>
			state.prefs ?? {
				ControlURL: "https://control.example",
				Hostname: "studio-box",
				RunSSH: true,
				CorpDNS: false,
				RouteAll: false,
				ShieldsUp: false,
				Persist: { PrivateNodeKey: "privkey:secret" },
			},
		readRestore: async () => state.restore,
		writeRestore: async (prefs) => {
			calls.push("remember");
			state.restore = prefs;
		},
		enrollPresent: async () => state.enroll !== undefined,
		enrollHasState: async () => state.enroll?.hasState ?? false,
		enrollQueued: async () => state.queued,
		enrollPending: async () => state.pending,
		enrollLastStatus: async () => state.enrollStatus,
		enrollSubmit: async (key, hostname) => {
			calls.push("enroll");
			submits.push({ key, hostname });
			state.pending = true;
			const result = state.enroll?.result;
			if (result === "slow") return;
			if (result === "retry") {
				state.enrollStatus = "pending 1 1700000120 retry";
				return;
			}
			state.pending = false;
			if (result === "joined") {
				state.enrollStatus = "joined 1 0 ok";
				state.active = true;
				state.backend = "Running";
				if (state.enroll) state.enroll.hasState = true;
			} else {
				state.enrollStatus = "gave-up 1 0 the control server refused the key";
			}
		},
		broadcast: (status) => broadcasts.push(status),
		sleep: async () => {},
	};
	return { state, calls, broadcasts, joins, submits, deps };
}

const NO_TAILNET_SSH =
	"Unable to enable local Tailscale SSH server; not enabled on Tailnet.";

/** Collect warn and error log lines until restore(). */
function captureLogs() {
	const warn: string[] = [];
	const error: string[] = [];
	const spies = (["warn", "error"] as const).map((level) =>
		spyOn(logger, level).mockImplementation((...args: unknown[]) => {
			(level === "warn" ? warn : error).push(
				args
					.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
					.join(" "),
			);
			return logger;
		}),
	);
	return {
		warn,
		error,
		restore: () => {
			for (const spy of spies) spy.mockRestore();
		},
	};
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
			enrollPresent: async () => {
				seen.push("enroll");
				return false;
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

	test("with image enrolment, a box that never joined needs a key, not a switch", async () => {
		const daemon = fakeDaemon({
			active: false,
			backend: "NoState",
			enroll: { hasState: false, result: "joined" },
		});
		setTailscaleDepsForTest(daemon.deps);
		expect(await getTailscaleStatus()).toEqual({ state: "needs_key" });
		daemon.state.pending = true;
		expect(await getTailscaleStatus()).toEqual({ state: "joining" });
		daemon.state.pending = false;
		if (daemon.state.enroll) daemon.state.enroll.hasState = true;
		expect(await getTailscaleStatus()).toEqual({ state: "off" });
	});

	test("a drop awaiting adoption shows as joining outside an active RPC", async () => {
		const daemon = fakeDaemon({
			active: false,
			backend: "NoState",
			enroll: { hasState: false, result: "slow" },
		});
		daemon.state.queued = true;
		setTailscaleDepsForTest(daemon.deps);
		expect(await getTailscaleStatus()).toEqual({ state: "joining" });
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

describe("join through the local API", () => {
	test("starts a stopped daemon, then joins with the key and the remembered prefs", async () => {
		const restore = { ControlURL: "https://control.example", RunSSH: true };
		const daemon = fakeDaemon({
			active: false,
			backend: "NeedsLogin",
			restore,
		});
		setTailscaleDepsForTest(daemon.deps);
		expect(await joinTailscale(KEY)).toBe(true);
		expect(daemon.calls).toEqual(["enable --now", "api join"]);
		expect(daemon.joins).toEqual([{ key: KEY, restore }]);
		expect(getCachedTailscaleStatus()?.state).toBe("connected");
	});

	test("waiting for approval counts as joined", async () => {
		const daemon = fakeDaemon({
			active: true,
			backend: "NeedsLogin",
			joinOutcome: "approval",
		});
		setTailscaleDepsForTest(daemon.deps);
		expect(await joinTailscale(KEY)).toBe(true);
		expect(getCachedTailscaleStatus()?.state).toBe("needs_approval");
	});

	test("a refused key reports failure", async () => {
		const daemon = fakeDaemon({
			active: true,
			backend: "NeedsLogin",
			joinOutcome: "refused",
		});
		setTailscaleDepsForTest(daemon.deps);
		expect(await joinTailscale(KEY)).toBe(false);
		expect(getCachedTailscaleStatus()?.state).toBe("needs_key");
	});

	test("the key is passed to the join and nowhere else", async () => {
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
			apiJoin: async (authKey) => {
				received = authKey;
				// A daemon that echoes its input in the error must not leak it.
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
			apiJoin: async () => {
				await release.promise;
				daemon.state.backend = "Running";
				return "joined";
			},
		});
		const first = joinTailscale(KEY);
		expect(await joinTailscale(KEY)).toBe(false);
		expect(getCachedTailscaleStatus()?.state).toBe("joining");
		release.resolve();
		expect(await first).toBe(true);
	});
});

describe("join through the image's enrolment", () => {
	test("hands the key and the remembered name to the enrolment, never to the local API", async () => {
		const daemon = fakeDaemon({
			active: false,
			backend: "NoState",
			enroll: { hasState: false, result: "joined" },
			restore: { Hostname: "Studio-Box" },
		});
		setTailscaleDepsForTest(daemon.deps);
		expect(await joinTailscale(KEY)).toBe(true);
		expect(daemon.calls).toEqual(["enroll"]);
		expect(daemon.submits).toEqual([{ key: KEY, hostname: "studio-box" }]);
		expect(getCachedTailscaleStatus()?.state).toBe("connected");
	});

	test("a name the enrolment would reject is not passed on", async () => {
		const daemon = fakeDaemon({
			active: false,
			backend: "NoState",
			enroll: { hasState: false, result: "joined" },
			restore: { Hostname: "studio box; rm -rf" },
		});
		setTailscaleDepsForTest(daemon.deps);
		await joinTailscale(KEY);
		expect(daemon.submits[0]?.hostname).toBe("");
	});

	test("a refusal by the enrolment reports failure", async () => {
		const daemon = fakeDaemon({
			active: false,
			backend: "NoState",
			enroll: { hasState: false, result: "gave-up" },
		});
		setTailscaleDepsForTest(daemon.deps);
		expect(await joinTailscale(KEY)).toBe(false);
		expect(getCachedTailscaleStatus()?.state).toBe("needs_key");
	});

	test("ignores an old refusal until the new drop has been adopted", async () => {
		const daemon = fakeDaemon({
			active: false,
			backend: "NoState",
			enroll: { hasState: false, result: "joined" },
		});
		daemon.state.enrollStatus = "gave-up 1 0 the previous key expired";
		let polls = 0;
		setTailscaleDepsForTest({
			...daemon.deps,
			enrollSubmit: async () => {
				daemon.state.queued = true;
			},
			sleep: async () => {
				polls += 1;
				if (polls === 1) {
					expect(await getTailscaleStatus()).toEqual({ state: "joining" });
					return;
				}
				daemon.state.queued = false;
				daemon.state.enrollStatus = "joined 1 0 ok";
				daemon.state.active = true;
				daemon.state.backend = "Running";
			},
		});
		expect(await joinTailscale(KEY)).toBe(true);
		expect(polls).toBe(2);
		expect(getCachedTailscaleStatus()?.state).toBe("connected");
	});

	test("refuses a key format the image enrolment cannot accept before dropping it", async () => {
		const daemon = fakeDaemon({
			active: false,
			backend: "NoState",
			enroll: { hasState: false, result: "joined" },
		});
		setTailscaleDepsForTest(daemon.deps);
		expect(await joinTailscale("0123456789abcdef")).toBe(false);
		expect(daemon.submits).toEqual([]);
	});

	test("a slow enrolment is still joining, not failed", async () => {
		const daemon = fakeDaemon({
			active: false,
			backend: "NoState",
			enroll: { hasState: false, result: "slow" },
		});
		let clock = 0;
		const now = spyOn(Date, "now").mockImplementation(() => {
			clock += 5_000;
			return clock;
		});
		setTailscaleDepsForTest(daemon.deps);
		try {
			expect(await joinTailscale(KEY)).toBe(true);
		} finally {
			now.mockRestore();
		}
		expect(getCachedTailscaleStatus()?.state).toBe("joining");
	});
});

describe("enrolment retries", () => {
	test("a failed first attempt is reported at once as still joining", async () => {
		const daemon = fakeDaemon({
			active: false,
			backend: "NoState",
			enroll: { hasState: false, result: "retry" },
		});
		let polls = 0;
		setTailscaleDepsForTest({
			...daemon.deps,
			sleep: async () => {
				polls += 1;
			},
		});
		expect(await joinTailscale(KEY)).toBe(true);
		expect(polls).toBe(1);
		expect(getCachedTailscaleStatus()?.state).toBe("joining");
	});
});

describe("on, right after the unit starts", () => {
	test("waits for the daemon to settle before deciding to reconnect", async () => {
		const daemon = fakeDaemon({ active: false, backend: "Stopped" });
		const answers = ["NoState", "NoState", "Stopped"];
		setTailscaleDepsForTest({
			...daemon.deps,
			statusJson: async () => {
				const next = answers.shift();
				if (next === undefined) return statusJson(daemon.state.backend);
				if (next === "NoState") return statusJson("NoState");
				return statusJson(next);
			},
		});
		expect(await setTailscaleEnabled(true)).toBe(true);
		expect(daemon.calls).toEqual(["enable --now", "up"]);
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

	test("on reconnects a logged-in device with a flag-less up", async () => {
		const daemon = fakeDaemon({ active: false, backend: "Stopped" });
		setTailscaleDepsForTest(daemon.deps);
		expect(await setTailscaleEnabled(true)).toBe(true);
		expect(daemon.calls).toEqual(["enable --now", "up"]);
		expect(getCachedTailscaleStatus()?.state).toBe("connected");
	});

	test("on reapplies the image's auto-update policy after reconnect", async () => {
		const daemon = fakeDaemon({
			active: false,
			backend: "Stopped",
			enroll: { hasState: true, result: "joined" },
		});
		setTailscaleDepsForTest(daemon.deps);
		expect(await setTailscaleEnabled(true)).toBe(true);
		expect(daemon.calls).toEqual(["enable --now", "up", "pin updates off"]);
	});

	test("on: a pin refused by a tailnet without Tailscale SSH does not fail the reconnect, and says why", async () => {
		const daemon = fakeDaemon({
			active: false,
			backend: "Stopped",
			enroll: { hasState: true, result: "joined" },
		});
		const logged = captureLogs();
		setTailscaleDepsForTest({
			...daemon.deps,
			pinAutoUpdateOff: async () => {
				daemon.calls.push("pin updates off");
				throw Object.assign(new Error("Command failed: tailscale set"), {
					code: 1,
					stderr: NO_TAILNET_SSH,
				});
			},
		});
		try {
			expect(await setTailscaleEnabled(true)).toBe(true);
		} finally {
			logged.restore();
		}
		expect(daemon.calls).toEqual(["enable --now", "up", "pin updates off"]);
		expect(getCachedTailscaleStatus()?.state).toBe("connected");
		expect(logged.error).toEqual([]);
		expect(logged.warn.join("\n")).toContain("does not allow Tailscale SSH");
	});

	test("on: a failed reconnect is reported even when the pin fails too", async () => {
		const daemon = fakeDaemon({
			active: false,
			backend: "Stopped",
			enroll: { hasState: true, result: "joined" },
		});
		const logged = captureLogs();
		setTailscaleDepsForTest({
			...daemon.deps,
			reconnect: async () => {
				daemon.calls.push("up");
				throw Object.assign(new Error("Command failed: tailscale up"), {
					code: 1,
					stderr: "reconnect-broke",
				});
			},
			pinAutoUpdateOff: async () => {
				daemon.calls.push("pin updates off");
				throw Object.assign(new Error("Command failed: tailscale set"), {
					code: 1,
					stderr: "pin-broke",
				});
			},
		});
		try {
			await setTailscaleEnabled(true);
		} finally {
			logged.restore();
		}
		// The pin still runs: an `up` can change prefs before it fails.
		expect(daemon.calls).toEqual(["enable --now", "up", "pin updates off"]);
		expect(logged.error.join("\n")).toContain("reconnect-broke");
		expect(logged.warn.join("\n")).toContain("pin-broke");
	});

	test("off and forget name a tailnet without Tailscale SSH when tailscaled refuses them", async () => {
		const daemon = fakeDaemon({ active: true, backend: "Running" });
		const refused = () =>
			Object.assign(new Error("Command failed"), {
				code: 1,
				stderr: NO_TAILNET_SSH,
			});
		const logged = captureLogs();
		setTailscaleDepsForTest({
			...daemon.deps,
			down: async () => {
				daemon.calls.push("down");
				throw refused();
			},
			logout: async () => {
				daemon.calls.push("logout");
				throw refused();
			},
		});
		try {
			expect(await logoutTailscale()).toBe(false);
			// Stopping the unit still turns it off.
			expect(await setTailscaleEnabled(false)).toBe(true);
		} finally {
			logged.restore();
		}
		const all = [...logged.warn, ...logged.error].join("\n");
		expect(all.match(/does not allow Tailscale SSH/g)?.length).toBe(2);
	});

	test("on never starts a login for a device without one", async () => {
		const daemon = fakeDaemon({ active: false, backend: "NeedsLogin" });
		setTailscaleDepsForTest(daemon.deps);
		expect(await setTailscaleEnabled(true)).toBe(true);
		expect(daemon.calls).toEqual(["enable --now"]);
		expect(getCachedTailscaleStatus()?.state).toBe("needs_key");
	});

	test("on, on an image box that never joined, offers the key field", async () => {
		const daemon = fakeDaemon({
			active: false,
			backend: "NoState",
			enroll: { hasState: false, result: "joined" },
		});
		setTailscaleDepsForTest(daemon.deps);
		expect(await setTailscaleEnabled(true)).toBe(true);
		expect(daemon.calls).toEqual(["enable --now"]);
		expect(getCachedTailscaleStatus()?.state).toBe("needs_key");
	});

	test("forget remembers the owner's prefs, then logs out", async () => {
		const daemon = fakeDaemon({ active: true, backend: "Running" });
		setTailscaleDepsForTest(daemon.deps);
		expect(await logoutTailscale()).toBe(true);
		expect(daemon.calls).toEqual(["remember", "logout"]);
		expect(daemon.state.restore).toEqual({
			ControlURL: "https://control.example",
			Hostname: "studio-box",
			RunSSH: true,
			CorpDNS: false,
			RouteAll: false,
			ShieldsUp: false,
		});
		expect(JSON.stringify(daemon.state.restore)).not.toContain("privkey");
		expect(getCachedTailscaleStatus()?.state).toBe("needs_key");
	});

	test("every action is a no-op on an image without tailscale", async () => {
		const calls: string[] = [];
		setTailscaleDepsForTest({
			isInstalled: async () => false,
			setUnit: async () => {
				calls.push("unit");
			},
			reconnect: async () => {
				calls.push("up");
			},
			apiJoin: async () => {
				calls.push("join");
				return "joined";
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

	test("a refused join does not leave the card stuck on joining", async () => {
		const daemon = fakeDaemon({ active: true, backend: "NeedsLogin" });
		setTailscaleDepsForTest(daemon.deps);
		updateStatus(true);
		await call(
			tailscaleJoinProcedure,
			{ authKey: KEY },
			{ context: buildControlContext() },
		);
		expect(getCachedTailscaleStatus()?.state).not.toBe("joining");
	});

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

	test("the log redactor drops auth keys wherever they appear", () => {
		expect(logRedact(`failed with ${KEY}`)).toBe(REDACTED);
		expect(logRedact({ note: `hskey-auth-abcdef0123456789` })).toEqual({
			note: REDACTED,
		});
		expect(logRedact("tailscale up failed: exit 1")).toBe(
			"tailscale up failed: exit 1",
		);
	});

	test("pickRestorePrefs keeps only the known, typed fields", () => {
		expect(
			pickRestorePrefs({
				ControlURL: "https://c.example",
				Hostname: 7,
				RunSSH: "yes",
				CorpDNS: false,
				Persist: { PrivateNodeKey: "x" },
			}),
		).toEqual({ ControlURL: "https://c.example", CorpDNS: false });
		expect(pickRestorePrefs(null)).toEqual({});
	});

	test("tunnel interfaces are never uplinks", () => {
		expect(isNonUplinkIfname("tailscale0")).toBe(true);
		expect(isNonUplinkIfname("lo")).toBe(true);
		expect(isNonUplinkIfname("docker0")).toBe(true);
		expect(isNonUplinkIfname("wwan0")).toBe(false);
		expect(isNonUplinkIfname("eth0")).toBe(false);
	});
});
