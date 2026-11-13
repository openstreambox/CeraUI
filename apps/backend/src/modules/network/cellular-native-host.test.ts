import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivateJson } from "../../helpers/private-json-state.ts";
import {
	CellularNativeHost,
	type CellularNativeHostDeps,
} from "./cellular-native-host.ts";
import { parseCellularNativeHostPlan } from "./cellular-native-host-plan.ts";
import type { CellularFenceMode } from "./cellular-packet-fence.ts";

const bootId = "11111111-1111-1111-1111-111111111111";
const authority = {
	bootId,
	input: {
		owner: "a".repeat(64),
		epoch: "grant-one",
		slot: 1,
		iface: "wwan0",
		mtu: 1428,
		ipv4: "192.0.2.2",
	},
	ifindex: 17,
	dns: ["192.0.2.53"],
};

test("an internal address is immutable physical authority and cannot name another link or index", () => {
	const ownedAddress = {
		ifname: "wwan0",
		ifindex: "17",
		usbDevice: "synthetic-usb",
		netDevice: "synthetic-net",
		generation: "one",
	};
	const plan = parseCellularNativeHostPlan({ ...authority, ownedAddress });
	expect(Object.isFrozen(plan.ownedAddress)).toBe(true);
	expect(parseCellularNativeHostPlan(authority)).toEqual(authority);
	for (const patch of [
		{ ifname: "other0" },
		{ ifindex: "18" },
		{ ifindex: "017" },
		{ usbDevice: "" },
		{ generation: "" },
		{ extra: true },
	])
		expect(() =>
			parseCellularNativeHostPlan({
				...authority,
				ownedAddress: { ...ownedAddress, ...patch },
			}),
		).toThrow();
});
async function fixture(internal = false) {
	const dir = await mkdtemp(join(tmpdir(), "cellular-native-host-")),
		key = createHash("sha256")
			.update(`cellular-uplink-slot\0${1}`)
			.digest("hex"),
		events: string[] = [],
		installed = new Set<string>();
	let mode: CellularFenceMode | "absent" = "absent",
		consumers = false,
		owned = true,
		current = true,
		lostReply = false;
	let hold: Promise<boolean> | undefined;
	let address: "absent" | "owned" | "foreign" = "absent",
		lostAddressReply = false;
	const deps: CellularNativeHostDeps = {
		store: { dir },
		bootId,
		owned: () => owned,
		currentNow: () => current,
		current: async () => (hold ? await hold : current),
		withdraw: () => {
			events.push("withdraw");
		},
		cancelProbe: () => {
			events.push("cancel");
		},
		consumersReleased: async () => consumers,
		effects: (_plan, _fence, _current, _writable, context) => ({
			...(context
				? {
						address: {
							inspect: async () => address,
							apply: async () => {
								expect(await readPrivateJson({ dir }, key)).toMatchObject({
									cursor: 2,
									phase: "applying",
								});
								expect(context.effect).toEqual({
									kind: "address",
									family: 4,
									address: authority.input.ipv4,
									prefix: 32,
								});
								events.push("address-add");
								address = "owned";
								if (lostAddressReply) throw new Error("lost address reply");
							},
							remove: async () => {
								if (address === "foreign") return false;
								events.push("address-remove");
								address = "absent";
								return true;
							},
						},
					}
				: {}),
			firewall: {
				inspect: async () => mode,
				create: async (value) => {
					expect(await readPrivateJson({ dir }, key)).toMatchObject({
						cursor: 1,
						phase: "applying",
					});
					events.push("fence-create");
					mode = value;
				},
				transition: async (value) => {
					events.push(`fence-${value}`);
					mode = value;
				},
				remove: async () => {
					events.push("fence-remove");
					mode = "absent";
					return true;
				},
			},
			ip: {
				inspect: async (effect) =>
					installed.has(JSON.stringify(effect)) ? "owned" : "absent",
				apply: async (effect) => {
					events.push("ip-add");
					installed.add(JSON.stringify(effect));
					if (lostReply) throw new Error("lost IP reply");
				},
				remove: async (effect) => {
					events.push("ip-remove");
					installed.delete(JSON.stringify(effect));
					return true;
				},
			},
		}),
	};
	const host = new CellularNativeHost(
		{
			...authority,
			...(internal
				? {
						ownedAddress: {
							ifname: "wwan0",
							ifindex: "17",
							usbDevice: "synthetic-usb",
							netDevice: "synthetic-net",
							generation: "one",
						},
					}
				: {}),
		},
		deps,
	);
	return {
		host,
		deps,
		events,
		installed,
		record: () => readPrivateJson({ dir }, key),
		address: () => address,
		set: (state: {
			consumers?: boolean;
			owned?: boolean;
			current?: boolean;
			lostReply?: boolean;
			hold?: Promise<boolean>;
			address?: "absent" | "owned" | "foreign";
			lostAddressReply?: boolean;
		}) => {
			if (state.consumers !== undefined) consumers = state.consumers;
			if (state.owned !== undefined) owned = state.owned;
			if (state.current !== undefined) current = state.current;
			if (state.lostReply !== undefined) lostReply = state.lostReply;
			if (state.hold) hold = state.hold;
			if (state.address !== undefined) address = state.address;
			if (state.lostAddressReply !== undefined)
				lostAddressReply = state.lostAddressReply;
		},
		setFence: (value: CellularFenceMode) => {
			mode = value;
		},
		clearFence: () => {
			mode = "absent";
		},
		close: () => rm(dir, { recursive: true, force: true }),
	};
}

