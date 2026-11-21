import { describe, expect, test } from "bun:test";
import {
	decideModeTrial,
	memoryAge,
	passiveTrialHint,
	type TrialInputs,
} from "../modules/modems/mode-choice";

const good = (): TrialInputs => ({
	now: 10_000_000,
	currentMode: "auto",
	window: "covered",
	capable: true,
	locked: false,
	privacy: false,
	brb: false,
	countdown: false,
	hold: false,
	recovery: false,
	handover: false,
	handoverAge: 61,
	publicAge: 121,
	endIn: 120,
	movingKmh: 0,
	changesPerMinute: 0,
	bucketStableSeconds: 61,
	bucket: "synthetic-bucket",
	memory: "gone",
	hint: "new-bucket",
	dataAvailable: true,
	littleToGain: false,
	otherAction: false,
	viewerAffected: false,
	streamAge: 3600,
	trialAges: [],
	boxOutSeconds: 0,
	streamTrialAges: [],
	candidateShare: 2,
	steadySeconds: 121,
	latencyBudget: 1000,
	others: [
		{
			ready: true,
			load: 2,
			cleanPeak: 7,
			peakAge: 20,
			rttP95: 200,
			nakRising: false,
		},
	],
});

describe("log-only mode decision", () => {
	test("session-style high transmit power shortlists LTE, does not write", () => {
		const input = good();
		input.hint = "high-tx-power";
		expect(decideModeTrial(input)).toMatchObject({
			wouldTry: true,
			hint: "high-tx-power",
			automaticWrite: false,
		});
	});
	for (const field of [
		"locked",
		"privacy",
		"brb",
		"countdown",
		"hold",
		"recovery",
		"handover",
		"otherAction",
		"viewerAffected",
		"littleToGain",
	] as const) {
		test(`never with ${field}`, () => {
			const i = good();
			i[field] = true;
			expect(decideModeTrial(i).wouldTry).toBe(false);
		});
	}
	for (const field of [
		"candidateShare",
		"others",
		"bucket",
		"capable",
		"dataAvailable",
		"hold",
		"brb",
		"privacy",
		"movingKmh",
		"changesPerMinute",
		"steadySeconds",
	] as const) {
		test(`unavailable ${field} fails closed`, () => {
			const i = good();
			delete i[field];
			expect(decideModeTrial(i).wouldTry).toBe(false);
		});
	}
	for (const [field, value] of Object.entries({
		publicAge: 119,
		endIn: 59,
		bucketStableSeconds: 59,
		movingKmh: 26,
		changesPerMinute: 2,
		handoverAge: 59,
		steadySeconds: 119,
		boxOutSeconds: 126,
	})) {
		test(`threshold ${field}`, () => {
			expect(decideModeTrial({ ...good(), [field]: value }).wouldTry).toBe(
				false,
			);
		});
	}
	test("one link and unknown room", () => {
		expect(decideModeTrial({ ...good(), others: [] }).wouldTry).toBe(false);
		expect(
			decideModeTrial({ ...good(), others: [{ ready: true, load: 2 }] })
				.reasons,
		).toContain("unknown-room");
	});
	test("one other needs twice share, several need 1.5 times", () => {
		const i = good();
		const link = i.others?.[0];
		if (!link) throw new Error("missing fixture");
		link.cleanPeak = 5;
		expect(decideModeTrial(i).wouldTry).toBe(false);
		i.others?.push({
			ready: true,
			load: 1,
			cleanPeak: 2,
			peakAge: 0,
			rttP95: 10,
			nakRising: false,
		});
		expect(decideModeTrial(i).wouldTry).toBe(true);
	});
	test("unhealthy and stale peaks", () => {
		for (const patch of [
			{ rttP95: 700 },
			{ nakRising: true },
			{ peakAge: 1801 },
			{ ready: false },
		]) {
			const i = good();
			const link = i.others?.[0];
			if (!link) throw new Error("missing fixture");
			Object.assign(link, patch);
			expect(decideModeTrial(i).wouldTry).toBe(false);
		}
	});
	test("per modem, per hour and per stream budgets", () => {
		for (const patch of [
			{ trialAges: [899] },
			{ trialAges: [1000, 2000] },
			{ streamTrialAges: [1, 2, 3, 4, 5, 6] },
			{ streamAge: 7201, streamTrialAges: [1, 2] },
		])
			expect(decideModeTrial({ ...good(), ...patch }).wouldTry).toBe(false);
	});
	test("fresh memory suppresses, hint only shortlists", () => {
		expect(decideModeTrial({ ...good(), memory: "fresh" }).wouldTry).toBe(
			false,
		);
		expect(decideModeTrial({ ...good(), memory: "hint" }).wouldTry).toBe(true);
	});
	test("30 minute / 7 day / 30 day memory; leaving bucket and invalidation", () => {
		expect(memoryAge(1799, true, false)).toBe("fresh");
		expect(memoryAge(1800, true, false)).toBe("hint");
		expect(memoryAge(10, false, false)).toBe("hint");
		expect(memoryAge(604800, true, false)).toBe("history");
		expect(memoryAge(2592000, true, false)).toBe("gone");
		expect(memoryAge(1, true, true)).toBe("gone");
	});
	test("idle needs permission and no hint means no trial", () => {
		expect(
			decideModeTrial({ ...good(), window: "idle", idlePermission: false })
				.wouldTry,
		).toBe(false);
		expect(decideModeTrial({ ...good(), hint: undefined }).wouldTry).toBe(
			false,
		);
	});
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	conditionTags,
	lookupModeMemory,
	type RadioConditions,
} from "../modules/modems/mode-choice-memory";
import {
	readModeChoice,
	recordModeChoice,
	resetModeChoiceStore,
} from "../modules/modems/mode-choice-store";

const TAG = "a".repeat(64);

test("memory keys include conditions, never raw cell; other cell is only a hint", () => {
	const c: RadioConditions = {
		model: "synthetic",
		firmware: "v1",
		usbSpeed: "usb2",
		network: "test",
		homeNetwork: "test",
		layer: "NSA",
		bands: ["LTE1", "NR1"],
		cell: "synthetic-cell",
		rsrp: -105,
		txDbm: 22,
		timingAdvance: 4,
		neighbours: [],
	};
	const key = new Uint8Array(32).fill(7);
	const tags = conditionTags(key, c);
	expect(JSON.stringify(tags)).not.toContain(c.cell);
	expect(conditionTags(new Uint8Array(32).fill(8), c)).not.toEqual(tags);
	for (const changed of [
		{ usbSpeed: "usb3" as const },
		{ rsrp: -85 },
		{ timingAdvance: 14 },
		{ txDbm: 1 },
		{ firmware: "v2" },
		{ neighbours: [{ band: "LTE2", sending: true }] },
	])
		expect(conditionTags(key, { ...c, ...changed }).exact).not.toBe(tags.exact);
	const entries = [
		{
			...tags,
			at: 1000,
			mode: "lte-only" as const,
			invalidated: false,
			disturbed: false,
		},
	];
	expect(lookupModeMemory(entries, tags, 2000, 0).state).toBe("fresh");
	expect(lookupModeMemory(entries, tags, 2000, 1500).state).toBe("hint");
	expect(
		lookupModeMemory(
			entries,
			conditionTags(key, { ...c, cell: "another-cell" }),
			2000,
			0,
		).state,
	).toBe("hint");
	expect(lookupModeMemory(entries, tags, 2000, 0, true).state).toBe("gone");
	expect(
		lookupModeMemory(
			[
				{
					...entries[0],
					...tags,
					at: 1000,
					mode: "lte-only",
					invalidated: false,
					disturbed: true,
				},
			],
			tags,
			2000,
			0,
		).state,
	).toBe("gone");
});

test("manual trials and locks survive a new read in a private bounded record", () => {
	const dir = mkdtempSync(join(tmpdir(), "mode-choice-"));
	const prior = process.env.CERALIVE_MODE_CHOICE_DIR;
	process.env.CERALIVE_MODE_CHOICE_DIR = dir;
	try {
		recordModeChoice(
			TAG,
			{
				at: Date.now(),
				source: "manual",
				current: "auto",
				target: "lte-only",
				beforeBucket: null,
				afterBucket: null,
				beforeDeliveredUpload: null,
				afterDeliveredUpload: null,
				outcome: "applied",
				reasons: ["unavailable:delivered-upload"],
				estimatedLinkOutSeconds: 55,
			},
			{ lock: "lte-only" },
		);
		resetModeChoiceStore();
		expect(readModeChoice(TAG).lock).toBe("lte-only");
		expect(readModeChoice(TAG).history[0]?.afterDeliveredUpload).toBeNull();
	} finally {
		resetModeChoiceStore();
		if (prior === undefined) delete process.env.CERALIVE_MODE_CHOICE_DIR;
		else process.env.CERALIVE_MODE_CHOICE_DIR = prior;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("nonfinite and negative measurements never grant permission", () => {
	for (const value of [NaN, Infinity, -1]) {
		expect(decideModeTrial({ ...good(), candidateShare: value }).wouldTry).toBe(
			false,
		);
		expect(decideModeTrial({ ...good(), boxOutSeconds: value }).wouldTry).toBe(
			false,
		);
		expect(decideModeTrial({ ...good(), trialAges: [value] }).wouldTry).toBe(
			false,
		);
		expect(
			decideModeTrial({
				...good(),
				others: [
					{
						ready: true,
						load: 2,
						cleanPeak: value,
						peakAge: 0,
						rttP95: 20,
						nakRising: false,
					},
				],
			}).wouldTry,
		).toBe(false);
	}
	expect(memoryAge(NaN, true, false)).toBe("gone");
});

test("passive radio readings only shortlist an alternative", () => {
	const hint = passiveTrialHint({ nrSinr: -9, txDbm: 22 });
	expect(hint).toBe("negative-nr-sinr");
	expect(decideModeTrial({ ...good(), hint })).toMatchObject({
		wouldTry: true,
		target: "lte-only",
		automaticWrite: false,
	});
	expect(decideModeTrial({ ...good(), currentMode: undefined }).wouldTry).toBe(
		false,
	);
	expect(passiveTrialHint({})).toBeUndefined();
	expect(passiveTrialHint({ txDbm: 23 })).toBe("high-tx-power");
	expect(passiveTrialHint({ storedAlternative: true })).toBe(
		"stored-alternative",
	);
});
