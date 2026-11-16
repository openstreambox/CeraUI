import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getConfig } from "../modules/config.ts";
import { initModemCapabilityEvidence } from "../modules/modems/capability-evidence.ts";
import { setModemCapabilityEvidenceReader } from "../modules/modems/capability-gates.ts";
import {
	applyFiveGPreference,
	createFiveGRollbackHandler,
	type FiveGApplyDeps,
} from "../modules/modems/five-g-apply.ts";
import {
	fiveGPreferenceToModes,
	offeredFiveGPreferences,
	readFiveGPreference,
	sameModePair,
} from "../modules/modems/five-g-preference.ts";
import type { NetworkType } from "../modules/modems/mmcli.ts";
import {
	modemIdentityTag,
	modemIdentityTagForId,
	rememberModemIdentity,
	resetModemIdentities,
} from "../modules/modems/mode-choice-identity.ts";
import {
	loadModeChoiceKey,
	MODE_CHOICE_KEY_FILE,
	resetModeChoiceKeyCache,
	setModeChoiceKeyWriter,
} from "../modules/modems/mode-choice-key.ts";
import { conditionTags } from "../modules/modems/mode-choice-memory.ts";
import {
	recordModeEvaluations,
	resetModeEvaluations,
} from "../modules/modems/mode-choice-runtime.ts";
import {
	MODE_HISTORY_CAP_PER_SOURCE,
	readModeChoice,
	recordModeChoice,
	resetModeChoiceStore,
	setModeChoiceWriteFault,
	wireModeHistory,
	writeModeChoice,
} from "../modules/modems/mode-choice-store.ts";
import { buildModemsWireMessage } from "../modules/modems/modem-status.ts";
import {
	refreshModemIdPaths,
	resetModemWireProducer,
	setModemIdPathReader,
} from "../modules/modems/modem-wire-producer.ts";
import {
	applyModemConfig,
	type ModemApplyDeps,
} from "../modules/modems/modems.ts";
import {
	getModems,
	type Modem,
	setModem,
} from "../modules/modems/modems-state.ts";
import {
	listMutationEntries,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import {
	resetNetworkModeSlot,
	tryClaimNetworkModeWrite,
} from "../modules/modems/network-mode-slot.ts";
import { resetLifecycleInterlock } from "../modules/streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../modules/streaming/recovery-barrier.ts";

const PORTS = new Map([
	["wwan0", "platform-xhci-hcd.0.auto-usb-0:1.4.1"],
	["wwan1", "platform-xhci-hcd.0.auto-usb-0:1.4.2"],
]);
const IMEI_A = "SYNTHETIC-EQUIPMENT-A";
const IMEI_B = "SYNTHETIC-EQUIPMENT-B";

const QUECTEL: NonNullable<Modem["radio_modes"]> = {
	supported: [
		{ allowed: "2g", preferred: "none" },
		{ allowed: "3g", preferred: "none" },
		{ allowed: "4g", preferred: "none" },
		{ allowed: "5g", preferred: "none" },
		{ allowed: "5g|4g", preferred: "5g" },
		{ allowed: "5g|4g", preferred: "4g" },
		{ allowed: "5g|4g|3g|2g", preferred: "5g" },
		{ allowed: "5g|4g|3g|2g", preferred: "none" },
	],
	current: { allowed: "5g|4g|3g|2g", preferred: "5g" },
};
/** A synthetic radio that lists only 4G and 5G. */
const LTE_NR_ONLY: NonNullable<Modem["radio_modes"]> = {
	supported: [
		{ allowed: "4g", preferred: "none" },
		{ allowed: "5g", preferred: "none" },
		{ allowed: "5g|4g", preferred: "5g" },
		{ allowed: "5g|4g", preferred: "4g" },
		{ allowed: "5g|4g", preferred: "none" },
	],
	current: { allowed: "5g|4g", preferred: "5g" },
};
const LTE: NetworkType = { allowed: "4g", preferred: "none" };

let journalDir = "";
const priorChoiceDir = process.env.CERALIVE_MODE_CHOICE_DIR;
let choiceRoot = "";
let choiceDir = "";

function seed(
	id: number,
	ifname: string,
	radioModes: Modem["radio_modes"],
	equipmentId: string | undefined,
): Modem {
	const modem: Modem = {
		ifname,
		name: "Synthetic modem",
		sim_network: "",
		status: {
			connection: "connected",
			network: "Synthetic",
			network_type: "5G",
			signal: 72,
			roaming: false,
		},
		network_type: {
			supported: {
				"4g": { allowed: "4g", preferred: "none" },
				"5g4g3g2g": { allowed: "5g|4g|3g|2g", preferred: "5g" },
			},
			active: "5g4g3g2g",
		},
		config: {
			conn: "00000000-synthetic",
			autoconfig: true,
			apn: "",
			username: "",
			password: "",
			roaming: false,
			network: "",
		},
		...(radioModes === undefined ? {} : { radio_modes: radioModes }),
	};
	setModem(id, modem);
	rememberModemIdentity(id, equipmentId);
	return modem;
}

/** A radio that lands on whatever it is asked for, after an optional gate. */
function device(
	catalog: NonNullable<Modem["radio_modes"]>,
	options: { gate?: Promise<void>; landsOn?: NetworkType } = {},
) {
	const writes: NetworkType[] = [];
	let current = catalog.current;
	const deps: FiveGApplyDeps = {
		setNetworkTypes: async (_id, allowed, preferred) => {
			writes.push({ allowed, preferred });
			await options.gate;
			current = options.landsOn ?? { allowed, preferred };
			return true;
		},
		readRadioModes: async () => ({
			supported: catalog.supported,
			...(current === undefined ? {} : { current }),
		}),
		broadcast: () => undefined,
	};
	return { writes, deps };
}

function settingsDeps(
	overrides: Partial<ModemApplyDeps> = {},
): ModemApplyDeps & { modeWrites: NetworkType[] } {
	const modeWrites: NetworkType[] = [];
	return {
		writeConnection: async () => true,
		readConnectionHold: async () =>
			({ held: false }) as unknown as Awaited<
				ReturnType<ModemApplyDeps["readConnectionHold"]>
			>,
		enforceAcrossProfiles: async () => 0,
		disconnect: async () => undefined,
		setNetworkTypes: async (_id, allowed, preferred) => {
			modeWrites.push({ allowed, preferred });
			return true;
		},
		autoconfigSupported: () => true,
		...overrides,
		modeWrites,
	};
}

function settingsSave(device: number, networkType: string) {
	return {
		device,
		roaming: false,
		autoconfig: true,
		apn: "",
		username: "",
		password: "",
		network: "",
		network_type: networkType,
	};
}

const row = (id: number) =>
	buildModemsWireMessage()[String(id)]?.five_g_preference;

beforeEach(async () => {
	journalDir = await mkdtemp(join(tmpdir(), "ceraui-mode-journal-"));
	choiceRoot = await mkdtemp(join(tmpdir(), "ceraui-mode-choice-"));
	choiceDir = join(choiceRoot, "mode-choice");
	setMutationJournalDeps({ dir: journalDir });
	process.env.CERALIVE_MODE_CHOICE_DIR = choiceDir;
	resetModeChoiceKeyCache();
	resetModeChoiceStore();
	resetModemIdentities();
	resetModeEvaluations();
	resetNetworkModeSlot();
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	setModemIdPathReader(() => Promise.resolve(new Map(PORTS)));
	await refreshModemIdPaths();
	setModemCapabilityEvidenceReader(() => ({
		capability: { "five-g-pref": "present" },
	}));
	getConfig().modem_capabilities = { five_g_pref: true };
});

afterEach(async () => {
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	resetMutationJournalDeps();
	initModemCapabilityEvidence();
	setModemIdPathReader(null);
	resetModemWireProducer();
	for (const id of Object.keys(getModems())) delete getModems()[Number(id)];
	delete getConfig().modem_capabilities;
	if (priorChoiceDir === undefined) delete process.env.CERALIVE_MODE_CHOICE_DIR;
	else process.env.CERALIVE_MODE_CHOICE_DIR = priorChoiceDir;
	resetModeChoiceKeyCache();
	resetModeChoiceStore();
	resetModemIdentities();
	resetModeEvaluations();
	resetNetworkModeSlot();
	await rm(journalDir, { recursive: true, force: true });
	await rm(choiceRoot, { recursive: true, force: true });
});

describe("1 · the evaluator cannot flood the history", () => {
	test("an unchanged verdict is stored once; the manual change survives; the wire carries at most ten", async () => {
		seed(0, "wwan0", QUECTEL, IMEI_A);
		const { deps } = device(QUECTEL);
		expect((await applyFiveGPreference("0", "lte-only", deps)).success).toBe(
			true,
		);
		const tag = modemIdentityTagForId(0) as string;
		const file = join(choiceDir, `${tag}.json`);
		const t0 = Date.now();
		recordModeEvaluations(t0 + 61_000);
		const afterFirst = statSync(file).mtimeMs;
		const bytesAfterFirst = statSync(file).size;
		// About four and a half hours of status polls, one a minute.
		for (let i = 2; i <= 260; i++) recordModeEvaluations(t0 + i * 61_000);

		const history = readModeChoice(tag).history;
		expect(history.filter((r) => r.source === "manual")).toHaveLength(1);
		expect(history.filter((r) => r.source === "evaluator")).toHaveLength(1);
		expect(statSync(file).mtimeMs).toBe(afterFirst);
		expect(statSync(file).size).toBe(bytesAfterFirst);
		expect(row(0)?.history?.length).toBeLessThanOrEqual(10);
	});

	test("a changed verdict is stored, and the evaluator never evicts manual records", async () => {
		seed(0, "wwan0", QUECTEL, IMEI_A);
		const tag = modemIdentityTagForId(0) as string;
		const base = {
			source: "manual" as const,
			current: "auto" as const,
			target: "lte-only" as const,
			beforeBucket: null,
			afterBucket: null,
			beforeDeliveredUpload: null,
			afterDeliveredUpload: null,
			outcome: "applied" as const,
			reasons: [],
			estimatedLinkOutSeconds: null,
		};
		const now = Date.now();
		for (let i = 0; i < 3; i++) recordModeChoice(tag, { ...base, at: now + i });
		for (let i = 0; i < 300; i++)
			recordModeChoice(tag, {
				...base,
				source: "evaluator",
				outcome: "would-not-try",
				reasons: [`synthetic-${i}`],
				at: now + 10 + i,
			});
		const history = readModeChoice(tag).history;
		expect(history.filter((r) => r.source === "manual")).toHaveLength(3);
		expect(history.filter((r) => r.source === "evaluator")).toHaveLength(
			MODE_HISTORY_CAP_PER_SOURCE,
		);
		expect(row(0)?.history).toHaveLength(10);
		expect(row(0)?.history?.at(-1)?.reasons).toEqual(["synthetic-299"]);
	});
});

describe("2 · a readback is judged by its pair, not its name", () => {
	test("a 4G+5G-only radio is not offered a second name for LTE only, and LTE only never blocks it", async () => {
		expect(offeredFiveGPreferences(LTE_NR_ONLY)).not.toContain("5g-off");
		expect(offeredFiveGPreferences(LTE_NR_ONLY)).toContain("lte-only");
		seed(0, "wwan0", LTE_NR_ONLY, IMEI_A);
		const { deps, writes } = device(LTE_NR_ONLY);
		expect(await applyFiveGPreference("0", "5g-off", deps)).toEqual({
			success: false,
			error: "not_offered",
		});
		expect(writes).toEqual([]);
		expect(await applyFiveGPreference("0", "lte-only", deps)).toMatchObject({
			success: true,
			applied: "lte-only",
		});
		expect(await listMutationEntries()).toEqual([]);
	});

	test("mmcli's own spelling of a pair confirms the pair that was written", async () => {
		expect(
			sameModePair(
				{ allowed: "4g|5g", preferred: "none" },
				{ allowed: "5g|4g", preferred: "none" },
			),
		).toBe(true);
		expect(
			sameModePair(
				{ allowed: "5g|4g", preferred: "5g" },
				{ allowed: "5g|4g", preferred: "4g" },
			),
		).toBe(false);
		seed(0, "wwan0", QUECTEL, IMEI_A);
		const { deps } = device(QUECTEL, {
			landsOn: { allowed: "2g|3g|4g|5g", preferred: "none" },
		});
		expect(await applyFiveGPreference("0", "auto", deps)).toMatchObject({
			success: true,
			applied: "auto",
		});
		expect(await listMutationEntries()).toEqual([]);
	});

	test("Automatic is every listed mode with no preference; a narrower unranked set is not Automatic", () => {
		expect(fiveGPreferenceToModes("auto", QUECTEL)).toEqual({
			allowed: "5g|4g|3g|2g",
			preferred: "none",
		});
		expect(
			readFiveGPreference({
				supported: QUECTEL.supported,
				current: { allowed: "5g|4g", preferred: "none" },
			}),
		).toBeNull();
		expect(
			readFiveGPreference({
				supported: LTE_NR_ONLY.supported,
				current: { allowed: "4g|5g", preferred: "none" },
			}),
		).toBe("auto");
	});
});

describe("3 · one mode write at a time, refused before anything is journaled", () => {
	test("a modem-settings save writing modem A makes LTE only on B refuse busy, with nothing journaled", async () => {
		seed(0, "wwan0", QUECTEL, IMEI_A);
		seed(1, "wwan1", QUECTEL, IMEI_B);
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = () => {};
		const writing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const save = applyModemConfig(
			settingsSave(1, "4g"),
			settingsDeps({
				setNetworkTypes: async () => {
					entered();
					await gate;
					return true;
				},
			}),
		);
		await writing;
		const { deps, writes } = device(QUECTEL);
		expect(await applyFiveGPreference("0", "lte-only", deps)).toEqual({
			success: false,
			refusal: "mutation_in_progress",
		});
		expect(writes).toEqual([]);
		expect(await listMutationEntries()).toEqual([]);
		release();
		expect(await save).toMatchObject({ ok: true });
	});

	test("a modem-settings save that would write a mode refuses busy, before writing anything", async () => {
		seed(0, "wwan0", QUECTEL, IMEI_A);
		const held = tryClaimNetworkModeWrite();
		let connectionWrites = 0;
		const deps = settingsDeps({
			writeConnection: async () => {
				connectionWrites++;
				return true;
			},
		});
		expect(await applyModemConfig(settingsSave(0, "4g"), deps)).toEqual({
			ok: false,
			reason: "device_busy",
		});
		expect(connectionWrites).toBe(0);
		expect(deps.modeWrites).toEqual([]);
		held?.();
	});

	test("a restore waits for a running mode write instead of failing", async () => {
		seed(0, "wwan0", QUECTEL, IMEI_A);
		const held = tryClaimNetworkModeWrite();
		const { deps, writes } = device(QUECTEL);
		const restoring = createFiveGRollbackHandler(deps).rollback(
			PORTS.get("wwan0") as string,
			{ allowed: "5g|4g|3g|2g", preferred: "5g" },
		);
		await Promise.resolve();
		expect(writes).toEqual([]);
		held?.();
		expect(await restoring).toBe("restored");
	});
});

describe("4 · the answer never says the opposite of what the modem did", () => {
	test("a save failure after a confirmed change reports success with saved: false, and nothing is blocked", async () => {
		seed(0, "wwan0", QUECTEL, IMEI_A);
		const { deps } = device(QUECTEL);
		setModeChoiceWriteFault(() => {
			throw new Error("synthetic full disk");
		});
		expect(await applyFiveGPreference("0", "lte-only", deps)).toEqual({
			success: true,
			applied: "lte-only",
			saved: false,
		});
		expect(getModems()[0]?.radio_modes?.current).toEqual(LTE);
		expect(await listMutationEntries()).toEqual([]);
		expect(row(0)?.active).toBe("lte-only");
	});

	test("an unreadable history never stops a change; the new choice starts a fresh record", async () => {
		seed(0, "wwan0", QUECTEL, IMEI_A);
		const tag = modemIdentityTagForId(0) as string;
		writeFileSync(join(choiceDir, `${tag}.json`), "{not json", { mode: 0o600 });
		expect(row(0)?.lock).toBeUndefined();
		const { deps } = device(QUECTEL);
		expect(await applyFiveGPreference("0", "lte-only", deps)).toEqual({
			success: true,
			applied: "lte-only",
			saved: true,
		});
		expect(await listMutationEntries()).toEqual([]);
		expect(row(0)?.lock).toBe("lte-only");
	});
});

describe("5 · the saved choice belongs to the modem and is reconciled on every read", () => {
	test("swapping two modems between ports keeps each one's own saved choice", async () => {
		seed(0, "wwan0", QUECTEL, IMEI_A);
		seed(1, "wwan1", QUECTEL, IMEI_B);
		expect(
			(await applyFiveGPreference("0", "lte-only", device(QUECTEL).deps))
				.success,
		).toBe(true);
		expect(row(0)?.lock).toBe("lte-only");
		expect(row(1)?.lock).toBeUndefined();

		// Unplugged and swapped: modem A is now in the second port.
		seed(0, "wwan0", QUECTEL, IMEI_B);
		seed(1, "wwan1", { ...QUECTEL, current: LTE }, IMEI_A);
		expect(row(0)?.lock).toBeUndefined();
		expect(row(1)?.lock).toBe("lte-only");
		expect(row(1)?.lock_matches).toBe(true);
	});

	test("a saved choice the modem no longer reports is shown as a mismatch, and nothing re-applies it", async () => {
		seed(0, "wwan0", QUECTEL, IMEI_A);
		const { deps, writes } = device(QUECTEL);
		expect((await applyFiveGPreference("0", "lte-only", deps)).success).toBe(
			true,
		);
		// A modem reset, or a change made outside this device, put it back.
		const modem = getModems()[0] as Modem;
		modem.radio_modes = QUECTEL;
		expect(row(0)?.lock).toBe("lte-only");
		expect(row(0)?.active).toBe("prefer-5g");
		expect(row(0)?.lock_matches).toBe(false);
		for (let i = 1; i <= 5; i++) recordModeEvaluations(Date.now() + i * 61_000);
		expect(writes).toHaveLength(1);
		expect(modem.radio_modes).toEqual(QUECTEL);
	});

	test("the modem-settings save updates the saved choice", async () => {
		seed(0, "wwan0", QUECTEL, IMEI_A);
		expect(
			(await applyFiveGPreference("0", "lte-only", device(QUECTEL).deps))
				.success,
		).toBe(true);
		const modem = getModems()[0] as Modem;
		modem.network_type.active = "4g";
		expect(
			await applyModemConfig(settingsSave(0, "5g4g3g2g"), settingsDeps()),
		).toMatchObject({ ok: true });
		expect(readModeChoice(modemIdentityTagForId(0) as string).lock).toBe(
			"prefer-5g",
		);
		expect(
			readModeChoice(modemIdentityTagForId(0) as string).history.at(-1)
				?.reasons,
		).toEqual(["via:modem-settings"]);
	});

	test("Automatic is saved but does not lock the evaluator out; LTE only does", async () => {
		seed(0, "wwan0", QUECTEL, IMEI_A);
		const tag = modemIdentityTagForId(0) as string;
		expect(
			(await applyFiveGPreference("0", "auto", device(QUECTEL).deps)).success,
		).toBe(true);
		recordModeEvaluations(Date.now() + 61_000);
		expect(readModeChoice(tag).lock).toBe("auto");
		expect(readModeChoice(tag).history.at(-1)?.reasons).not.toContain("locked");
		expect(
			(await applyFiveGPreference("0", "lte-only", device(QUECTEL).deps))
				.success,
		).toBe(true);
		recordModeEvaluations(Date.now() + 200_000);
		expect(readModeChoice(tag).history.at(-1)?.reasons).toContain("locked");
	});

	test("a modem with no equipment identifier saves nothing and says so", async () => {
		seed(0, "wwan0", QUECTEL, undefined);
		expect(
			await applyFiveGPreference("0", "lte-only", device(QUECTEL).deps),
		).toEqual({ success: true, applied: "lte-only", saved: false });
		expect(row(0)?.lock).toBeUndefined();
	});
});

describe("6 · the device-local key", () => {
	test("generated once, 0600 in a 0700 directory, and reused", () => {
		const key = loadModeChoiceKey({ create: true });
		expect(key).toHaveLength(32);
		const file = join(choiceDir, MODE_CHOICE_KEY_FILE);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(choiceDir).mode & 0o777).toBe(0o700);
		resetModeChoiceKeyCache();
		expect(loadModeChoiceKey()).toEqual(key);
		expect(new Uint8Array(readFileSync(file))).toEqual(key as Uint8Array);
	});

	test("reading never creates it; a loose or wrong-sized key is refused, never replaced", () => {
		expect(loadModeChoiceKey()).toBeUndefined();
		expect(() => readdirSync(choiceDir)).toThrow();
		loadModeChoiceKey({ create: true });
		const file = join(choiceDir, MODE_CHOICE_KEY_FILE);
		const original = readFileSync(file);
		chmodSync(file, 0o644);
		resetModeChoiceKeyCache();
		expect(loadModeChoiceKey({ create: true })).toBeUndefined();
		chmodSync(file, 0o600);
		writeFileSync(file, "short");
		resetModeChoiceKeyCache();
		expect(loadModeChoiceKey({ create: true })).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("short");
		expect(original).toHaveLength(32);
	});

	test("a group-readable directory is refused", async () => {
		const { mkdirSync } = await import("node:fs");
		mkdirSync(choiceDir, { mode: 0o755 });
		chmodSync(choiceDir, 0o755);
		expect(loadModeChoiceKey({ create: true })).toBeUndefined();
	});

	test("identity and condition tags use it: no IMEI anywhere, and another device's key gives other tags", async () => {
		seed(0, "wwan0", QUECTEL, IMEI_A);
		expect(
			(await applyFiveGPreference("0", "lte-only", device(QUECTEL).deps)).saved,
		).toBe(true);
		recordModeEvaluations(Date.now() + 61_000);
		const key = loadModeChoiceKey() as Uint8Array;
		const tag = modemIdentityTagForId(0) as string;
		expect(tag).toBe(modemIdentityTag(key, IMEI_A) as string);
		expect(modemIdentityTag(new Uint8Array(32).fill(1), IMEI_A)).not.toBe(tag);

		const wire = JSON.stringify(buildModemsWireMessage());
		const keyHex = Buffer.from(key).toString("hex");
		for (const name of readdirSync(choiceDir)) {
			if (name === MODE_CHOICE_KEY_FILE) continue;
			const text = readFileSync(join(choiceDir, name), "utf8");
			expect(text).not.toContain(IMEI_A);
			expect(text).not.toContain(keyHex);
			expect(statSync(join(choiceDir, name)).mode & 0o777).toBe(0o600);
		}
		expect(wire).not.toContain(IMEI_A);
		expect(wire).not.toContain(tag);
		expect(wire).not.toContain(keyHex);

		const conditions = {
			model: "synthetic",
			firmware: "v1",
			usbSpeed: "usb2" as const,
			network: "test",
			homeNetwork: "test",
			layer: "LTE" as const,
			bands: ["LTE1"],
			cell: "synthetic-cell",
			rsrp: -100,
			neighbours: [],
		};
		const here = conditionTags(key, conditions);
		expect(conditionTags(new Uint8Array(32).fill(1), conditions)).not.toEqual(
			here,
		);
	});
});

