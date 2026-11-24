import { afterEach, expect, test } from "bun:test";
import { streamingBlockingMutation } from "../modules/streaming/lifecycle-admission.ts";
import {
	ETHERNET,
	journalEntry,
	MODEMS,
	type RealisticBox,
	realisticBox,
	stableKeyOf,
} from "./fixtures/realistic-box.ts";

let box: RealisticBox | undefined;
afterEach(() => {
	box?.close();
	box = undefined;
});

const ALL = ["eth0", "wwan0", "wwan1", "wwan2"];

test("L1: Ethernet and all three modems on default profiles reach the bond", async () => {
	box = await realisticBox();
	expect(box.bonded()).toEqual(ALL);
});

test("each modem link resolves to its own stable key from udev", () => {
	const keys = MODEMS.map(stableKeyOf);
	expect(new Set(keys).size).toBe(3);
});

test("a modem that leaves and comes back under another name keeps its key", async () => {
	box = await realisticBox();
	const [first, second, third] = MODEMS;
	if (!first || !second || !third) throw new Error("fixture");
	const renamed = { ...first, ifname: "wwan5" };
	await box.scan([ETHERNET, renamed, second, third]);
	expect(box.bonded()).toEqual(["eth0", "wwan1", "wwan2", "wwan5"]);
	expect(stableKeyOf(renamed)).toBe(stableKeyOf(first));
});

test("today: a failed rollback on one modem holds every stream start", async () => {
	box = await realisticBox();
	const [first] = MODEMS;
	if (!first) throw new Error("fixture");
	await box.journal([journalEntry(first, "failed")]);
	expect(streamingBlockingMutation()?.stableKey).toBe(stableKeyOf(first));
});

test("a decommissioned modem never holds streaming", async () => {
	box = await realisticBox();
	const [first] = MODEMS;
	if (!first) throw new Error("fixture");
	await box.journal([journalEntry(first, "decommissioned")]);
	expect(streamingBlockingMutation()).toBeUndefined();
	expect(box.bonded()).toContain("eth0");
});