test("an internal /32 is added behind the durable fence and removed only after consumers release", async () => {
	const f = await fixture(true);
	try {
		await f.host.install();
		expect(f.events.indexOf("fence-create")).toBeLessThan(
			f.events.indexOf("address-add"),
		);
		expect(f.events.indexOf("address-add")).toBeLessThan(
			f.events.indexOf("ip-add"),
		);
		expect(await f.host.valid()).toBe(true);
		expect(await f.host.cleanup()).toBe(false);
		expect(f.address()).toBe("owned");
		expect(f.events).not.toContain("address-remove");
		f.set({ consumers: true, current: false });
		expect(await f.host.cleanup()).toBe(true);
		expect(f.events.indexOf("address-remove")).toBeLessThan(
			f.events.indexOf("fence-remove"),
		);
		expect(f.address()).toBe("absent");
	} finally {
		await f.close();
	}
});
test("a lost internal address acknowledgement retains its exact inverse without adding routes", async () => {
	const f = await fixture(true);
	try {
		f.set({ lostAddressReply: true });
		await expect(f.host.install()).rejects.toThrow("lost address reply");
		expect(f.address()).toBe("owned");
		expect(f.events).not.toContain("ip-add");
		expect(await f.record()).toMatchObject({ cursor: 2, phase: "applying" });
		expect(await f.host.cleanup()).toBe(false);
		f.set({ consumers: true });
		expect(await f.host.cleanup()).toBe(true);
		expect(f.address()).toBe("absent");
	} finally {
		await f.close();
	}
});
test("a pre-existing address cannot be adopted; a later foreign address edit retains the fence and inverse", async () => {
	for (const address of ["owned", "foreign"] as const) {
		const f = await fixture(true);
		try {
			f.set({ address });
			await expect(f.host.install()).rejects.toThrow(
				"Native address already exists",
			);
			expect(await f.record()).toBeUndefined();
			expect(f.events).toEqual([]);
		} finally {
			await f.close();
		}
	}
	const f = await fixture(true);
	try {
		await f.host.install();
		f.set({ consumers: true, address: "foreign" });
		expect(await f.host.valid()).toBe(false);
		expect(await f.host.cleanup()).toBe(false);
		expect(f.events).not.toContain("address-remove");
		expect(f.events).not.toContain("fence-remove");
		expect(await f.record()).toBeDefined();
		f.set({ address: "owned" });
		expect(await f.host.cleanup()).toBe(true);
	} finally {
		await f.close();
	}
});
test("native installation is denied until complete, and cleanup waits for actual consumers behind a deny fence", async () => {
	const f = await fixture();
	try {
		expect(await f.host.setReady(true)).toBe(false);
		await f.host.install();
		expect(await f.host.valid()).toBe(true);
		expect(await f.host.prepareProbe()).toBe(true);
		expect(await f.host.setReady(true)).toBe(true);
		const before = f.events.length;
		expect(await f.host.prepareProbe()).toBe(true);
		expect(f.events.length).toBe(before); // Routine health does not interrupt ready traffic.
		expect(await f.host.cleanup()).toBe(false);
		expect(f.events.indexOf("withdraw")).toBeLessThan(
			f.events.indexOf("fence-withdrawn"),
		);
		expect(f.events).not.toContain("ip-remove");
		expect(await f.record()).toMatchObject({ phase: "withdrawing" });
		f.set({ consumers: true });
		expect(await f.host.cleanup()).toBe(true);
		expect(f.events.at(-1)).toBe("fence-remove");
		expect(await f.record()).toBeUndefined();
		f.set({ owned: false });
		expect(await f.host.setReady(true)).toBe(false);
	} finally {
		await f.close();
	}
});
test("an uncertain IP apply retains its inverse and can only clean up before another install", async () => {
	const f = await fixture();
	try {
		f.set({ lostReply: true });
		await expect(f.host.install()).rejects.toThrow("lost IP reply");
		expect(await f.record()).toMatchObject({ cursor: 2, phase: "applying" });
		await expect(f.host.install()).rejects.toThrow("remains owned");
		f.set({ consumers: true });
		expect(await f.host.cleanup()).toBe(true);
		expect(f.installed.size).toBe(0);
	} finally {
		await f.close();
	}
});
test("closing during a delayed readiness check cancels publication and a retired actor cannot touch its successor", async () => {
	const f = await fixture();
	try {
		await f.host.install();
		let release: (value: boolean) => void = () => {};
		f.set({
			hold: new Promise<boolean>((resolve) => {
				release = resolve;
			}),
			consumers: true,
		});
		const ready = f.host.setReady(true),
			cleanup = f.host.cleanup();
		release(true);
		expect(await ready).toBe(false);
		expect(await cleanup).toBe(true);
		expect(f.events).not.toContain("fence-ready");
		const successor = new CellularNativeHost(
			{ ...authority, input: { ...authority.input, epoch: "grant-two" } },
			f.deps,
		);
		await successor.install();
		const before = f.events.length;
		expect(await f.host.cleanup()).toBe(true);
		expect(await f.host.setReady(false)).toBe(false);
		expect(f.events.slice(before)).toEqual([]);
		expect(await successor.valid()).toBe(true);
	} finally {
		await f.close();
	}
});

