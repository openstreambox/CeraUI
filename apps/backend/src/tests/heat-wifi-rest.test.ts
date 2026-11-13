import { describe, expect, test } from "bun:test";
import {
	HeatWifiRest,
	type IdleWifiRadio,
} from "../modules/wifi/heat-wifi-rest.ts";

function fixture() {
	const row: IdleWifiRadio = {
		key: "usb",
		identity: "boot/usb/7",
		ifname: "wlan1",
		eligible: true,
		up: true,
	};
	let rows: IdleWifiRadio[] = [row];
	const calls: string[] = [];
	let fail = false;
	const rest = new HeatWifiRest({
		read: async () => rows,
		lock: async (_key, fn) => {
			await fn();
		},
		set: async (row, up) => {
			calls.push(`${row.ifname}:${up}`);
			if (fail) throw Error("failed");
			row.up = up;
		},
		record: (row, reason) => calls.push(`${row.ifname}:${reason}`),
	});
	return {
		rest,
		calls,
		rows,
		row,
		setRows: (v: IdleWifiRadio[]) => {
			rows = v;
		},
		fail: (v: boolean) => {
			fail = v;
		},
	};
}
describe("warm idle USB Wi-Fi rest", () => {
	test("rests once, records why, and restores after cooling", async () => {
		const f = fixture();
		await f.rest.update(1, true);
		await f.rest.update(1, true);
		expect(f.calls).toEqual(["wlan1:false", "wlan1:warm-idle-usb"]);
		await f.rest.update(0, true);
		expect(f.calls.slice(2)).toEqual(["wlan1:true", "wlan1:cool"]);
	});
	test("unknown never rests or cools; need still wakes", async () => {
		const f = fixture();
		await f.rest.update(1, false);
		expect(f.calls).toEqual([]);
		await f.rest.update(1, true);
		await f.rest.update(0, false);
		expect(f.calls.length).toBe(2);
		await f.rest.demand("usb");
		expect(f.calls.slice(2)).toEqual(["wlan1:true", "wlan1:needed"]);
		await f.rest.update(1, true);
		expect(f.calls.length).toBe(4);
	});
	test("protected, onboard, connected or uncertain evidence cannot rest", async () => {
		const f = fixture();
		f.row.eligible = false;
		await f.rest.update(1, true);
		expect(f.calls).toEqual([]);
	});
	test("new protection wakes even when temperature is unknown", async () => {
		const f = fixture();
		await f.rest.update(1, true);
		f.row.eligible = false;
		await f.rest.update(1, false);
		expect(f.calls.slice(2)).toEqual(["wlan1:true", "wlan1:needed"]);
		f.row.eligible = true;
		await f.rest.update(1, true);
		expect(f.calls.length).toBe(4);
	});
	test("does not raise an adapter already down", async () => {
		const f = fixture();
		f.row.up = false;
		await f.rest.update(1, true);
		await f.rest.update(0, true);
		expect(f.calls).toEqual([]);
	});
	test("replacement with same name never receives old wake", async () => {
		const f = fixture();
		await f.rest.update(1, true);
		f.setRows([{ ...f.row, identity: "boot/usb/8", up: true }]);
		await f.rest.demand("usb");
		expect(f.calls.length).toBe(2);
	});
	test("failed down is restored conservatively, failed up is retried", async () => {
		const f = fixture();
		f.fail(true);
		await f.rest.update(1, true);
		expect(f.calls).toEqual(["wlan1:false"]);
		await f.rest.demand("usb").catch(() => {});
		f.fail(false);
		await f.rest.demand("usb");
		expect(f.calls.at(-1)).toBe("wlan1:needed");
	});
});

test("unreadable identity retains wake ownership until a successful observation", async () => {
	const f = fixture();
	await f.rest.update(1, true);
	const rows = [...f.rows];
	f.setRows([]);
	await expect(f.rest.demand("usb")).rejects.toThrow("identity unavailable");
	f.setRows(rows);
	await f.rest.demand("usb");
	expect(f.calls.at(-1)).toBe("wlan1:needed");
});

test("restart restores journaled links before taking another rest", async () => {
	const row: IdleWifiRadio = {
		key: "usb",
		identity: "boot/usb/7",
		ifname: "wlan1",
		eligible: true,
		up: false,
	};
	const calls: string[] = [];
	const rest = new HeatWifiRest({
		read: async () => [row],
		lock: async (_key, fn) => fn(),
		set: async (_row, up) => {
			calls.push(String(up));
		},
		record: () => undefined,
		load: async () => [row],
		save: async (rows) => {
			calls.push(`saved:${rows.length}`);
		},
	});
	await rest.update(1, true);
	expect(calls).toEqual(["true", "saved:0"]);
});

