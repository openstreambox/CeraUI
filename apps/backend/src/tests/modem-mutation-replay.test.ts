/**
 * Crash-point replay, and the admission barrier that gates it.
 *
 * Every test here starts from a journal ON DISK in one state — the state a
 * `kill -9` at that instant would have left — and asserts the replay table's
 * action actually happened, plus that autostart stayed blocked until replay
 * finished. Both halves matter: an action without the barrier means a boot
 * autostart raced the recovery it depends on, and a barrier without the action
 * means a device that never recovers.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsbEnumerator } from "@ceralive/modem-control";

import * as modemControl from "@ceralive/modem-control";
import {
	MODEM_MUTATION_JOURNAL_VERSION,
	type ModemMutationEntry,
	type ModemMutationState,
} from "@ceraui/rpc/schemas";

import * as spawnPolicy from "../helpers/spawn-policy.ts";
import { getConfig } from "../modules/config.ts";
import {
	runModemStatusPoll,
	setModemPresenceDepsForTest,
} from "../modules/modems/modem-update-loop.ts";
import { rebaselineMutation } from "../modules/modems/mutation-acknowledge.ts";
import {
	PRESENCE_UNKNOWN,
	reconcileReturnedMutationBlocks,
	refreshMutationBlocks,
	resetMutationBlockDeps,
	setMutationBlockDeps,
} from "../modules/modems/mutation-blocks.ts";
import {
	commitMutationEntry,
	defaultMutationJournalFs,
	listMutationEntries,
	readMutationEntry,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { withJournaledModemMutation } from "../modules/modems/mutation-lease.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import {
	captureModemState,
	captureModemUnitLinkId,
	clearMutationRollbacks,
	registerMutationRollback,
	resetMutationCaptureDeps,
	setMutationCaptureDeps,
} from "../modules/modems/mutation-rollback.ts";
import {
	mintLinkId,
	usbSerialDigest,
} from "../modules/modems/physical-identity.ts";
import {
	modemPciSysfs,
	routerUsbSysfs,
} from "../modules/modems/router-subnet-recovery-device.ts";
import {
	getMutationBlocks,
	heldModemMutations,
	resetLifecycleInterlock,
	streamingBlockingMutation,
	tryAcquireModemJournalKey,
	tryAcquireModemMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	awaitRecoveryBarrier,
	beginRecoveryBarrier,
	completeRecoveryBarrier,
	isRecoveryPending,
	resetRecoveryBarrier,
} from "../modules/streaming/recovery-barrier.ts";

const KEY = "platform-xhci-hcd.0.auto-usb-0:1.4.1";
const CONTROLLER = "/devices/platform/xhci-hcd.0.auto/usb1";
const USB_ROOT = `P: ${CONTROLLER}\nE: DEVTYPE=usb_device\n`;
const PRE_STATE = {
	vidPid: "2c7c:0801",
	model: "RM520N-GL",
	firmwareRevision: "RM520NGLAAR01A07M4G",
	mode: "qmi",
	ifname: "wwan0",
};

let dir: string;

function present(): Readonly<Record<string, unknown>> {
	return { ...PRE_STATE };
}

function moved(): Readonly<Record<string, unknown>> {
	return { ...PRE_STATE, mode: "mbim" };
}

// The composition the classifier reads a mode OUT of — a `qmi_wwan`-bound
// vendor-class interface is QMI; a CDC/MBIM control interface is MBIM.
const COMPOSITIONS: Readonly<Record<string, ReadonlyArray<unknown>>> = {
	qmi: [
		{
			interfaceClass: 0xff,
			interfaceSubClass: 0xff,
			interfaceProtocol: 0xff,
			driver: "qmi_wwan",
		},
	],
	mbim: [
		{
			interfaceClass: 0x02,
			interfaceSubClass: 0x0e,
			interfaceProtocol: 0x00,
			driver: "cdc_mbim",
		},
	],
};

function seed(state: ModemMutationState): ModemMutationEntry {
	return {
		version: MODEM_MUTATION_JOURNAL_VERSION,
		stableKey: KEY,
		kind: "usb-mode",
		state,
		attemptId: "attempt-crash",
		startedAt: 1_000,
		updatedAt: 1_000,
		preState: PRE_STATE,
		history: [{ state, at: 1_000 }],
	};
}

/** Point the whole subsystem at a real temp journal with a scripted device view. */
function useDevice(
	current: Readonly<Record<string, unknown>> | undefined,
): void {
	setMutationCaptureDeps({
		enumerate: () =>
			Promise.resolve(
				current === undefined
					? []
					: [
							{
								vendorId: "2c7c",
								productId: "0801",
								model: String(current.model ?? ""),
								firmwareRevision: String(current.firmwareRevision ?? ""),
								ifname: String(current.ifname ?? ""),
								bDeviceClass: 0,
								physicalUid: KEY,
								interfaces: COMPOSITIONS[String(current.mode ?? "qmi")] ?? [],
							} as never,
						],
			),
	});
	setMutationBlockDeps({
		confirmPresent: async (key) => current !== undefined && key === KEY,
		listEntries: () => listMutationEntries(),
		presentStableKeys: () =>
			Promise.resolve(
				current === undefined ? new Set<string>() : new Set([KEY]),
			),
	});
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ceraui-mutation-replay-"));
	setMutationJournalDeps({
		fs: defaultMutationJournalFs,
		dir,
		now: () => 2_000,
	});
	clearMutationRollbacks();
	resetLifecycleInterlock();
	resetRecoveryBarrier();
});

