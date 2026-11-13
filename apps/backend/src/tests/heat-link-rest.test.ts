import { expect, test } from "bun:test";
import { HeatLinkRest } from "../modules/streaming/heat-link-rest";

const links = ["a", "b", "c"].map((name) => ({
	name,
	modem: true,
	healthy: true,
	headroom: 0.3,
}));
test("one spare needs two healthy peers with known 30 percent room", () => {
	const rest = new HeatLinkRest();
	expect(
		rest.update(
			true,
			links.map((l) => ({ ...l, headroom: null })),
		),
	).toBeNull();
	expect(rest.update(true, links.slice(0, 2))).toBeNull();
	expect(
		rest.update(
			true,
			links.map((l) => ({ ...l, headroom: 0.29 })),
		),
	).toBeNull();
	expect(rest.update(true, links)).toBe("a");
	expect(rest.update(true, links)).toBe("a");
	expect(
		rest.update(
			true,
			links.map((l) => ({ ...l, healthy: l.name === "a" })),
		),
	).toBeNull();
	expect(rest.update(true, links)).toBe("a");
	expect(rest.update(false, links)).toBeNull();
	expect(new HeatLinkRest().resting).toBeNull();
});

test("the return half runs on its own and returns the link when its peers fail", () => {
	const rest = new HeatLinkRest();
	expect(rest.update(true, links)).toBe("a");
	expect(rest.release(links)).toBe("a");
	expect(
		rest.release(links.map((l) => ({ ...l, healthy: l.name === "a" }))),
	).toBeNull();
	// release never starts a rest.
	expect(rest.release(links)).toBeNull();
	expect(rest.update(true, links)).toBe("a");
	expect(rest.release(links.filter((l) => l.name !== "a"))).toBeNull();
});

test("the reason a link is not resting is reported, and capacity only when it is unknown", () => {
	const rest = new HeatLinkRest();
	rest.update(
		true,
		links.map((l) => ({ ...l, headroom: null })),
	);
	expect(rest.blocked).toBe("capacity");
	rest.update(true, links.slice(0, 2));
	expect(rest.blocked).toBe("peers");
	rest.update(
		true,
		links.map((l) => ({ ...l, headroom: 0.1 })),
	);
	expect(rest.blocked).toBe("peers");
	rest.update(true, links);
	expect(rest.blocked).toBeNull();
	rest.update(false, links);
	expect(rest.blocked).toBeNull();
});