test("history expires on cached and cold reads without another write", () => {
	seed(0, "wwan0", QUECTEL, IMEI_A);
	const tag = modemIdentityTagForId(0) as string;
	const record = {
		source: "manual" as const,
		current: "auto" as const,
		target: "lte-only" as const,
		beforeBucket: null,
		afterBucket: null,
		beforeDeliveredUpload: null,
		afterDeliveredUpload: null,
		outcome: "applied" as const,
		reasons: [],
		estimatedLinkOutSeconds: null,
		at: Date.now() - 31 * 86400000,
	};
	const state = {
		version: 1 as const,
		lock: "lte-only" as const,
		history: [record],
	};
	writeModeChoice(tag, state);
	expect(readModeChoice(tag).history).toEqual([]);
	expect(readModeChoice(tag).lock).toBe("lte-only");
	resetModeChoiceStore();
	expect(readModeChoice(tag).history).toEqual([]);
	expect(wireModeHistory(state)).toEqual([]);
});
test("an interrupted unpublished key does not prevent first creation", () => {
	mkdirSync(choiceDir, { mode: 0o700 });
	writeFileSync(join(choiceDir, "local-key.interrupted.tmp"), "", {
		mode: 0o600,
	});
	expect(loadModeChoiceKey({ create: true })).toHaveLength(32);
});