afterEach(async () => {
	resetMutationJournalDeps();
	resetMutationCaptureDeps();
	resetMutationBlockDeps();
	clearMutationRollbacks();
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	await rm(dir, { recursive: true, force: true });
});

function useUdevDevice(serial: string, rawSerial?: string): void {
	const udev = [
		"P: /devices/platform/test/usb1/1-4",
		"E: DEVTYPE=usb_device",
		"E: ID_VENDOR_ID=2c7c",
		"E: ID_MODEL_ID=0801",
		`E: ID_MODEL=${PRE_STATE.model}`,
		`E: ID_REVISION=${PRE_STATE.firmwareRevision}`,
		`E: ID_PATH=${KEY}`,
		`E: ID_SERIAL_SHORT=${serial}`,
		"E: DEVNUM=004",
		"E: ID_USB_INTERFACES=:ff0000:",
		"",
		"P: /devices/platform/test/usb1/1-4/1-4:1.0",
		"E: DEVTYPE=usb_interface",
		"E: DRIVER=qmi_wwan",
	].join("\n");
	useDevice(present());
	setMutationCaptureDeps({
		...createUsbEnumerator({ readUdevDatabase: async () => udev }),
		readSerial: async () => rawSerial,
		// The same USB lifetime the record describes.
		readDevnum: async () => "4",
	});
}

test("the journal captures a unit and replay does not verify a different unit on its port", async () => {
	useUdevDevice("fixture-original-5b2");
	const failed = await withJournaledModemMutation(
		KEY,
		"usb-mode",
		PRE_STATE,
		async () => ({
			confirmed: false,
			value: undefined,
		}),
	);
	expect(failed.ok).toBe(true);
	const entry = await readMutationEntry(KEY);
	expect(entry?.unitLinkId).toMatch(/^lnk_[0-9a-f]{16}$/);
	if (entry === undefined)
		throw new Error("fixture mutation was not journaled");
	expect(JSON.stringify(entry)).not.toContain("fixture-original-5b2");
	await commitMutationEntry({ ...entry, state: "executing" });
	useUdevDevice("fixture-replacement-a72");
	const summary = await initMutationRecovery();
	expect(summary.rolledBack).toBe(0);
	expect((await readMutationEntry(KEY))?.state).toBe(
		"device-absent-quarantine",
	);
	expect(getMutationBlocks()).toEqual([
		expect.objectContaining({ unitLinkId: entry.unitLinkId }),
	]);
});

