import { expect, test } from "bun:test";
import { LinkFamilySelector, validateClatSnapshot } from "./link-family.ts";

const v4 = { ip: "192.0.2.1" };
const v6 = { ipv6: "2001:db8::1" };
const dual = { ...v4, ...v6 };
const receiver = { ipv4: true, ipv6: true };
test("native IPv6 needs no translator", () => {
	expect(
		new LinkFamilySelector().choose("cell0", v6, receiver, undefined, 0)?.mode,
	).toBe("ipv6");
});
test("dual stack retains native IPv4 compatibility", () => {
	expect(
		new LinkFamilySelector().choose("cell0", dual, receiver, undefined, 0)?.ip,
	).toBe(v4.ip);
});
test("AAAA-only receiver uses IPv6 even on dual stack", () => {
	expect(
		new LinkFamilySelector().choose(
			"cell0",
			dual,
			{ ipv4: false, ipv6: true },
			undefined,
			0,
		)?.mode,
	).toBe("ipv6");
});
const clat = { ip: "10.254.0.3", iface: "clat3", mode: "clat" as const };
test("A-only receiver uses CLAT on IPv6-only link", () => {
	expect(
		new LinkFamilySelector().choose(
			"cell0",
			v6,
			{ ipv4: true, ipv6: false },
			clat,
			0,
		),
	).toEqual(clat);
});
test("incompatible source is withdrawn", () => {
	expect(
		new LinkFamilySelector().choose(
			"cell0",
			v6,
			{ ipv4: true, ipv6: false },
			undefined,
			0,
		),
	).toBeUndefined();
});
test("short flap withdraws then restores same family", () => {
	const s = new LinkFamilySelector();
	s.choose("cell0", dual, receiver, undefined, 0);
	expect(s.choose("cell0", v6, receiver, undefined, 100)).toBeUndefined();
	expect(s.choose("cell0", dual, receiver, undefined, 1000)?.mode).toBe("ipv4");
});
test("persistent family loss switches once and does not switch back on recovery", () => {
	const s = new LinkFamilySelector();
	s.choose("cell0", dual, receiver, undefined, 0);
	s.choose("cell0", v6, receiver, undefined, 100);
	expect(s.choose("cell0", v6, receiver, undefined, 10100)?.mode).toBe("ipv6");
	expect(s.choose("cell0", dual, receiver, undefined, 10200)?.mode).toBe(
		"ipv6",
	);
});
test("links choose independently and reset only at a new session", () => {
	const s = new LinkFamilySelector();
	s.choose("cell0", v6, receiver, undefined, 0);
	expect(s.choose("cell1", dual, receiver, undefined, 0)?.mode).toBe("ipv4");
	expect(s.choose("cell0", dual, receiver, undefined, 0)?.mode).toBe("ipv6");
	s.reset();
	expect(s.choose("cell0", dual, receiver, undefined, 0)?.mode).toBe("ipv4");
});
const snapshot = {
	schema_version: 1,
	interface: "cell0",
	tun: "clat3",
	prefix: "64:ff9b::/96",
	ipv4: "10.254.0.3",
	state: "up",
	last_error: null,
	updated_at: 100,
};
test("CLAT admission requires live service, matching index/interface, fresh up snapshot and TUN", () => {
	expect(validateClatSnapshot(snapshot, "cell0", 3, 100, true, true)).toEqual(
		clat,
	);
	for (const patch of [
		{ schema_version: 2 },
		{ interface: "cell1" },
		{ tun: "clat4" },
		{ state: "error" },
		{ updated_at: 0 },
		{ updated_at: 200 },
		{ ipv4: "192.0.2.1" },
		{ prefix: null },
	]) {
		expect(
			validateClatSnapshot(
				{ ...snapshot, ...patch },
				"cell0",
				3,
				100,
				true,
				true,
			),
		).toBeUndefined();
	}
	expect(
		validateClatSnapshot(snapshot, "cell0", 3, 100, false, true),
	).toBeUndefined();
	expect(
		validateClatSnapshot(snapshot, "cell0", 3, 100, true, false),
	).toBeUndefined();
	expect(
		validateClatSnapshot(null, "cell0", 3, 100, true, true),
	).toBeUndefined();
});

test("native IPv6 precedes CLAT even when translation is already available", () => {
	expect(
		new LinkFamilySelector().choose("cell0", v6, receiver, clat, 0)?.mode,
	).toBe("ipv6");
});
