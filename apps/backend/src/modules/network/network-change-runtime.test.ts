import { describe, expect, it } from "bun:test";
import type { AppWebSocket, SocketData } from "../../rpc/types.ts";
import { DEFAULT_JOURNAL_PATH } from "./network-change-journal.ts";
import {
	networkChangeJournalPath,
	networkChangeSession,
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