test.each(["fixture ABC123", "fixture_ABC123"])(
	"a remembered shared digest for %s prevents capture and unit verification",
	async (remembered) => {
		useUdevDevice("fixture_ABC123", "fixture ABC123\n");
		const previous = getConfig().usb_serial_shared;
		const unit = mintLinkId("usb-serial:2c7c:fixture_ABC123");
		try {
			getConfig().usb_serial_shared = [];
			expect(await captureModemUnitLinkId(KEY)).toBe(unit);
			expect(await captureModemState(KEY, undefined, unit)).toBeDefined();
			getConfig().usb_serial_shared = [usbSerialDigest(`2c7c:${remembered}`)];
			expect(await captureModemUnitLinkId(KEY)).toBeUndefined();
			expect(await captureModemState(KEY, undefined, unit)).toBeUndefined();
		} finally {
			getConfig().usb_serial_shared = previous;
		}
	},
);

test("literal underscores cannot verify a singleton against historical raw digests", async () => {
	useUdevDevice("fixture_ABC123", "fixture_ABC123\n");
	const previous = getConfig().usb_serial_shared;
	try {
		getConfig().usb_serial_shared = [usbSerialDigest("2c7c:fixture ABC123")];
		const unit = mintLinkId("usb-serial:2c7c:fixture_ABC123");
		expect(await captureModemUnitLinkId(KEY)).toBeUndefined();
		expect(await captureModemState(KEY, undefined, unit)).toBeUndefined();
		expect(await captureModemState(KEY)).toBeDefined();
	} finally {
		getConfig().usb_serial_shared = previous;
	}
});

test("the production journal reader rejects BOM bytes before trusting the udev property", async () => {
	await writeFile(join(dir, "serial"), "\uFEFFfixture_ABC123\n");
	// The read is bound to the enumerated lifetime, so only the BOM refuses it.
	await writeFile(join(dir, "devnum"), "4\n");
	setMutationCaptureDeps({
		enumerate: async () => [
			{
				vendorId: "2c7c",
				productId: "0801",
				physicalUid: KEY,
				sysfsPath: dir,
				udevProperties: { ID_SERIAL_SHORT: "fixture_ABC123", DEVNUM: "4" },
				interfaces: [],
				bDeviceClass: 0,
			},
		],
	});
	const unit = mintLinkId("usb-serial:2c7c:fixture_ABC123");
	expect(await captureModemUnitLinkId(KEY)).toBeUndefined();
	expect(await captureModemState(KEY, undefined, unit)).toBeUndefined();
	// Control: the same bound read without the BOM is that unit.
	await writeFile(join(dir, "serial"), "fixture_ABC123\n");
	expect(await captureModemUnitLinkId(KEY)).toBe(unit);
});

test("a different vendor's legacy digest and a canonical digest do not prevent replay", async () => {
	useUdevDevice("RM520_A1", "RM520 A1");
	const previous = getConfig().usb_serial_shared;
	const unit = mintLinkId("usb-serial:2c7c:RM520_A1");
	try {
		getConfig().usb_serial_shared = [
			`v1:1199:${usbSerialDigest("1199:old device")}`,
			`v2:2c7c:${usbSerialDigest("2c7c:OTHER_SERIAL")}`,
		];
		expect(await captureModemUnitLinkId(KEY)).toBe(unit);
		expect(await captureModemState(KEY, undefined, unit)).toBeDefined();
		getConfig().usb_serial_shared = [
			`v1:2c7c:${usbSerialDigest("2c7c:OTHER LEGACY")}`,
		];
		expect(await captureModemState(KEY, undefined, unit)).toBeUndefined();
	} finally {
		getConfig().usb_serial_shared = previous;
	}
});

test("unavailable raw evidence cannot establish a unit against ambiguous older digests", async () => {
	useUdevDevice("fixture_ABC123");
	const previous = getConfig().usb_serial_shared;
	try {
		getConfig().usb_serial_shared = [usbSerialDigest("2c7c:fixture ABC123")];
		expect(await captureModemUnitLinkId(KEY)).toBeUndefined();
	} finally {
		getConfig().usb_serial_shared = previous;
	}
});

