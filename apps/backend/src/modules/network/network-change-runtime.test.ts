import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppWebSocket, SocketData } from "../../rpc/types.ts";
import { DEFAULT_JOURNAL_PATH } from "./network-change-journal.ts";
import {
	createRateLimitedWarn,
	networkChangeJournalPath,
	networkChangeSession,
	networkChangeTouches,
	resetDamagedNetworkChangeJournal,
	resolveNetworkChangeSession,
	startNetworkChangeSafety,
	TICK_MS,
} from "./network-change-runtime.ts";

function fakeOwner() {
	const calls: string[] = [];
	return {
		calls,
		owner: {
			async reconcile(reason: "backend-start" | "network-restart" | "boot") {
				calls.push(`reconcile:${reason}`);
				return "clean" as const;
			},
			async tick() {
				calls.push("tick");
				return false;
			},
		},
	};
}

function timers() {
	const scheduled: Array<{ fn: () => void; ms: number }> = [];
	const cleared: unknown[] = [];
	return {
		scheduled,
		cleared,
		setInterval: (fn: () => void, ms: number) => {
			scheduled.push({ fn, ms });
			return scheduled.length;
		},
		clearInterval: (handle: unknown) => {
			cleared.push(handle);
		},
	};
}

describe("journal location", () => {
	it("is under /data on a device, overridable, and cwd-relative in development", () => {
		expect(networkChangeJournalPath({}, "/x")).toBe(DEFAULT_JOURNAL_PATH);
		expect(DEFAULT_JOURNAL_PATH.startsWith("/data/ceralive/")).toBe(true);
		expect(
			networkChangeJournalPath({ CERALIVE_NETWORK_CHANGE_DIR: "/tmp/n" }, "/x"),
		).toBe("/tmp/n/journal.json");
		expect(networkChangeJournalPath({ NODE_ENV: "development" }, "/x")).toBe(
			"/x/network-change/journal.json",
		);
	});
});

describe("start-up recovery", () => {
	it("does nothing with the flag off and no journal", async () => {
		const o = fakeOwner();
		const t = timers();
		await startNetworkChangeSafety({
			enabled: false,
			journalExists: false,
			owner: o.owner,
			...t,
		});
		expect(o.calls).toEqual([]);
		expect(t.scheduled).toEqual([]);
	});

	it("still recovers a journal with the flag off", async () => {
		const o = fakeOwner();
		const t = timers();
		const stop = await startNetworkChangeSafety({
			enabled: false,
			journalExists: true,
			owner: o.owner,
			...t,
		});
		expect(o.calls).toEqual(["reconcile:backend-start"]);
		expect(t.scheduled.map((s) => s.ms)).toEqual([TICK_MS]);
		t.scheduled[0]?.fn();
		await Promise.resolve();
		expect(o.calls).toEqual(["reconcile:backend-start", "tick"]);
		stop();
		expect(t.cleared).toEqual([1]);
	});

	it("keeps ticking when the start-up reconcile fails", async () => {
		const o = fakeOwner();
		const t = timers();
		await startNetworkChangeSafety({
			enabled: true,
			journalExists: false,
			owner: {
				...o.owner,
				reconcile: async () => {
					throw new Error("journal unavailable");
				},
			},
			...t,
		});
		expect(t.scheduled).toHaveLength(1);
	});
});

describe("the session the owner judges", () => {
	const socket = (data: Partial<SocketData>) =>
		({
			data: { isAuthenticated: true, lastActive: 0, ...data },
		}) as unknown as AppWebSocket;
	const path = { peer: "192.0.2.10", interface: "eth0", local: "192.0.2.1" };

	it("takes the arrival interface from the front door's still-valid evidence only", () => {
		expect(
			networkChangeSession(
				socket({ ingressPath: path, ingressPathValid: () => true }),
			).ingress,
		).toBe("eth0");
		expect(
			networkChangeSession(
				socket({ ingressPath: path, ingressPathValid: () => false }),
			).ingress,
		).toBeUndefined();
		expect(networkChangeSession(socket({ ingressPath: path })).ingress).toBe(
			undefined,
		);
		expect(networkChangeSession(socket({})).ingress).toBeUndefined();
	});

	it("carries the socket's id and open time, and never confirms without them", () => {
		expect(
			networkChangeSession(socket({ sessionId: "s1", openedAt: 42 })),
		).toEqual({
			id: "s1",
			openedAt: 42,
			authenticated: true,
			ingress: undefined,
		});
		const bare = networkChangeSession(socket({ isAuthenticated: false }));
		expect(bare).toMatchObject({ id: "", openedAt: 0, authenticated: false });
	});
});

describe("whether a change in flight names a port", () => {
	it("is false without a journal, without asking the owner", async () => {
		let asked = false;
		const owner = {
			touches: async () => {
				asked = true;
				return true;
			},
		};
		expect(
			await networkChangeTouches("eth0", { journalExists: false, owner }),
		).toBe(false);
		expect(asked).toBe(false);
	});

	it("asks the owner when a journal exists, and treats an unreadable one as in flight", async () => {
		expect(
			await networkChangeTouches("eth0", {
				journalExists: true,
				owner: { touches: async (device) => device === "eth0" },
			}),
		).toBe(true);
		expect(
			await networkChangeTouches("eth0", {
				journalExists: true,
				owner: {
					touches: async () => {
						throw new Error("Network-change journal unavailable");
					},
				},
			}),
		).toBe(true);
	});
});

