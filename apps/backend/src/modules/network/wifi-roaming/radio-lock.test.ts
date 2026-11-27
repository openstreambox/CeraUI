import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "../../../tests/helpers/wifi-registry.ts";
import {
	type SeedRadio,
	seedWifiRadios,
} from "../../../tests/helpers/wifi-verified-radios.ts";
import {
	wifiAdapterLockKeyForIfname,
	withWifiAdapterLock,
} from "../../wifi/wifi-adapter-lock.ts";
import {
	addWifiInterface,
	removeWifiInterface,
} from "../../wifi/wifi-connections.ts";
import type { WifiInterface } from "../../wifi/wifi-interfaces.ts";
import { createSearchNm } from "./nm-port.ts";
import {
	admitRadio,
	admittedRadio,
	confirmAdmittedRadio,
	withRadioLock,
} from "./radio-lock.ts";

const MAC = "02:00:00:00:c0:02";
const radio = (over: Partial<SeedRadio> = {}): SeedRadio => ({
	ifname: "wlan2",
	mac: MAC,
	ifindex: 31,
	phy: 3,
	...over,
});

let inherited: ReturnType<typeof isolateWifiRegistry>;
let seed: Awaited<ReturnType<typeof seedWifiRadios>>;

beforeEach(async () => {
	inherited = isolateWifiRegistry();
	seed = await seedWifiRadios();
	await seed.publish([radio()]);
});

afterEach(async () => {
	await seed.restore();
	restoreWifiRegistry(inherited);
});

describe("coordinator actions under the adapter lock", () => {
	test("a verified radio runs the action", async () => {
		expect(await withRadioLock("wlan2", async () => 7)).toEqual({
			ok: true,
			value: 7,
		});
	});

	test("a radio whose owner lock a hotspot change holds is refused without waiting", async () => {
		const owner = wifiAdapterLockKeyForIfname("wlan2") as string;
		let inner: unknown;
		const outer = await withWifiAdapterLock(owner, async () => {
			inner = await withRadioLock("wlan2", async () => "scanned");
			return true;
		});
		expect(outer.success).toBe(true);
		expect(inner).toEqual({ ok: false });
	});

	test("an unregistered radio is refused", async () => {
		let ran = false;
		expect(
			await withRadioLock("wlan9", async () => {
				ran = true;
			}),
		).toEqual({ ok: false });
		expect(ran).toBe(false);
	});

	test("a Limited radio (no permanent MAC) is refused", async () => {
		// A new radio whose phy reports no permanent MAC. (The same lifetime
		// would keep its earlier verified identity.)
		await seed.publish([radio({ mac: undefined, ifindex: 41, phy: 4 })]);
		expect(admitRadio("wlan2")).toBeUndefined();
		let ran = false;
		expect(
			await withRadioLock("wlan2", async () => {
				ran = true;
			}),
		).toEqual({ ok: false });
		expect(ran).toBe(false);
	});

	test("a radio whose publication a discovery pass invalidated is refused", async () => {
		seed.invalidate();
		expect(await withRadioLock("wlan2", async () => 1)).toEqual({ ok: false });
		await seed.republish();
		expect(await withRadioLock("wlan2", async () => 1)).toEqual({
			ok: true,
			value: 1,
		});
	});

	test("two registry rows under one name are refused", async () => {
		addWifiInterface("limited:99:9", {
			id: 99,
			ifname: "wlan2",
			conn: null,
			hw: "Fixture",
			available: new Map(),
			saved: {},
			savedAll: {},
		} as WifiInterface);
		try {
			expect(admitRadio("wlan2")).toBeUndefined();
		} finally {
			removeWifiInterface("limited:99:9");
		}
		expect(admitRadio("wlan2")).toBeDefined();
	});

	test("a radio replaced under the same name before the lock is refused", async () => {
		// Sysfs already shows a new lifetime (a replug); no discovery pass yet.
		seed.sysfs([radio({ ifindex: 32 })]);
		let ran = false;
		expect(
			await withRadioLock("wlan2", async () => {
				ran = true;
			}),
		).toEqual({ ok: false });
		expect(ran).toBe(false);
	});
});