test.each(["fixture other", "\tfixture ABC123\n"])(
	"contradictory or invalid sysfs evidence cannot capture or verify a reported unit",
	async (raw) => {
		useUdevDevice("fixture_ABC123", raw);
		const unit = mintLinkId("usb-serial:2c7c:fixture_ABC123");
		expect(await captureModemUnitLinkId(KEY)).toBeUndefined();
		expect(await captureModemState(KEY, undefined, unit)).toBeUndefined();
	},
);

test("capture and recovery reject canonical collisions on distinct ports", async () => {
	setMutationCaptureDeps({
		enumerate: async () =>
			[KEY, KEY.replace(/1\.4\.1$/, "1.4.2")].map((physicalUid, i) => ({
				vendorId: "2c7c",
				productId: "0801",
				physicalUid,
				serialNumber: i === 0 ? "fixture ABC123" : "fixture_ABC123",
				interfaces: [],
				bDeviceClass: 0,
			})),
	});
	const unit = mintLinkId("usb-serial:2c7c:fixture_ABC123");
	expect(await captureModemUnitLinkId(KEY)).toBeUndefined();
	expect(await captureModemState(KEY, undefined, unit)).toBeUndefined();
});

describe("crash-point replay — one test per journal state", () => {
	test("armed + the device never moved ⇒ rolled back and pruned", async () => {
		await commitMutationEntry(seed("armed"));
		useDevice(present());
		const summary = await initMutationRecovery();
		expect(summary.rolledBack).toBe(1);
		expect(await readdir(dir)).toEqual([]);
		expect(streamingBlockingMutation()).toBeUndefined();
	});

	test("executing + the device DID move ⇒ the rollback handler runs", async () => {
		let restoredTo: unknown;
		registerMutationRollback("usb-mode", {
			rollback: (_key, pre) => {
				restoredTo = pre.mode;
				return Promise.resolve("restored");
			},
		});
		await commitMutationEntry(seed("executing"));
		useDevice(moved());
		const summary = await initMutationRecovery();
		expect(restoredTo).toBe("qmi");
		expect(summary.rolledBack).toBe(1);
		expect(await readdir(dir)).toEqual([]);
	});

	test("executing + a rollback that FAILS ⇒ blocked, fail-closed", async () => {
		registerMutationRollback("usb-mode", {
			rollback: () => Promise.resolve("failed"),
		});
		await commitMutationEntry(seed("executing"));
		useDevice(moved());
		const summary = await initMutationRecovery();
		expect(summary.blocked).toBe(1);
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
		expect(streamingBlockingMutation()?.stableKey).toBe(KEY);
	});

	test("executing + NO rollback handler ⇒ blocked, never a silent success", async () => {
		await commitMutationEntry(seed("executing"));
		useDevice(moved());
		await initMutationRecovery();
		const entry = await readMutationEntry(KEY);
		expect(entry?.state).toBe("failed");
		expect(entry?.detail).toContain("no rollback is available");
	});

	test("completed ⇒ pruned", async () => {
		await commitMutationEntry(seed("completed"));
		useDevice(present());
		const summary = await initMutationRecovery();
		expect(summary.pruned).toBe(1);
		expect(await readdir(dir)).toEqual([]);
	});

	test("failed ⇒ remains blocked awaiting acknowledgement", async () => {
		await commitMutationEntry(seed("failed"));
		useDevice(present());
		const summary = await initMutationRecovery();
		expect(summary.blocked).toBe(1);
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
		expect(streamingBlockingMutation()?.stableKey).toBe(KEY);
	});

	test("acknowledged ⇒ the archive is RESUMED (crash between ack and archive)", async () => {
		await commitMutationEntry({
			...seed("acknowledged"),
			acknowledgedMode: "force-rebaseline",
		});
		useDevice(present());
		await initMutationRecovery();
		expect(await readdir(dir)).toEqual([]);
		expect(getMutationBlocks()).toEqual([]);
	});

	test("armed + the device is ABSENT ⇒ quarantined, entry retained", async () => {
		await commitMutationEntry(seed("armed"));
		useDevice(undefined);
		const readDb = spyOn(spawnPolicy, "spawnWithTimeout").mockResolvedValue({
			exitCode: 0,
			stdout: USB_ROOT,
			stderr: "",
		});
		const names = spyOn(routerUsbSysfs, "names").mockReturnValue(["usb1"]);
		const root = spyOn(routerUsbSysfs, "rootPath").mockReturnValue(
			`/sys${CONTROLLER}`,
		);
		const summary = await initMutationRecovery().finally(() => {
			readDb.mockRestore();
			names.mockRestore();
			root.mockRestore();
		});
		expect(summary.quarantined).toBe(1);
		expect((await readMutationEntry(KEY))?.state).toBe(
			"device-absent-quarantine",
		);
		// Still holding streaming: the device may come back, and until it does its
		// fail-closed handling has to stay armed.
		expect(streamingBlockingMutation()?.stableKey).toBe(KEY);
	});

	test("quarantine + the device RETURNED ⇒ back to failed", async () => {
		await commitMutationEntry(seed("device-absent-quarantine"));
		useDevice(moved());
		await initMutationRecovery();
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
	});

	for (const [state, target] of [
		["device-absent-quarantine", "failed"],
		["decommissioned", "recommission-pending"],
	] as const) {
		test(`a modem returning after boot leaves ${state} on a retained poll`, async () => {
			useDevice(undefined);
			await commitMutationEntry(seed(state));
			await initMutationRecovery();
			expect(isRecoveryPending()).toBe(false);
			expect((await readMutationEntry(KEY))?.state).toBe(state);
			useDevice({ ...present(), ifname: "wwan7" });
			// The USB evidence is available before MM has registered a row.
			setModemPresenceDepsForTest({ listModems: async () => [] });
			try {
				await runModemStatusPoll();
				expect((await readMutationEntry(KEY))?.state).toBe(target);
				expect(isRecoveryPending()).toBe(false);
				expect(tryAcquireModemMutation(KEY).admitted).toBe(false);
			} finally {
				setModemPresenceDepsForTest(null);
			}
		});
	}

	test("return reconciliation waits for the exact slot and its journal owner", async () => {
		useDevice(undefined);
		await commitMutationEntry(seed("device-absent-quarantine"));
		await initMutationRecovery();
		setModemPresenceDepsForTest({ listModems: async () => [] });
		try {
			for (const evidence of [PRESENCE_UNKNOWN, new Set(["other-slot"])]) {
				setMutationBlockDeps({ presentStableKeys: async () => evidence });
				await runModemStatusPoll();
				expect((await readMutationEntry(KEY))?.state).toBe(
					"device-absent-quarantine",
				);
			}
			useDevice(present());
			const held = tryAcquireModemJournalKey(KEY);
			if (!held) throw new Error("expected free journal key");
			try {
				await runModemStatusPoll();
				expect((await readMutationEntry(KEY))?.state).toBe(
					"device-absent-quarantine",
				);
				expect(isRecoveryPending()).toBe(false);
			} finally {
				held.release();
			}
			await runModemStatusPoll();
			expect((await readMutationEntry(KEY))?.state).toBe("failed");
		} finally {
			setModemPresenceDepsForTest(null);
		}
	});

	test("return reconciliation requires the journaled unit at the original port", async () => {
		useDevice(undefined);
		const unitLinkId = mintLinkId("usb-serial:2c7c:fixture-original-5b2");
		await commitMutationEntry({
			...seed("device-absent-quarantine"),
			unitLinkId,
		});
		await initMutationRecovery();

		setMutationBlockDeps({
			presentStableKeys: async () => new Set([KEY]),
			confirmPresent: async () => true,
			readUnitLinkId: async () => {
				throw new Error("USB read unavailable");
			},
		});
		await reconcileReturnedMutationBlocks();
		expect((await readMutationEntry(KEY))?.state).toBe(
			"device-absent-quarantine",
		);
		expect(isRecoveryPending()).toBe(false);

		useUdevDevice("fixture-replacement-38a");
		await reconcileReturnedMutationBlocks();
		expect((await readMutationEntry(KEY))?.state).toBe(
			"device-absent-quarantine",
		);
		expect(getMutationBlocks()).toContainEqual(
			expect.objectContaining({ unitLinkId }),
		);

		useUdevDevice("fixture-original-5b2");
		await reconcileReturnedMutationBlocks();
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
		expect(getMutationBlocks()).toContainEqual(
			expect.objectContaining({ unitLinkId }),
		);
	});

	test("the retained poll offers rebaseline for a replacement on a decommissioned port", async () => {
		useDevice(undefined);
		const unitLinkId = mintLinkId("usb-serial:2c7c:fixture-original-5b2");
		await commitMutationEntry({ ...seed("decommissioned"), unitLinkId });
		await initMutationRecovery();
		expect((await readMutationEntry(KEY))?.state).toBe("decommissioned");

		useUdevDevice("fixture-replacement-38a");
		await reconcileReturnedMutationBlocks();
		expect((await readMutationEntry(KEY))?.state).toBe("recommission-pending");
		expect(getMutationBlocks()).toContainEqual(
			expect.objectContaining({ stableKey: KEY, unitLinkId }),
		);
		expect(await rebaselineMutation(KEY)).toMatchObject({ success: true });
	});

	test("one census screens three retained slots, then a targeted read under each positive key rejects a reused path", async () => {
		const keys = [KEY, "usb:b", "usb:c"];
		useDevice(undefined);
		for (const stableKey of keys)
			await commitMutationEntry({
				...seed("device-absent-quarantine"),
				stableKey,
			});
		await initMutationRecovery();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let scans = 0;
		const targeted: string[] = [];
		setMutationBlockDeps({
			presentStableKeys: async (paths) => {
				scans++;
				expect(heldModemMutations()).toEqual([]);
				paths?.set(KEY, "port-a");
				paths?.set("usb:b", "reused-port");
				started.resolve();
				await release.promise;
				return new Set([KEY, "usb:b"]);
			},
			confirmPresent: async (key, path) => {
				expect(heldModemMutations()).toEqual([key]);
				targeted.push(key);
				return path === "port-a" && key === KEY;
			},
		});
		const run = reconcileReturnedMutationBlocks();
		try {
			await started.promise;
			expect(reconcileReturnedMutationBlocks()).toBe(run);
			expect(heldModemMutations()).toEqual([]);
		} finally {
			release.resolve();
			await run;
		}
		expect(scans).toBe(1);
		expect(targeted.sort()).toEqual([KEY, "usb:b"].sort());
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
		for (const key of ["usb:b", "usb:c"])
			expect((await readMutationEntry(key))?.state).toBe(
				"device-absent-quarantine",
			);
		expect(isRecoveryPending()).toBe(false);
	});

	test("quarantine + still absent ⇒ unchanged", async () => {
		await commitMutationEntry(seed("device-absent-quarantine"));
		useDevice(undefined);
		await initMutationRecovery();
		expect((await readMutationEntry(KEY))?.state).toBe(
			"device-absent-quarantine",
		);
	});

	test("decommissioned + absent ⇒ unchanged, and streaming stays FREE", async () => {
		await commitMutationEntry(seed("decommissioned"));
		useDevice(undefined);
		await initMutationRecovery();
		expect((await readMutationEntry(KEY))?.state).toBe("decommissioned");
		expect(streamingBlockingMutation()).toBeUndefined();
		expect(tryAcquireModemMutation(KEY)).toEqual({
			admitted: false,
			refusal: "device_decommissioned",
		});
	});

	test("decommissioned + a device PRESENT ⇒ recommission-pending", async () => {
		await commitMutationEntry(seed("decommissioned"));
		useDevice(present());
		await initMutationRecovery();
		expect((await readMutationEntry(KEY))?.state).toBe("recommission-pending");
		expect(tryAcquireModemMutation(KEY)).toEqual({
			admitted: false,
			refusal: "rebaseline_required",
		});
		// A destroyed modem must never strand the remaining links.
		expect(streamingBlockingMutation()).toBeUndefined();
	});

	test("a replacement at a decommissioned port can be rebaselined after boot", async () => {
		const unitLinkId = mintLinkId("usb-serial:2c7c:fixture-original-5b2");
		await commitMutationEntry({ ...seed("decommissioned"), unitLinkId });
		useUdevDevice("fixture-replacement-38a");

		await initMutationRecovery();
		expect((await readMutationEntry(KEY))?.state).toBe("recommission-pending");
		expect(getMutationBlocks()).toContainEqual(
			expect.objectContaining({ stableKey: KEY, unitLinkId }),
		);
		expect(await rebaselineMutation(KEY)).toMatchObject({ success: true });
	});

	test("a REPLACEMENT modem in the same port is treated identically", async () => {
		await commitMutationEntry(seed("decommissioned"));
		// Same port, different unit: the port-keyed identity cannot tell them
		// apart, which is exactly why adopting either silently is refused.
		useDevice({ ...PRE_STATE, model: "SIM7600G-H", firmwareRevision: "LE11" });
		await initMutationRecovery();
		expect((await readMutationEntry(KEY))?.state).toBe("recommission-pending");
	});

	test("recommission-pending ⇒ remains awaiting the operator's rebaseline", async () => {
		await commitMutationEntry(seed("recommission-pending"));
		useDevice(present());
		await initMutationRecovery();
		expect((await readMutationEntry(KEY))?.state).toBe("recommission-pending");
	});
});