test("a short first key write leaves no published key and saving can retry", () => {
	setModeChoiceKeyWriter(() => 0);
	try {
		expect(loadModeChoiceKey({ create: true })).toBeUndefined();
		expect(readdirSync(choiceDir)).not.toContain(MODE_CHOICE_KEY_FILE);
	} finally {
		setModeChoiceKeyWriter();
	}
	expect(loadModeChoiceKey({ create: true })).toHaveLength(32);
});

test("history records the same trial window passed to the evaluator", () => {
	seed(0, "wwan0", QUECTEL, IMEI_A);
	const tag = modemIdentityTagForId(0) as string;
	recordModeEvaluations(Date.now());
	expect(readModeChoice(tag).history.at(-1)?.window).toBe("covered");
});

test("wire history caps a larger input and removes real local bucket tags", () => {
	const now = Date.now();
	const history = Array.from({ length: 20 }, (_, i) => ({
		at: now + i,
		source: "manual" as const,
		current: "auto" as const,
		target: "lte-only" as const,
		beforeBucket: "a".repeat(64),
		afterBucket: "b".repeat(64),
		beforeDeliveredUpload: null,
		afterDeliveredUpload: null,
		outcome: "applied" as const,
		reasons: [],
		estimatedLinkOutSeconds: null,
	}));
	const wire = wireModeHistory({ version: 1, history });
	expect(wire).toHaveLength(10);
	expect(wire[0]?.at).toBe(now + 10);
	expect(
		wire.every((r) => r.beforeBucket === null && r.afterBucket === null),
	).toBe(true);
	expect(history[0]?.beforeBucket).toBe("a".repeat(64));
});
