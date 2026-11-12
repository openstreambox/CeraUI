import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivateJson } from "../../helpers/private-json-state.ts";
import {
	CellularNativeHost,
	type CellularNativeHostDeps,
} from "./cellular-native-host.ts";
import type { CellularFenceMode } from "./cellular-packet-fence.ts";

const authority = {
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
async function fixture() {
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
	const deps: CellularNativeHostDeps = {
		store: { dir },
		owned: () => owned,
		current: async () => (hold ? await hold : current),
		withdraw: () => {
			events.push("withdraw");
		},
		cancelProbe: () => {
			events.push("cancel");
		},
		consumersReleased: async () => consumers,
		effects: () => ({
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
	const host = new CellularNativeHost(authority, deps);
	return {
		host,
		deps,
		events,
		installed,
		record: () => readPrivateJson({ dir }, key),
		set: (state: {
			consumers?: boolean;
			owned?: boolean;
			current?: boolean;
			lostReply?: boolean;
			hold?: Promise<boolean>;
		}) => {
			if (state.consumers !== undefined) consumers = state.consumers;
			if (state.owned !== undefined) owned = state.owned;
			if (state.current !== undefined) current = state.current;
			if (state.lostReply !== undefined) lostReply = state.lostReply;
			if (state.hold) hold = state.hold;
		},
		close: () => rm(dir, { recursive: true, force: true }),
	};
}
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
