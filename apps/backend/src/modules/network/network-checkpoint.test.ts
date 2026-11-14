import { describe, expect, it } from "bun:test";
import { createNetworkCheckpointOwner } from "./network-checkpoint.ts";

function fixture() {
	let now = 1000;
	let exists = true;
	const calls: string[] = [];
	const owner = createNetworkCheckpointOwner({
		now: () => now,
		create: async (devices, timeout) => {
			exists = true;
			calls.push(`create:${devices.join(",")}:${timeout}`);
			return "/checkpoint/1";
		},
		live: async () => exists,
		destroy: async () => {
			if (!exists) throw new Error("expired");
			calls.push("destroy");
			exists = false;
		},
		rollback: async () => {
			calls.push("rollback");
			exists = false;
		},
	});
	const old = {
		id: "old",
		openedAt: 500,
		authenticated: true,
		ingress: "eth0",
	};
	const fresh = {
		id: "fresh",
		openedAt: 1001,
		authenticated: true,
		ingress: "eth0",
	};
	return {
		owner,
		calls,
		old,
		fresh,
		expire: () => {
			exists = false;
		},
		setTime: (value: number) => {
			now = value;
		},
		advance: () => {
			now = 91001;
		},
	};
}

describe("NetworkManager checkpoint confirmation", () => {
	it("arms the daemon's 90 second deadline before applying in memory", async () => {
		const f = fixture();
		await f.owner.apply(f.old, ["eth0"], async () => {
			f.calls.push("temporary");
			return [
				async () => {
					f.calls.push("save");
				},
			];
		});
		expect(f.calls).toEqual(["create:eth0:90", "temporary"]);
	});
	it("requires a session opened after the change over the changed interface", async () => {
		const f = fixture();
		const pending = await f.owner.apply(f.old, ["eth0"], async () => [
			async () => {
				f.calls.push("save");
			},
		]);
		for (const session of [
			f.old,
			{ ...f.fresh, openedAt: 999 },
			{ ...f.fresh, authenticated: false },
			{ ...f.fresh, ingress: "wlan0" },
			{ ...f.fresh, ingress: undefined },
		]) {
			await expect(f.owner.confirm(pending.id, session)).rejects.toThrow();
		}
		expect(f.calls).toEqual(["create:eth0:90"]);
		await f.owner.confirm(pending.id, f.fresh);
		expect(f.calls).toEqual(["create:eth0:90", "destroy", "save"]);
	});
	it("does not save after timeout even when the client kept the pending id", async () => {
		const f = fixture();
		const pending = await f.owner.apply(f.old, ["eth0"], async () => [
			async () => {
				f.calls.push("save");
			},
		]);
		f.expire();
		await expect(f.owner.confirm(pending.id, f.fresh)).rejects.toThrow();
		expect(f.calls).not.toContain("save");
	});
	it("checks the deadline before destroying or saving", async () => {
		const f = fixture();
		const pending = await f.owner.apply(f.old, ["eth0"], async () => []);
		f.advance();
		await expect(f.owner.confirm(pending.id, f.fresh)).rejects.toThrow();
		expect(f.calls).toEqual(["create:eth0:90"]);
	});
	it("rolls back a failed apply without writing a profile", async () => {
		const f = fixture();
		await expect(
			f.owner.apply(f.old, ["eth0"], async () => {
				throw new Error("apply failed");
			}),
		).rejects.toThrow("apply failed");
		expect(f.calls).toEqual(["create:eth0:90", "rollback"]);
	});
	it("refuses overlapping changes until the daemon checkpoint expires", async () => {
		const f = fixture();
		await f.owner.apply(f.old, ["eth0"], async () => []);
		await expect(
			f.owner.apply(f.old, ["eth1"], async () => []),
		).rejects.toThrow();
		f.expire();
		await f.owner.apply(f.old, ["eth1"], async () => []);
		expect(f.calls).toEqual(["create:eth0:90", "create:eth1:90"]);
	});
	it("does not dispatch for an unauthenticated session or an empty device set", async () => {
		const f = fixture();
		await expect(
			f.owner.apply(
				{ ...f.old, authenticated: false },
				["eth0"],
				async () => [],
			),
		).rejects.toThrow();
		await expect(f.owner.apply(f.old, [], async () => [])).rejects.toThrow();
		expect(f.calls).toEqual([]);
	});
	it("refuses simultaneous applies while checkpoint creation is in flight", async () => {
		const f = fixture();
		const first = f.owner.apply(f.old, ["eth0"], async () => []);
		await expect(
			f.owner.apply(f.old, ["eth1"], async () => []),
		).rejects.toThrow();
		await first;
	});
});

it("refuses a session opened during apply before the candidate was ready", async () => {
	const f = fixture();
	const pending = await f.owner.apply(f.old, ["eth0"], async () => {
		f.setTime(2000);
		return [];
	});
	await expect(f.owner.confirm(pending.id, f.fresh)).rejects.toThrow();
	expect(f.calls).toEqual(["create:eth0:90"]);
});

it("never persists when the daemon rejects checkpoint destruction", async () => {
	const calls: string[] = [];
	const owner = createNetworkCheckpointOwner({
		now: () => 1000,
		create: async () => "/checkpoint/1",
		live: async () => true,
		destroy: async () => {
			throw new Error("expired during confirm");
		},
		rollback: async () => {},
	});
	const pending = await owner.apply(
		{ id: "old", openedAt: 0, authenticated: true, ingress: "eth0" },
		["eth0"],
		async () => [
			async () => {
				calls.push("save");
			},
		],
	);
	await expect(
		owner.confirm(pending.id, {
			id: "new",
			openedAt: 1001,
			authenticated: true,
			ingress: "eth0",
		}),
	).rejects.toThrow("expired during confirm");
	expect(calls).toEqual([]);
});

it("does not apply when checkpoint creation fails", async () => {
	let applied = false;
	const owner = createNetworkCheckpointOwner({
		now: () => 1000,
		create: async () => {
			throw new Error("unavailable");
		},
		live: async () => false,
		destroy: async () => {},
		rollback: async () => {},
	});
	await expect(
		owner.apply(
			{ id: "old", openedAt: 0, authenticated: true, ingress: "eth0" },
			["eth0"],
			async () => {
				applied = true;
				return [];
			},
		),
	).rejects.toThrow("unavailable");
	expect(applied).toBe(false);
});

it("clears its status only when the daemon no longer reports the checkpoint", async () => {
	const f = fixture();
	const pending = await f.owner.apply(f.old, ["eth0"], async () => []);
	expect(await f.owner.status()).toEqual(pending);
	f.expire();
	expect(await f.owner.status()).toBeNull();
});