describe("the route back to a session without arrival evidence", () => {
	const socket = (data: Partial<SocketData>, remoteAddress = "100.64.0.7") =>
		({
			remoteAddress,
			data: { isAuthenticated: true, lastActive: 0, ...data },
		}) as unknown as AppWebSocket;
	const route = { carriers: ["eth0"], tunnel: true };

	it("is looked up only when the front door gave no evidence", async () => {
		const looked: string[] = [];
		const lookup = async (address: string) => {
			looked.push(address);
			return route;
		};
		const direct = await resolveNetworkChangeSession(
			socket({
				ingressPath: { peer: "192.0.2.10", interface: "eth0", local: "x" },
				ingressPathValid: () => true,
			}),
			lookup,
		);
		expect(direct.route).toBeUndefined();
		expect(looked).toEqual([]);
		const remote = await resolveNetworkChangeSession(socket({}), lookup);
		expect(remote).toMatchObject({ ingress: undefined, route });
		expect(looked).toEqual(["100.64.0.7"]);
	});

	it("keeps the port the front door named even after its evidence stopped holding", async () => {
		const stale = await resolveNetworkChangeSession(
			socket({
				ingressPath: { peer: "192.0.2.10", interface: "eth0", local: "x" },
				ingressPathValid: () => false,
			}),
			async () => undefined,
		);
		// It can no longer confirm, but it still refuses keep-if-reachable.
		expect(stale.ingress).toBeUndefined();
		expect(stale.capturedIngress).toBe("eth0");
	});

	it("a failed lookup leaves the session as it was", async () => {
		const remote = await resolveNetworkChangeSession(socket({}), async () => {
			throw new Error("ip failed");
		});
		expect(remote.route).toBeUndefined();
		const none = await resolveNetworkChangeSession(
			socket({}),
			async () => undefined,
		);
		expect(none).not.toHaveProperty("route");
	});
});

describe("warnings that would repeat every 5 s", () => {
	it("says it once, then again only when it changes or after ten minutes", () => {
		const lines: string[] = [];
		let now = 0;
		const warn = createRateLimitedWarn((m) => lines.push(m), {
			now: () => now,
		});
		for (let i = 0; i < 100; i++) {
			now += 5_000;
			warn("journal unavailable");
		}
		expect(lines).toEqual(["journal unavailable"]);
		warn("other problem");
		expect(lines.at(-1)).toBe("other problem");
		warn("journal unavailable");
		expect(lines).toHaveLength(3);
		now += 10 * 60_000;
		warn("journal unavailable");
		warn("journal unavailable");
		now += 10 * 60_000;
		warn("journal unavailable");
		expect(lines.slice(3)).toEqual([
			"journal unavailable",
			"journal unavailable (repeated 1 times)",
		]);
	});

	it("a damaged journal failing every tick is logged once", async () => {
		const t = timers();
		const lines: string[] = [];
		await startNetworkChangeSafety({
			enabled: false,
			journalExists: true,
			owner: {
				async reconcile() {
					return "clean" as const;
				},
				async tick() {
					throw new Error("Network-change journal unavailable");
				},
			},
			setInterval: t.setInterval,
			clearInterval: t.clearInterval,
			warn: (m) => lines.push(m),
		});
		for (let i = 0; i < 50; i++) t.scheduled[0]?.fn();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(lines).toEqual([
			"network change safety: tick failed: Network-change journal unavailable",
		]);
	});
});

describe("the way out of a damaged journal", () => {
	it("hands the check and the move to the owner, after confirming a journal exists", async () => {
		const d = mkdtempSync(join(tmpdir(), "nc-reset-"));
		const path = join(d, "journal.json");
		writeFileSync(path, "{not json");
		const calls: string[] = [];
		const owner = {
			async resetDamagedJournal() {
				calls.push("reset");
				return { movedTo: `${path}.damaged-x` };
			},
		};
		expect(await resetDamagedNetworkChangeJournal({ path, owner })).toEqual({
			movedTo: `${path}.damaged-x`,
		});
		await expect(
			resetDamagedNetworkChangeJournal({ path: join(d, "absent.json"), owner }),
		).rejects.toThrow("No network-change journal");
		expect(calls).toEqual(["reset"]);
		rmSync(d, { recursive: true, force: true });
	});
});

describe("warnings by failure class", () => {
	it("the same damaged journal read for different ports logs once", async () => {
		const lines: string[] = [];
		const warn = createRateLimitedWarn((m) => lines.push(m));
		const owner = {
			touches: async () => {
				throw new Error("Network-change journal unavailable");
			},
		};
		for (const port of ["eth0", "eth1", "eth0", "eth1"])
			await networkChangeTouches(port, { journalExists: true, owner, warn });
		expect(lines).toHaveLength(1);
	});
});