describe("the replay barrier", () => {
	test("replay raises the barrier and lowers it on EVERY exit", async () => {
		await commitMutationEntry(seed("failed"));
		useDevice(present());
		expect(isRecoveryPending()).toBe(false);
		const run = initMutationRecovery();
		expect(isRecoveryPending()).toBe(true);
		await run;
		expect(isRecoveryPending()).toBe(false);
	});

	test("a mutation is refused with recovery_pending while replay runs", () => {
		beginRecoveryBarrier();
		expect(tryAcquireModemMutation(KEY)).toEqual({
			admitted: false,
			refusal: "recovery_pending",
		});
		completeRecoveryBarrier();
		expect(tryAcquireModemMutation(KEY).admitted).toBe(true);
	});

	test("awaiting the barrier resolves only once replay completes", async () => {
		beginRecoveryBarrier();
		let resolved = false;
		void awaitRecoveryBarrier().then(() => {
			resolved = true;
		});
		await Promise.resolve();
		expect(resolved).toBe(false);
		completeRecoveryBarrier();
		await awaitRecoveryBarrier();
		expect(resolved).toBe(true);
	});

	test("with no replay running the barrier is already lowered", async () => {
		await awaitRecoveryBarrier();
		expect(isRecoveryPending()).toBe(false);
	});
});