test("a retained native inverse never adopts matching resources on another boot", async () => {
	const f = await fixture();
	try {
		await f.host.install();
		f.set({ consumers: true });
		const recovered = new CellularNativeHost(authority, {
			...f.deps,
			bootId: "22222222-2222-2222-2222-222222222222",
		});
		expect(await recovered.valid()).toBe(false);
		expect(await recovered.setReady(false)).toBe(false);
		await expect(recovered.install()).rejects.toThrow("identity unavailable");
		const before = f.events.length;
		await expect(recovered.cleanup()).rejects.toThrow("another boot");
		expect(f.events.slice(before)).toEqual(["cancel", "withdraw"]);
		f.clearFence();
		expect(await recovered.cleanup()).toBe(false);
		expect(f.events).not.toContain("ip-remove");
		expect(await f.record()).toBeDefined();
		// A complete positive absence read can retire only the private cursor.
		f.installed.clear();
		expect(await recovered.cleanup()).toBe(true);
		expect(await f.record()).toBeUndefined();
		expect(f.events).not.toContain("fence-remove");
	} finally {
		await f.close();
	}
});
test("native plans freeze captured authority and reject missing or invalid boot identity", () => {
	const mutable = structuredClone(authority),
		captured = parseCellularNativeHostPlan(mutable);
	mutable.input.ipv4 = "192.0.2.9";
	mutable.dns.push("192.0.2.54");
	expect(captured.input.ipv4).toBe(authority.input.ipv4);
	expect(captured.dns).toEqual(authority.dns);
	expect(Object.isFrozen(captured)).toBe(true);
	expect(Object.isFrozen(captured.input)).toBe(true);
	expect(Object.isFrozen(captured.dns)).toBe(true);
	const { bootId: _bootId, ...unbound } = mutable;
	expect(() => parseCellularNativeHostPlan(unbound)).toThrow();
	expect(() =>
		parseCellularNativeHostPlan({ ...mutable, bootId: "unknown" }),
	).toThrow();
});

test("a failed directory acknowledgement after unlink retains cleanup until kernel absence and fsync are proved", async () => {
	const f = await fixture();
	try {
		await f.host.install();
		f.set({ consumers: true });
		const key = createHash("sha256")
				.update(`cellular-uplink-slot\0${1}`)
				.digest("hex"),
			path = join(f.deps.store.dir, `${key}.json`),
			actual = fs.fsyncSync;
		let failed = false;
		const fault = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
			if (
				!failed &&
				!fs.existsSync(path) &&
				fs.readlinkSync(`/proc/self/fd/${fd}`) === f.deps.store.dir
			) {
				failed = true;
				throw new Error("directory ack failed");
			}
			actual(fd);
		});
		try {
			await expect(f.host.cleanup()).rejects.toThrow("directory ack failed");
		} finally {
			fault.mockRestore();
		}
		expect(failed).toBe(true);
		expect(await f.record()).toBeUndefined();
		f.setFence("ready");
		const before = f.events.length;
		expect(await f.host.cleanup()).toBe(false);
		expect(f.events.slice(before)).toEqual(["cancel"]);
		f.clearFence();
		expect(await f.host.cleanup()).toBe(true);
	} finally {
		await f.close();
	}
});
