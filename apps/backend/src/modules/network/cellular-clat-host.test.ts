import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CellularClatHost } from "./cellular-clat-host.ts";
import { parseCellularClatHostPlan } from "./cellular-clat-host-plan.ts";
import { CellularClatReceipt } from "./cellular-clat-receipt.ts";
import type { CellularFenceMode } from "./cellular-packet-fence.ts";
import { cellularTunAlias } from "./cellular-tun.ts";

const owner = "a".repeat(64),
	tunEpoch = "b".repeat(64),
	plan = parseCellularClatHostPlan({
		input: {
			owner,
			epoch: "one",
			slot: 1,
			iface: "wwan0",
			mtu: 1280,
			ipv6: "2001:db8:1::2",
			ipv6PrefixLength: 64,
			ipv6Gateway: "fe80::1",
			nat64: "2001:db8:64::/96",
		},
		physical: {
			ifname: "wwan0",
			ifindex: "7",
			usbDevice: "/sys/devices/example-usb",
			netDevice: "/sys/devices/example-net",
			generation: "usb-one",
		},
		tun: {
			name: "cclat1",
			index: 8,
			alias: cellularTunAlias(owner, tunEpoch),
			persistent: true,
		},
		tunEpoch,
		birth: "c".repeat(32),
		bootId: "11111111-2222-3333-4444-555555555555",
		globalForwarding: "0",
		physicalBefore: {
			accept_ra: "1",
			accept_ra_defrtr: "0",
			forwarding: "0",
			proxy_ndp: "0",
			force_forwarding: "0",
		},
		dns: ["2001:db8::53"],
	});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "cellular-clat-host-")),
		present = new Set<string>(),
		events: string[] = [];
	let live = true,
		owned = true,
		consumers = false,
		mode: CellularFenceMode | "absent" = "absent",
		lost = false;
	let hold: { entered: () => void; pending: Promise<void> } | undefined;
	const host = new CellularClatHost(plan, {
		store: { dir },
		owned: () => owned,
		currentNow: () => live,
		current: async () => true,
		withdraw: () => {
			events.push("withdraw");
		},
		consumersReleased: async () => consumers,
		cancelProbe: () => {
			events.push("cancel");
		},
		effects: (_authority, _routes, guard) => ({
			output: {
				inspect: async () => mode,
				transition: async (next) => {
					expect(guard.writable()).toBe(true);
					events.push(next);
					mode = next;
				},
			},
			inspect: async (step) => {
				if (step === "address" && present.has("receipt") && hold) {
					hold.entered();
					await hold.pending;
				}
				return present.has(step) ? "owned" : "absent";
			},
			apply: async (step) => {
				expect(guard.writable()).toBe(true);
				present.add(step);
				events.push(`add:${step}`);
				if (step === "output") mode = "withdrawn";
				if (step === "address" && lost) throw new Error("lost address reply");
			},
			remove: async (step) => {
				expect(guard.writable()).toBe(true);
				events.push(`remove:${step}`);
				present.delete(step);
			},
			valid: async () => true,
			deny: async () => {
				events.push("deny-both");
				mode = "withdrawn";
			},
		}),
	});
	return {
		host,
		present,
		events,
		set: (value: {
			owned?: boolean;
			live?: boolean;
			consumers?: boolean;
			lost?: boolean;
			hold?: typeof hold;
		}) => {
			if (value.owned !== undefined) owned = value.owned;
			if (value.live !== undefined) live = value.live;
			if (value.consumers !== undefined) consumers = value.consumers;
			if (value.lost !== undefined) lost = value.lost;
			if (value.hold) hold = value.hold;
		},
		close: () => rm(dir, { recursive: true, force: true }),
	};
}
test("the translated session denies before waiting for actual consumers and reverses receipt last", async () => {
	const f = await fixture();
	try {
		await f.host.install();
		expect(await f.host.prepareProbe()).toBe(true);
		expect(await f.host.setReady(true)).toBe(true);
		expect(f.host.binding).toMatchObject({
			source: "198.18.255.1",
			device: "cclat1",
			translated: true,
		});
		expect(f.host.dns).toMatchObject({
			source: "2001:db8:1::2",
			device: "wwan0",
			ifindex: 7,
		});
		expect(await f.host.cleanup()).toBe(false);
		expect(f.events.indexOf("withdraw")).toBeLessThan(
			f.events.indexOf("deny-both"),
		);
		expect(f.events.some((entry) => entry.startsWith("remove:"))).toBe(false);
		f.set({ consumers: true });
		expect(await f.host.cleanup()).toBe(true);
		expect(f.events.at(-1)).toBe("remove:receipt");
		expect(f.events.filter((entry) => entry === "withdraw")).toHaveLength(1);
		const before = f.events.length;
		f.set({ owned: false });
		expect(await f.host.cleanup()).toBe(true);
		expect(await f.host.setReady(false)).toBe(false);
		expect(f.events.length).toBe(before);
	} finally {
		await f.close();
	}
});
test("an uncertain address result keeps its inverse and a repeat install cannot replay it", async () => {
	const f = await fixture();
	try {
		f.set({ lost: true });
		await expect(f.host.install()).rejects.toThrow("lost address reply");
		await expect(f.host.install()).rejects.toThrow("remains owned");
		f.set({ consumers: true });
		expect(await f.host.cleanup()).toBe(true);
		expect(f.present.size).toBe(0);
	} finally {
		await f.close();
	}
});
test("closing during an awaited pre-effect observation forbids that effect even after its cursor write", async () => {
	const f = await fixture();
	let release: () => void = () => {},
		entered: () => void = () => {};
	const observed = new Promise<void>((resolve) => {
		entered = resolve;
	});
	f.set({
		consumers: true,
		hold: {
			entered,
			pending: new Promise<void>((resolve) => {
				release = resolve;
			}),
		},
	});
	try {
		const install = f.host.install();
		await observed;
		const cleanup = f.host.cleanup();
		release();
		await expect(install).rejects.toThrow("apply lease retired");
		expect(await cleanup).toBe(true);
		expect(f.events).not.toContain("add:address");
	} finally {
		release();
		await f.close();
	}
});
test("a translator submission receipt survives owner reconstruction and refuses another invocation or plan", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cellular-clat-receipt-"));
	try {
		const receipt = new CellularClatReceipt(plan, { dir }, () => true);
		await receipt.create();
		await expect(receipt.rememberInvocation("d".repeat(32))).rejects.toThrow(
			"authority",
		);
		await receipt.markTranslatorSubmission();
		const reopened = new CellularClatReceipt(plan, { dir }, () => true);
		await expect(reopened.markTranslatorSubmission()).rejects.toThrow(
			"already submitted",
		);
		await reopened.rememberInvocation("d".repeat(32));
		await expect(reopened.rememberInvocation("e".repeat(32))).rejects.toThrow(
			"authority",
		);
		await expect(
			new CellularClatReceipt(
				{ ...plan, bootId: "22222222-2222-3333-4444-555555555555" },
				{ dir },
				() => true,
			).remove(),
		).rejects.toThrow("authority");
		expect((await receipt.read())?.invocation).toBe("d".repeat(32));
		await reopened.remove();
		expect(await receipt.read()).toBeUndefined();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("revoking the observation blocks readiness but retains permission to deny and undo the old generation", async () => {
	const f = await fixture();
	try {
		await f.host.install();
		expect(await f.host.setReady(true)).toBe(true);
		f.set({ live: false, consumers: true });
		expect(await f.host.valid()).toBe(false);
		expect(await f.host.setReady(true)).toBe(false);
		expect(await f.host.setReady(false)).toBe(true);
		expect(await f.host.cleanup()).toBe(true);
		expect(f.present.size).toBe(0);
	} finally {
		await f.close();
	}
});