describe("presence that could not be READ is not presence that is ABSENT", () => {
	for (const pci of ["empty", "occupied", "unreadable"] as const) {
		test(`replay only quarantines a PCI modem with a confirmed empty address (${pci})`, async () => {
			const address = "0000:01:00.0";
			const entry = { ...seed("armed"), stableKey: `pci-${address}` };
			await commitMutationEntry(entry);
			useDevice(undefined);
			const reader = spyOn(spawnPolicy, "spawnWithTimeout").mockResolvedValue({
				exitCode: 0,
				stdout: USB_ROOT,
				stderr: "",
			});
			const inventory = spyOn(modemPciSysfs, "addresses").mockImplementation(
				() => {
					if (pci === "unreadable")
						throw Object.assign(new Error("PCI inventory missing"), {
							code: "ENOENT",
						});
					return pci === "occupied" ? [address] : [];
				},
			);
			try {
				const summary = await initMutationRecovery();
				const empty = pci === "empty";
				expect(summary.quarantined).toBe(empty ? 1 : 0);
				expect(summary.unreadable).toBe(empty ? 0 : 1);
				expect((await readMutationEntry(entry.stableKey))?.state).toBe(
					empty ? "device-absent-quarantine" : "armed",
				);
				expect(isRecoveryPending()).toBe(!empty);
			} finally {
				reader.mockRestore();
				inventory.mockRestore();
			}
		});
	}

	for (const fault of [
		"incomplete target record",
		"truncated export",
		"controller not visible",
		"unrelated controller with the same suffix",
		"timeout with partial output",
	] as const) {
		test(`${fault} cannot end an owed modem rollback`, async () => {
			const entry =
				fault === "unrelated controller with the same suffix"
					? {
							...seed("executing"),
							stableKey: KEY.replace("platform-", "platform-aux-"),
						}
					: seed("executing");
			await commitMutationEntry(entry);
			setMutationBlockDeps({
				presentStableKeys: async () => PRESENCE_UNKNOWN,
			});
			spyOn(modemControl, "createUsbEnumerator").mockRestore();
			const runner = spyOn(spawnPolicy, "spawnWithTimeout");
			if (fault === "timeout with partial output") {
				runner.mockRejectedValue(
					new spawnPolicy.SpawnTimeoutError("udevadm", USB_ROOT),
				);
			} else {
				runner.mockResolvedValue({
					exitCode: 0,
					stdout:
						fault === "incomplete target record"
							? `${USB_ROOT}\nP: ${CONTROLLER}/1-1/1-1.4/1-1.4.1\nE: DEVTYPE=usb_device\nE: ID_PATH=${KEY}\n`
							: USB_ROOT,
					stderr: "",
				});
			}
			const names = spyOn(routerUsbSysfs, "names").mockReturnValue(
				fault === "controller not visible"
					? []
					: fault === "truncated export"
						? ["usb1", "1-1.4.1"]
						: ["usb1"],
			);
			const root = spyOn(routerUsbSysfs, "rootPath").mockReturnValue(
				`/sys${CONTROLLER}`,
			);
			try {
				const summary = await initMutationRecovery();
				expect(summary.unreadable).toBe(1);
				expect(summary.quarantined).toBe(0);
				expect(await readMutationEntry(entry.stableKey)).toEqual(entry);
				expect(isRecoveryPending()).toBe(true);
			} finally {
				runner.mockRestore();
				names.mockRestore();
				root.mockRestore();
			}
		});
	}

	for (const state of [
		"device-absent-quarantine",
		"decommissioned",
		"armed",
	] as const) {
		test(`unavailable USB inventory keeps ${state} without treating it as absent`, async () => {
			const entry = seed(state);
			await commitMutationEntry(entry);
			setMutationCaptureDeps({
				enumerate: async () => {
					throw new Error("USB inventory unavailable");
				},
			});
			setMutationBlockDeps({
				presentStableKeys: async () => PRESENCE_UNKNOWN,
			});

			const summary = await initMutationRecovery();

			const owesRollback = state === "armed";
			expect(summary.unreadable).toBe(owesRollback ? 1 : 0);
			expect(isRecoveryPending()).toBe(owesRollback);
			expect(await readMutationEntry(KEY)).toEqual(entry);
			expect(tryAcquireModemMutation(KEY)).toEqual({
				admitted: false,
				refusal: owesRollback
					? "recovery_pending"
					: state === "decommissioned"
						? "device_decommissioned"
						: "mutation_blocked",
			});
			expect(streamingBlockingMutation()?.stableKey).toBe(
				state === "decommissioned" ? undefined : KEY,
			);
		});
	}

	test("an unreadable bus reports the device present rather than quarantining it", async () => {
		await commitMutationEntry(seed("failed"));
		setMutationBlockDeps({
			listEntries: () => listMutationEntries(),
			presentStableKeys: () => Promise.resolve(PRESENCE_UNKNOWN),
		});
		const blocks = await refreshMutationBlocks();
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.devicePresent).toBe(true);
	});
});
