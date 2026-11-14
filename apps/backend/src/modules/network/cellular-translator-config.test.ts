import { expect, test } from "bun:test";
import { planCellularRoutes } from "./cellular-route-plan.ts";
import { cellularTranslatorConfig } from "./cellular-translator-config.ts";

const candidate = planCellularRoutes({
	owner: "a".repeat(64),
	epoch: "one",
	slot: 1,
	iface: "wwan0",
	mtu: 1428,
	ipv6: "2001:db8:1::2",
	ipv6PrefixLength: 64,
	ipv6Gateway: "fe80::1",
	nat64: "2001:db8:64::/96",
});
if (!candidate) throw new Error("Missing translator plan");
const plan = candidate;
test("translator configuration cannot map another slot or pass through directives", () => {
	expect(cellularTranslatorConfig(plan)).toContain(
		`map ${plan.source} ${plan.mapped}\n`,
	);
	for (const changed of [
		{ source: "198.18.255.2" },
		{ tun: "cclat2" },
		{ table: 250002 },
		{ mapped: "2001:db8::2%lo" },
		{ nat64: "2001:db8::/96\nuser nobody" },
		{ translated: false },
	])
		expect(() => cellularTranslatorConfig({ ...plan, ...changed })).toThrow();
});
