import { expect, test } from "bun:test";
import { type CellularIpIO, CellularIpState } from "./cellular-ip-state.ts";
import { planCellularRoutes } from "./cellular-route-plan.ts";

const candidate = planCellularRoutes({
	owner: "a".repeat(64),
	epoch: "one",
	slot: 1,
	iface: "wwan0",
	mtu: 1428,
	ipv4: "192.0.2.2",
});
test("kernel-detached selectors permit exact inverse inspection but never readiness or malformed markers", async () => {
	const f = fixture(),
		rule = {
			priority: 60,
			src: "192.0.2.2",
			iif: "lo",
			oif: "wwan0",
			oif_detached: null,
			action: "7",
			protocol: "129",
		};
	f.rules([rule]);
	expect(await f.state.inspect(terminal)).toBe("foreign");
	expect(await f.state.inspect(terminal, true)).toBe("owned");
	f.rules([{ ...rule, oif_detached: true }]);
	expect(await f.state.inspect(terminal, true)).toBe("foreign");
	f.rules([{ ...rule, oif_detached: null, iif_detached: null }]);
	expect(await f.state.inspect(terminal, true)).toBe("foreign");
	expect(f.writes).toEqual([]);
});
if (!candidate) throw new Error("Missing route plan");
const plan = candidate;
const terminal = plan.effects[0];
if (!terminal) throw new Error("Missing terminal effect");
function fixture() {
	let rows: unknown[] = [],
		rules: unknown[] = [];
	const writes: string[][] = [];
	const io: CellularIpIO = {
		current: async () => true,
		read: async (argv) => JSON.stringify(argv.includes("route") ? rows : rules),
		write: async (argv) => {
			writes.push(argv);
		},
	};
	return {
		state: new CellularIpState(plan, io),
		writes,
		routes: (value: unknown[]) => {
			rows = value;
		},
		rules: (value: unknown[]) => {
			rules = value;
		},
	};
}
test("exact numeric kernel output is recognized; unknown tuple attributes and duplicate rules veto removal", async () => {
	const f = fixture(),
		rule = {
			priority: 60,
			src: "192.0.2.2",
			iif: "lo",
			oif: "wwan0",
			action: "7",
			protocol: "129",
		};
	expect(await f.state.inspect(terminal)).toBe("absent");
	f.rules([{ priority: 0, src: "all", table: "255" }, rule]);
	expect(await f.state.inspect(terminal)).toBe("owned");
	f.rules([rule, rule]);
	expect(await f.state.remove(terminal)).toBe(false);
	f.rules([{ ...rule, suppress_prefixlength: 0 }]);
	expect(await f.state.remove(terminal)).toBe(false);
	expect(f.writes).toEqual([]);
	f.rules([rule]);
	f.routes([
		{ table: "250001", dst: "203.0.113.77", type: "prohibit", protocol: "4" },
	]);
	expect(await f.state.remove(terminal)).toBe(false);
	expect(f.writes).toEqual([]);
});
test("foreign main routes are outside the private inventory; malformed owned rows never become absence", async () => {
	const f = fixture();
	f.routes([{ dst: "default", dev: "lan0", flags: [] }]);
	expect(await f.state.inspect(terminal)).toBe("absent");
	f.routes([
		{
			table: "250001",
			dst: "default",
			dev: "wwan0",
			protocol: "129",
			scope: "253",
			prefsrc: "192.0.2.2",
			flags: [],
			metrics: [{ mtu: 1428 }],
		},
	]);
	const route = plan.effects.find((effect) => effect.kind === "route");
	if (!route) throw new Error("Missing native route");
	expect(await f.state.inspect(route)).toBe("owned");
	f.routes([
		{
			table: "250001",
			dst: "default",
			dev: "wwan0",
			protocol: "129",
			scope: "253",
			prefsrc: "192.0.2.2",
			flags: [],
			metrics: [{ mtu: 1428, lock: true }],
		},
	]);
	expect(await f.state.remove(route)).toBe(false);
	expect(f.writes).toEqual([]);
});
