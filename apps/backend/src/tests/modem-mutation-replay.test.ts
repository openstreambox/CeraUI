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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsbEnumerator } from "@ceralive/modem-control";

import {
	MODEM_MUTATION_JOURNAL_VERSION,
	type ModemMutationEntry,
	type ModemMutationState,
} from "@ceraui/rpc/schemas";

import { getConfig } from "../modules/config.ts";
import { rebaselineMutation } from "../modules/modems/mutation-acknowledge.ts";
import {
	PRESENCE_UNKNOWN,
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
	getMutationBlocks,
	resetLifecycleInterlock,
	streamingBlockingMutation,
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
	setMutationCaptureDeps({
		enumerate: async () => [
			{
				vendorId: "2c7c",
				productId: "0801",
				physicalUid: KEY,
				sysfsPath: dir,
				udevProperties: { ID_SERIAL_SHORT: "fixture_ABC123" },
				interfaces: [],
				bDeviceClass: 0,
			},
		],
	});
	const unit = mintLinkId("usb-serial:2c7c:fixture_ABC123");
	expect(await captureModemUnitLinkId(KEY)).toBeUndefined();
	expect(await captureModemState(KEY, undefined, unit)).toBeUndefined();
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
		const summary = await initMutationRecovery();
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