describe("the admission travels with the action", () => {
	test("the action sees its own radio's admission, nothing outside it", async () => {
		expect(admittedRadio("wlan2")).toBeUndefined();
		expect(await confirmAdmittedRadio("wlan2")).toBe(false);
		const seen = await withRadioLock("wlan2", async () => ({
			mac: admittedRadio("wlan2")?.permanentMac,
			other: admittedRadio("wlan3"),
			confirmed: await confirmAdmittedRadio("wlan2"),
		}));
		expect(seen).toEqual({
			ok: true,
			value: { mac: MAC, other: undefined, confirmed: true },
		});
		expect(admittedRadio("wlan2")).toBeUndefined();
	});

	test("a radio replaced under the same name during the action fails the next confirmation", async () => {
		const seen = await withRadioLock("wlan2", async () => {
			const before = await confirmAdmittedRadio("wlan2");
			seed.sysfs([radio({ ifindex: 32 })]);
			return { before, after: await confirmAdmittedRadio("wlan2") };
		});
		expect(seen).toEqual({ ok: true, value: { before: true, after: false } });
	});
});

describe("the NetworkManager port under the lock", () => {
	const SOURCE = "11111111-1111-4111-8111-111111111111";
	const CLONE = "33333333-3333-4333-8333-333333333333";
	const RANDOMIZED = "06:11:22:33:44:55";

	/** A saved profile bound to `bound`; records every command. */
	function fakeNm(bound: string, onListing: () => void = () => {}) {
		const calls: string[] = [];
		const run = async (bin: string, args: string[]) => {
			const line = `${bin} ${args.join(" ")}`;
			calls.push(line);
			if (line === "nmcli -t -f NAME,UUID,TYPE connection show")
				return `venue:${SOURCE}:802-11-wireless\n`;
			if (line.startsWith("nmcli -g 802-11-wireless.ssid"))
				return `venue\n${bound.toUpperCase().replace(/:/g, "\\:")}\n\n`;
			if (line === "nmcli -t -f NAME,UUID connection show") {
				onListing();
				return "";
			}
			if (line.startsWith("nmcli connection clone"))
				return `venue (${SOURCE}) cloned as ceraui-search-wlan2 (${CLONE}).`;
			if (line === "nmcli -t -f DEVICE,UUID connection show --active")
				return "";
			return "";
		};
		return { run, calls };
	}
	const ups = (calls: string[]) =>
		calls.filter((c) => c.includes("connection up"));

	test("a join uses the profile bound to the admitted permanent MAC", async () => {
		const f = fakeNm(MAC);
		const nm = createSearchNm({ run: f.run });
		const joined = await withRadioLock("wlan2", () =>
			nm.join("wlan2", "venue", "aa:00:00:00:00:02"),
		);
		expect(joined).toEqual({ ok: true, value: { activation: CLONE } });
		expect(ups(f.calls)).toHaveLength(1);
	});

	test("a profile bound to another MAC (say the randomized one) is not this radio's", async () => {
		const f = fakeNm(RANDOMIZED);
		const nm = createSearchNm({ run: f.run });
		const joined = await withRadioLock("wlan2", () =>
			nm.join("wlan2", "venue", "aa:00:00:00:00:02"),
		);
		expect(joined).toEqual({ ok: true, value: undefined });
		expect(f.calls.some((c) => c.includes("connection clone"))).toBe(false);
	});

	test("outside the lock a join finds no profile and writes nothing", async () => {
		const f = fakeNm(MAC);
		const nm = createSearchNm({ run: f.run });
		expect(await nm.join("wlan2", "venue", "aa:00:00:00:00:02")).toBe(
			undefined,
		);
		expect(f.calls.some((c) => c.includes("connection clone"))).toBe(false);
		// Candidate ranking outside the lock still sees the radio's own SSIDs.
		expect([...(await nm.savedSsids("wlan2"))]).toEqual(["venue"]);
	});

	test("a replug under the same name before activation removes the clone and never activates", async () => {
		const f = fakeNm(MAC, () => seed.sysfs([radio({ ifindex: 32 })]));
		const nm = createSearchNm({ run: f.run });
		const joined = await withRadioLock("wlan2", () =>
			nm.join("wlan2", "venue", "aa:00:00:00:00:02"),
		);
		expect(joined).toEqual({ ok: true, value: "refused" });
		expect(ups(f.calls)).toEqual([]);
		expect(f.calls.at(-1)).toBe(`nmcli connection delete ${CLONE}`);
	});

	test("a scan of a radio replaced during the action is not sent", async () => {
		const f = fakeNm(MAC);
		const nm = createSearchNm({ run: f.run });
		const scanned = await withRadioLock("wlan2", async () => {
			seed.sysfs([radio({ ifindex: 32 })]);
			return nm.scan("wlan2");
		});
		expect(scanned).toEqual({ ok: true, value: undefined });
		expect(f.calls.some((c) => c.includes("--rescan"))).toBe(false);
	});
});
