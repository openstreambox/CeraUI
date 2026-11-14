import { expect, test } from "bun:test";
import snapshot from "./fixtures/clat-status-v1.json";
import { LinkFamilySelector, validateClatSnapshot } from "./link-family.ts";
import { describeLinkPath } from "./link-path-status.ts";

const receiver = { ipv4: true, ipv6: true };
const v6 = { ipv6: "2001:db8::3" };
test("selected paths describe address selection, independently of receiver delivery", () => {
	for (const mode of ["ipv4", "ipv6", "clat"] as const) {
		expect(
			describeLinkPath({ ...v6, ip: "192.0.2.3" }, receiver, {
				ip: "192.0.2.3",
				iface: "cell0",
				mode,
			}),
		).toBe(mode);
	}
});
test("only the exact IPv6-only / IPv4 receiver mismatch names translation", () => {
	expect(describeLinkPath(v6, { ipv4: true, ipv6: false }, undefined)).toBe(
		"receiver-ipv4-only",
	);
	expect(describeLinkPath({}, receiver, undefined)).toBe("no-source");
	expect(
		describeLinkPath(
			{ ip: "192.0.2.3" },
			{ ipv4: false, ipv6: true },
			undefined,
		),
	).toBe("incompatible");
	expect(describeLinkPath(v6, receiver, undefined)).toBe("waiting");
	expect(describeLinkPath(v6, undefined, undefined)).toBe("unknown");
});
test("schema v1 CLAT fixture becomes a path only while fresh and live", () => {
	const clat = validateClatSnapshot(snapshot, "cell0", 3, 100, true, true);
	const selector = new LinkFamilySelector();
	const a = { ipv4: true, ipv6: false };
	expect(
		describeLinkPath(v6, a, selector.choose("cell0", v6, a, clat, 0)),
	).toBe("clat");
	const stale = validateClatSnapshot(snapshot, "cell0", 3, 131, true, true);
	expect(
		describeLinkPath(v6, a, selector.choose("cell0", v6, a, stale, 100)),
	).toBe("receiver-ipv4-only");
	for (const [service, tun] of [
		[false, true],
		[true, false],
	]) {
		expect(
			validateClatSnapshot(
				snapshot,
				"cell0",
				3,
				100,
				Boolean(service),
				Boolean(tun),
			),
		).toBeUndefined();
	}
});
test("family-loss grace never presents the withdrawn path as selected", () => {
	const s = new LinkFamilySelector();
	s.choose("cell0", { ...v6, ip: "192.0.2.3" }, receiver, undefined, 0);
	expect(
		describeLinkPath(
			v6,
			receiver,
			s.choose("cell0", v6, receiver, undefined, 100),
		),
	).toBe("waiting");
	expect(
		describeLinkPath(
			v6,
			receiver,
			s.choose("cell0", v6, receiver, undefined, 10100),
		),
	).toBe("ipv6");
});

test("complete snapshots retract removed links and cannot be mutated by readers", async () => {
	const { setLinkPaths, getLinkPaths } = await import("./link-path-status.ts");
	setLinkPaths({ cell0: "clat", cell1: "ipv6" });
	const old = getLinkPaths();
	old.cell0 = "ipv4";
	expect(getLinkPaths().cell0).toBe("clat");
	setLinkPaths({ cell1: "waiting" });
	expect(getLinkPaths()).toEqual({ cell1: "waiting" });
	setLinkPaths({});
	expect(getLinkPaths()).toEqual({});
});

test("a live translator held by family-loss grace is waiting, not unavailable", () => {
	const receiver = { ipv4: true, ipv6: false };
	const s = new LinkFamilySelector();
	const clat = validateClatSnapshot(snapshot, "cell0", 3, 100, true, true);
	s.choose("cell0", { ip: "192.0.2.3" }, receiver, undefined, 0);
	const path = s.choose("cell0", v6, receiver, clat, 100);
	expect(describeLinkPath(v6, receiver, path, clat)).toBe("waiting");
});
