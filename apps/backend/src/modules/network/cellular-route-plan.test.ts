import { expect, test } from "bun:test";
import { cellularIpArgv, planCellularRoutes } from "./cellular-route-plan.ts";

const input = {
	owner: "a".repeat(64),
	epoch: "usb-one",
	slot: 1,
	iface: "wwan0",
	mtu: 1428,
};
test("native and dual stack use native IPv4; a request family cannot create a translator", () => {
	const plan = planCellularRoutes({
		...input,
		ipv4: "192.0.2.2",
		ipv6: "2001:db8:1::2",
		ipv6PrefixLength: 64,
		ipv6Gateway: "fe80::1",
		nat64: "2001:db8:64::/96",
	});
	expect(plan?.translated).toBe(false);
	expect(plan?.device).toBe("wwan0");
	expect(
		plan?.effects.every((effect) => !effect.selector.includes("main")),
	).toBe(true);
	expect(
		plan?.effects
			.filter((effect) => effect.kind === "rule")
			.every((effect) => effect.selector.includes("iif")),
	).toBe(true);
});
test("two translations have independent sources, mapped IPv6, TUNs and private tables", () => {
	const grant = {
		ipv6: "2001:db8:1::2",
		ipv6PrefixLength: 64,
		ipv6Gateway: "fe80::1",
		nat64: "2001:db8:64::/96",
	};
	const a = planCellularRoutes({ ...input, ...grant }),
		b = planCellularRoutes({
			...input,
			...grant,
			slot: 2,
			owner: "b".repeat(64),
			iface: "wwan1",
		});
	expect(a?.translated).toBe(true);
	expect(a?.source).not.toBe(b?.source);
	expect(a?.mapped).not.toBe(b?.mapped);
	expect(a?.table).not.toBe(b?.table);
	const source = a?.mapped;
	expect(
		planCellularRoutes({ ...input, ...grant, epoch: "usb-return" })?.mapped,
	).not.toBe(source);
	expect(a?.effects.slice(0, 4).every((effect) => effect.terminal)).toBe(true);
	const lookup4 = a?.effects.find(
		(effect) =>
			effect.kind === "rule" && effect.family === 4 && !effect.terminal,
	);
	expect(lookup4?.selector).not.toContain("oif"); // RPF has no output selector.
	expect(
		a?.effects
			.filter((effect) => effect.kind === "route")
			.every(
				(effect) => effect.selector.slice(0, 2).join(" ") === "table 250001",
			),
	).toBe(true);
});
test("missing gateway, /128-only allocation and malformed grants fail closed", () => {
	expect(planCellularRoutes(input)).toBeUndefined();
	expect(
		planCellularRoutes({
			...input,
			ipv6: "2001:db8::2",
			ipv6PrefixLength: 128,
			ipv6Gateway: "fe80::1",
			nat64: "64:ff9b::/96",
		}),
	).toBeUndefined();
	expect(() => planCellularRoutes({ ...input, ipv4: "127.0.0.1" })).toThrow();
});
test("a minimum IPv6 link keeps its TUN at 1280 while its IPv4 route uses 1260", () => {
	const plan = planCellularRoutes({
		...input,
		mtu: 1280,
		ipv6: "2001:db8::2",
		ipv6PrefixLength: 64,
		ipv6Gateway: "fe80::1",
		nat64: "2001:db8:64::/96",
	});
	expect(plan?.linkMtu).toBe(1280);
	expect(plan?.mtu).toBe(1260);
	expect(
		plan?.effects.find((row) => row.kind === "route" && row.family === 4)
			?.selector,
	).toContain("1260");
});
test("route grants reject zone-bearing source, gateway and prefix rather than silently stripping a different device", () => {
	const grant = {
		ipv6: "2001:db8::2",
		ipv6PrefixLength: 64,
		ipv6Gateway: "fe80::1",
		nat64: "64:ff9b::/96",
	};
	for (const patch of [
		{ ipv6: "2001:db8::2%wwan1" },
		{ ipv6Gateway: "fe80::1%wwan1" },
		{ nat64: "64:ff9b::%wwan1/96" },
		{ ipv6Gateway: "::1" },
		{ ipv6Gateway: "ff02::1" },
	])
		expect(
			planCellularRoutes({ ...input, ...grant, ...patch }),
		).toBeUndefined();
	const canonical = planCellularRoutes({
		...input,
		...grant,
		ipv6Gateway: "FE80:0:0:0:0:0:0:1",
	});
	const gateway = canonical?.effects.find(
		(row) => row.kind === "route" && row.family === 6,
	);
	if (!gateway) throw new Error("Missing IPv6 route");
	expect(gateway.selector).toContain("fe80::1");
});
test("all lookups precede all unreachable guards, including duplicate carrier IPv4 grants", () => {
	const priorities: { value: number; terminal: boolean }[] = [];
	for (const slot of [1, 32]) {
		const plan = planCellularRoutes({
			...input,
			slot,
			iface: `wwan${slot}`,
			ipv4: "192.0.2.2",
		});
		for (const effect of plan?.effects ?? []) {
			const add = cellularIpArgv(effect, "add"),
				del = cellularIpArgv(effect, "del");
			expect(add.slice(3)).toEqual(del.slice(3));
			if (effect.kind === "rule")
				priorities.push({
					value: Number(effect.selector[1]),
					terminal: effect.terminal,
				});
		}
	}
	expect(
		Math.max(...priorities.filter((p) => !p.terminal).map((p) => p.value)),
	).toBeLessThan(
		Math.min(...priorities.filter((p) => p.terminal).map((p) => p.value)),
	);
});

test("native guards scope overlapping IPv4 and IPv6 sources to the modem device", () => {
	const plan = planCellularRoutes({
		...input,
		ipv4: "192.0.2.2",
		ipv6: "2001:db8:1::2",
		ipv6Gateway: "fe80::1",
	});
	const guards = plan?.effects.filter((effect) => effect.terminal);
	expect(guards).toHaveLength(2);
	for (const guard of guards ?? [])
		expect(
			guard.selector.slice(
				guard.selector.indexOf("oif"),
				guard.selector.indexOf("oif") + 2,
			),
		).toEqual(["oif", "wwan0"]);
});

test("native IPv4 keeps its legal sub-1280 link MTU while translated grants require IPv6's floor", () => {
	const native = planCellularRoutes({ ...input, ipv4: "192.0.2.2", mtu: 576 });
	expect(native?.linkMtu).toBe(576);
	expect(native?.mtu).toBe(576);
	expect(() =>
		planCellularRoutes({ ...input, ipv4: "192.0.2.2", mtu: 575 }),
	).toThrow();
	expect(() => planCellularRoutes({ ...input, mtu: 1279 })).toThrow();
});