test("a failed recovery record write prevents lowering", async () => {
	let changed = false;
	const row: IdleWifiRadio = {
		key: "usb",
		identity: "boot/usb/7",
		ifname: "wlan1",
		eligible: true,
		up: true,
	};
	const rest = new HeatWifiRest({
		read: async () => [row],
		lock: async (_key, fn) => fn(),
		set: async () => {
			changed = true;
		},
		record: () => undefined,
		save: async () => {
			throw Error("read-only");
		},
	});
	await expect(rest.update(1, true)).rejects.toThrow("read-only");
	expect(changed).toBe(false);
});
test("a cooled or stale trigger during interface reads prevents lowering", async () => {
	let warm = true;
	let changed = false;
	let reads = 0;
	const row: IdleWifiRadio = {
		key: "usb",
		identity: "boot/usb/7",
		ifname: "wlan1",
		eligible: true,
		up: true,
	};
	const rest = new HeatWifiRest({
		read: async () => {
			if (++reads === 2) warm = false;
			return [row];
		},
		lock: async (_key, fn) => fn(),
		set: async () => {
			changed = true;
		},
		record: () => undefined,
		canRest: () => warm,
	});
	await rest.update(1, true);
	expect(changed).toBe(false);
});
test("fresh protection under the adapter lock vetoes an earlier idle snapshot", async () => {
	let changed = false;
	let reads = 0;
	const row: IdleWifiRadio = {
		key: "usb",
		identity: "boot/usb/7",
		ifname: "wlan1",
		eligible: true,
		up: true,
	};
	const rest = new HeatWifiRest({
		read: async () => [{ ...row, eligible: ++reads === 1 }],
		lock: async (_key, fn) => fn(),
		set: async () => {
			changed = true;
		},
		record: () => undefined,
	});
	await rest.update(1, true);
	expect(changed).toBe(false);
});

test("demand wake needs identity proof, not working route or NM readers", async () => {
	const row: IdleWifiRadio = {
		key: "usb",
		identity: "boot/usb/7",
		ifname: "wlan1",
		eligible: true,
		up: true,
	};
	let broken = false;
	const calls: boolean[] = [];
	const rest = new HeatWifiRest({
		read: async () => {
			if (broken) throw Error("route read failed");
			return [row];
		},
		wakeRead: async (old) => old,
		lock: async (_key, fn) => fn(),
		set: async (_row, up) => {
			calls.push(up);
		},
		record: () => undefined,
	});
	await rest.update(1, true);
	broken = true;
	await rest.demand("usb");
	expect(calls).toEqual([false, true]);
});

for (const recovery of ["restart", "cool", "observed-use"] as const) {
	for (const failure of ["absent", "up-command"] as const) {
		test(`${recovery} recovers later radios after an ${failure} failure`, async () => {
			const radios = ["a", "b"].map((key) => ({
				key,
				identity: `boot/usb/${key}`,
				ifname: `wlan-${key}`,
				eligible: true,
				up: true,
			}));
			let recovering = recovery === "restart";
			let broken = true;
			let saved: IdleWifiRadio[] = [];
			const ups: string[] = [];
			const rest = new HeatWifiRest({
				load: async () => (recovery === "restart" ? radios : []),
				read: async () =>
					radios
						.filter(
							(r) =>
								!(
									recovering &&
									failure === "absent" &&
									r.key === "a" &&
									broken
								),
						)
						.map((r) => ({ ...r, eligible: !recovering })),
				wakeRead: async (old) => {
					if (old.key === "a" && broken && failure === "absent")
						throw Error("ENOENT");
					return old;
				},
				lock: async (_key, fn) => fn(),
				set: async (row, up) => {
					if (!up) return;
					if (row.key === "a" && broken && failure === "up-command")
						throw Error("link up failed");
					ups.push(row.key);
				},
				record: () => undefined,
				save: async (rows) => {
					saved = [...rows];
				},
			});
			if (!recovering) await rest.update(1, true);
			recovering = true;
			for (let tick = 0; tick < 3; tick++) {
				await expect(
					rest.update(recovery === "cool" ? 0 : 1, recovery !== "observed-use"),
				).rejects.toThrow();
				expect(ups).toEqual(["b"]);
				expect(saved.map((r) => r.key)).toEqual(["a"]);
			}
			broken = false;
			await rest.update(1, false);
			expect(ups).toEqual(["b", "a"]);
			expect(saved).toEqual([]);
		});
	}
}
