import { expect, test } from "bun:test";
import { initialHeat } from "../modules/streaming/heat-ladder.ts";
import {
	type LinkBoxEvidence,
	linkBoxHeatTick,
	planLinkBoxHeat,
} from "../modules/streaming/heat-link-box.ts";
import { CarryingTracker } from "../modules/system/carrying.ts";

const evidence = (): LinkBoxEvidence => ({
	at: 1000,
	carrying: "streaming",
	encoder: false,
	mainLink: "wan-a",
	phone: "phone",
	links: ["wan-a", "wan-b", "wan-c"].map((id) => ({
		id,
		healthy: true,
		headroom: 0.5,
		recovering: false,
	})),
	clients: [
		{ id: "phone", management: false },
		{ id: "guest", management: false },
		{ id: "admin", management: true },
	],
});
const plan = (stage: number, e = evidence(), keep = false) =>
	planLinkBoxHeat(stage, true, keep, e, 1000);
test("warm uses only spare USB rest", () =>
	expect(plan(1)).toMatchObject({ usb: true, lend: null, pause: [] }));
test("hot lends one fewer without selecting the main path", () =>
	expect(plan(2)).toMatchObject({ usb: true, lend: "wan-b", pause: [] }));
test("critical pauses only other clients, after lending", () =>
	expect(plan(3)).toMatchObject({ lend: "wan-b", pause: ["guest"] }));
test("unknown main link withholds both visible steps", () =>
	expect(plan(3, { ...evidence(), mainLink: null })).toMatchObject({
		lend: null,
		pause: [],
	}));
test("two healthy peers with capacity are required", () => {
	const e = evidence();
	e.links = e.links.map((link, index) =>
		index === 0 ? { ...link, headroom: null } : link,
	);
	expect(plan(3, e)).toMatchObject({ lend: null, pause: [] });
});
test("recovery never lends a link", () => {
	const e = evidence();
	for (const l of e.links) l.recovering = true;
	expect(plan(3, e).lend).toBeNull();
});
test("unknown phone identity withholds client pause", () =>
	expect(plan(3, { ...evidence(), phone: null }).pause).toEqual([]));
test("stale and unknown evidence withhold restrictions", () => {
	expect(plan(3, { ...evidence(), at: -5000 }).lend).toBeNull();
	expect(plan(3, { ...evidence(), carrying: "unknown" }).usb).toBe(false);
});
test("Keep quality removes visible restrictions, leaves unused USB eligible", () =>
	expect(plan(3, evidence(), true)).toMatchObject({
		usb: true,
		lend: null,
		pause: [],
	}));
test("encoder and idle use their existing policies", () => {
	expect(plan(3, { ...evidence(), encoder: true }).lend).toBeNull();
	expect(plan(3, { ...evidence(), carrying: "idle" }).lend).toBeNull();
});
test("unknown temperature takes no new step", () =>
	expect(planLinkBoxHeat(3, false, false, evidence(), 1000)).toMatchObject({
		usb: false,
		lend: null,
		pause: [],
	}));
test("duplicate identities cannot establish safe peers or clients", () => {
	const e = evidence();
	e.links = e.links.map((link, index) =>
		index === 2 ? { ...link, id: "wan-a" } : link,
	);
	expect(plan(3, e).lend).toBeNull();
});

test("carrying without an encoder reaches hot without a bitrate ceiling", async () => {
	const { linkBoxHeatTick } = await import(
		"../modules/streaming/heat-link-box.ts"
	);
	const { initialHeat } = await import("../modules/streaming/heat-ladder.ts");
	let heat = initialHeat();
	let result: ReturnType<typeof linkBoxHeatTick> | undefined;
	for (let now = 0; now <= 12000; now += 1000) {
		result = linkBoxHeatTick(heat, 76, now, "streaming", false);
		heat = result.heat;
	}
	expect(result).toMatchObject({
		owned: true,
		key: "notifications.linkBoxHeatWaiting",
		plan: { usb: true, lend: null, pause: [] },
	});
	expect(heat.stage).toBe(2);
	expect(linkBoxHeatTick(heat, 76, 13000, "idle", false).owned).toBe(false);
	expect(linkBoxHeatTick(heat, 76, 13000, "streaming", true).owned).toBe(false);
});

test("startup unknown vetoes new USB rest throughout the fixed window", () => {
	const tracker = new CarryingTracker();
	tracker.start(0);
	let heat = initialHeat();
	for (let now = 0; now < 120_000; now += 1000) {
		tracker.session("rtmp-ingest", false, now);
		const carrying = tracker.read(now);
		expect(carrying).toBe("unknown");
		const tick = linkBoxHeatTick(heat, 76, now, carrying, false);
		heat = tick.heat;
		expect(tick.owned).toBe(true);
		expect(tick.plan).toEqual({ usb: false, lend: null, pause: [] });
	}
	expect(heat.stage).toBeGreaterThanOrEqual(2);
	expect(tracker.read(119_999)).toBe("unknown");
	expect(tracker.read(120_000)).toBe("idle");
	expect(
		linkBoxHeatTick(heat, 76, 120_000, tracker.read(120_000), false).owned,
	).toBe(false);
});
