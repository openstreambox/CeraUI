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
