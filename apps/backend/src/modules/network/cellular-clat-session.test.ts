import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivateJson } from "../../helpers/private-json-state.ts";
import {
	CellularClatSession,
	cellularClatBirthKey,
	parseCellularClatBirthPlan,
} from "./cellular-clat-session.ts";
import { cellularTunAlias } from "./cellular-tun.ts";

const owner = "a".repeat(64),
	tunEpoch = "b".repeat(64),
	plan = parseCellularClatBirthPlan({
		input: {
			owner,
			epoch: "grant-one",
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
		dns: [],
	});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "cellular-clat-birth-")),
		store = { dir },
		events: string[] = [];
	let present = false,
		foreign = false,
		referenced = false,
		consumers = false,
		live = true,
		owned = true,
		lost = false,
		bootId = plan.bootId,
		childPresent = false;
	const tun = {
		name: "cclat1",
		index: 8,
		alias: cellularTunAlias(owner, tunEpoch),
		persistent: true,
	} as const;
	const row = () => ({
		ifname: tun.name,
		ifindex: tun.index,
		ifalias: foreign ? "foreign" : tun.alias,
		linkinfo: {
			info_kind: "tun",
			info_data: { type: "tun", pi: true, persist: true, multi_queue: false },
		},
	});
	const make = () =>
		new CellularClatSession(plan, {
			store,
			bootId,
			owned: () => owned,
			currentNow: () => live,
			current: async () => live,
			preflight: async () => !present,
			links: async () => (present ? [row()] : []),
			createTun: async () => {
				expect(
					await readPrivateJson(store, cellularClatBirthKey(1)),
				).toMatchObject({ childSubmitted: false });
				events.push("birth");
				present = true;
				if (lost) throw new Error("lost birth reply");
				return tun;
			},
			unreferenced: async () => !referenced,
			deleteTun: async () => {
				events.push("delete");
				present = false;
				return true;
			},
			child: () => ({
				binding: {
					source: "198.18.255.1",
					device: "cclat1",
					translated: true,
					generation: "grant-one",
				},
				dns: { source: "2001:db8:1::2", device: "wwan0", ifindex: 7, dns: [] },
				cancelProbe: () => {},
				valid: async () => childPresent,
				prepareProbe: async () => true,
				setReady: async () => true,
				install: async () => {
					expect(
						await readPrivateJson(store, cellularClatBirthKey(1)),
					).toMatchObject({ childSubmitted: true, tun });
					events.push("child-install");
					childPresent = true;
				},
				cleanup: async () => {
					events.push("deny-child");
					if (!consumers) return false;
					events.push("child-remove");
					childPresent = false;
					return true;
				},
			}),
			withdraw: () => {
				events.push("withdraw");
			},
			cancelProbe: () => {},
			consumersReleased: async () => consumers,
			release: () => {
				events.push("release");
				owned = false;
			},
		});
	return {
		make,
		events,
		store,
		set: (values: {
			lost?: boolean;
			consumers?: boolean;
			referenced?: boolean;
			foreign?: boolean;
			live?: boolean;
			bootId?: string;
		}) => {
			if (values.lost !== undefined) lost = values.lost;
			if (values.consumers !== undefined) consumers = values.consumers;
			if (values.referenced !== undefined) referenced = values.referenced;
			if (values.foreign !== undefined) foreign = values.foreign;
			if (values.live !== undefined) live = values.live;
			if (values.bootId !== undefined) bootId = values.bootId;
		},
		close: () => rm(dir, { recursive: true, force: true }),
	};
}
test("birth and child submission are durable before effects; cleanup releases only after consumers and an unreferenced TUN", async () => {
	const f = await fixture(),
		session = f.make();
	try {
		await session.install();
		expect(await session.valid()).toBe(true);
		expect(await session.cleanup()).toBe(false);
		expect(f.events).toEqual([
			"birth",
			"child-install",
			"withdraw",
			"deny-child",
		]);
		f.set({ consumers: true, referenced: true });
		expect(await session.cleanup()).toBe(false);
		expect(f.events).not.toContain("delete");
		expect(f.events).not.toContain("release");
		f.set({ referenced: false });
		expect(await session.cleanup()).toBe(true);
		expect(f.events.slice(-2)).toEqual(["delete", "release"]);
		expect(
			await readPrivateJson(f.store, cellularClatBirthKey(1)),
		).toBeUndefined();
		const before = [...f.events];
		expect(await session.cleanup()).toBe(true);
		expect(f.events).toEqual(before);
	} finally {
		await f.close();
	}
});
test("a lost birth reply can be cleaned after reconstruction but can never replay creation or start a child", async () => {
	const f = await fixture();
	try {
		f.set({ lost: true });
		await expect(f.make().install()).rejects.toThrow("lost birth reply");
		const recovered = f.make();
		await expect(recovered.install()).rejects.toThrow("remains owned");
		f.set({ consumers: true, live: false });
		expect(await recovered.cleanup()).toBe(true);
		expect(f.events).toEqual(["birth", "withdraw", "delete", "release"]);
	} finally {
		await f.close();
	}
});
test("foreign and cross-boot TUN identities retain the birth and its lease", async () => {
	for (const replacement of [
		{ foreign: true },
		{ bootId: "22222222-2222-3333-4444-555555555555" },
	]) {
		const f = await fixture();
		try {
			f.set({ lost: true });
			await expect(f.make().install()).rejects.toThrow();
			f.set({ ...replacement, consumers: true });
			expect(await f.make().cleanup()).toBe(false);
			expect(f.events).not.toContain("delete");
			expect(f.events).not.toContain("release");
			expect(
				await readPrivateJson(f.store, cellularClatBirthKey(1)),
			).toBeDefined();
		} finally {
			await f.close();
		}
	}
});
