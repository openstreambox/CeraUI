/**
 * Acknowledging a failed modem mutation — both typed paths, and everything that
 * must NOT unblock.
 *
 * The suite exists because the dangerous failure mode here is silent: an
 * acknowledgement that merely clears a badge leaves the operator streaming over a
 * modem whose real state nobody established. So the negatives (a mismatch, a
 * mode-less dismissal, an absent device) get as much coverage as the happy paths,
 * and the crash injection between the acknowledgement write and the archive is
 * asserted to RESUME rather than to lose the operator's decision.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	jest,
	spyOn,
	test,
} from "bun:test";

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MODEM_MUTATION_JOURNAL_VERSION,
	type ModemMutationEntry,
	type ModemMutationState,
	modemMutationAckInputSchema,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import * as udev from "../modules/modems/modem-id-path-source.ts";
import {
	acknowledgeMutation,
	decommissionMutation,
	rebaselineMutation,
} from "../modules/modems/mutation-acknowledge.ts";
import { operatorMutationBlocks } from "../modules/modems/mutation-block-list.ts";
import {
	refreshMutationBlocks as refreshBlocks,
	resetMutationBlockDeps,
	setMutationBlockDeps,
} from "../modules/modems/mutation-blocks.ts";
import {
	commitMutationEntry,
	defaultMutationJournalFs,
	listMutationEntries,
	type MutationJournalFs,
	readMutationEntry,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import {
	captureModemUnitLinkId,
	clearMutationRollbacks,
	resetMutationCaptureDeps,
	setMutationCaptureDeps,
} from "../modules/modems/mutation-rollback.ts";
import { routerUsbSysfs } from "../modules/modems/router-subnet-recovery-device.ts";
import * as subnetVerify from "../modules/network/router-subnet-verify.ts";
import {
	resetLifecycleInterlock,
	streamingBlockingMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../modules/streaming/recovery-barrier.ts";
import { acknowledgeMutationProcedure } from "../rpc/procedures/modems.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const KEY = "platform-xhci-hcd.0.auto-usb-0:1.4.1";
const PRE_STATE = {
	vidPid: "2c7c:0801",
	model: "RM520N-GL",
	firmwareRevision: "RM520NGLAAR01A07M4G",
	mode: "qmi",
	ifname: "wwan0",
};

const QMI = [
	{
		interfaceClass: 0xff,
		interfaceSubClass: 0xff,
		interfaceProtocol: 0xff,
		driver: "qmi_wwan",
	},
];
const MBIM = [
	{
		interfaceClass: 0x02,
		interfaceSubClass: 0x0e,
		interfaceProtocol: 0x00,
		driver: "cdc_mbim",
	},
];

let dir: string;

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

function useDevice(mode: "qmi" | "mbim" | "absent", model = "RM520N-GL"): void {
	const controller = "/devices/platform/xhci-hcd.0.auto/usb1";
	const record =
		mode === "absent"
			? `P: ${controller}\nE: SUBSYSTEM=usb\nE: DEVTYPE=usb_device\n`
			: `P: ${controller}/1-1/1-1.4/1-1.4.1
E: SUBSYSTEM=usb
E: DEVTYPE=usb_device
E: ID_VENDOR_ID=2c7c
E: ID_MODEL_ID=0801
E: ID_PATH=${KEY}
`;
	spyOn(udev, "readUdevExportDb").mockResolvedValue(record);
	spyOn(routerUsbSysfs, "names").mockReturnValue(
		mode === "absent" ? ["usb1"] : ["usb1", "1-1.4.1"],
	);
	spyOn(routerUsbSysfs, "rootPath").mockReturnValue(`/sys${controller}`);
	setMutationCaptureDeps({
		enumerate: () =>
			Promise.resolve(
				mode === "absent"
					? []
					: ([
							{
								vendorId: "2c7c",
								productId: "0801",
								model,
								firmwareRevision: "RM520NGLAAR01A07M4G",
								bDeviceClass: 0,
								ifname: "wwan0",
								physicalUid: KEY,
								interfaces: mode === "qmi" ? QMI : MBIM,
							},
						] as never),
			),
	});
	setMutationBlockDeps({
		listEntries: () => listMutationEntries(),
		presentStableKeys: () =>
			Promise.resolve(mode === "absent" ? new Set<string>() : new Set([KEY])),
	});
}

async function seed(state: ModemMutationState): Promise<ModemMutationEntry> {
	const entry: ModemMutationEntry = {
		version: MODEM_MUTATION_JOURNAL_VERSION,
		stableKey: KEY,
		kind: "usb-mode",
		state,
		attemptId: "attempt-ack",
		startedAt: 1_000,
		updatedAt: 1_000,
		preState: PRE_STATE,
		detail: "rollback did not restore the journaled pre-state",
		history: [{ state, at: 1_000 }],
	};
	await commitMutationEntry(entry);
	return entry;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ceraui-mutation-ack-"));
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
	jest.restoreAllMocks();
	resetMutationJournalDeps();
	resetMutationCaptureDeps();
	resetMutationBlockDeps();
	clearMutationRollbacks();
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	await rm(dir, { recursive: true, force: true });
});

describe("5a — VERIFIED-ROLLBACK", () => {
	test("a device restored externally is confirmed, archived and unblocked", async () => {
		await seed("failed");
		useDevice("qmi");
		await initMutationRecovery();
		expect(streamingBlockingMutation()?.stableKey).toBe(KEY);

		const result = await acknowledgeMutation(KEY, "verified-rollback");
		expect(result).toEqual({ success: true, state: "acknowledged" });
		expect(await readdir(dir)).toEqual([]);
		expect(streamingBlockingMutation()).toBeUndefined();
	});
});

describe("5b — VERIFIED-ROLLBACK MISMATCH", () => {
	test("a device that does NOT match the pre-state refuses and stays blocked", async () => {
		await seed("failed");
		useDevice("mbim");
		await initMutationRecovery();

		const result = await acknowledgeMutation(KEY, "verified-rollback");
		expect(result).toEqual({ success: false, error: "state_mismatch" });
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
		expect(streamingBlockingMutation()?.stableKey).toBe(KEY);
	});
});

describe("5c — FORCE-REBASELINE", () => {
	test("the operator's accepted CURRENT state becomes the journaled baseline", async () => {
		await seed("failed");
		useDevice("mbim");
		await initMutationRecovery();

		const result = await acknowledgeMutation(KEY, "force-rebaseline");
		expect(result).toEqual({ success: true, state: "acknowledged" });
		expect(await readdir(dir)).toEqual([]);
		expect(streamingBlockingMutation()).toBeUndefined();
	});

	test("an INCOHERENT read is refused — a baseline must be a real reading", async () => {
		await seed("failed");
		setMutationCaptureDeps({
			enumerate: () =>
				Promise.resolve([
					{
						vendorId: "",
						productId: "",
						bDeviceClass: 0,
						physicalUid: KEY,
						interfaces: MBIM,
					},
				] as never),
		});
		expect(await acknowledgeMutation(KEY, "force-rebaseline")).toEqual({
			success: false,
			error: "read_failed",
		});
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
	});
});

describe("5d — a crash between the acknowledgement write and the archive", () => {
	test("replay RESUMES the archive and the unblock", async () => {
		await seed("failed");
		useDevice("mbim");
		await initMutationRecovery();

		// Inject the crash exactly at the archive: the acknowledgement commits and
		// the durable delete never runs.
		const noDelete: MutationJournalFs = {
			...defaultMutationJournalFs,
			unlink: () => Promise.reject(new Error("crash before archive")),
		};
		setMutationJournalDeps({ fs: noDelete, dir, now: () => 3_000 });
		await acknowledgeMutation(KEY, "force-rebaseline");
		setMutationJournalDeps({
			fs: defaultMutationJournalFs,
			dir,
			now: () => 4_000,
		});

		const survived = await readMutationEntry(KEY);
		expect(survived?.state).toBe("acknowledged");
		expect(survived?.acknowledgedMode).toBe("force-rebaseline");
		// The rebaselined state — not the pre-state — is what was journaled.
		expect(survived?.preState.mode).toBe("mbim");

		await initMutationRecovery();
		expect(await readdir(dir)).toEqual([]);
		expect(streamingBlockingMutation()).toBeUndefined();
	});
});

describe("5e — nothing else may unblock a failed mutation", () => {
	test("a mode-less acknowledgement cannot even be EXPRESSED on the wire", () => {
		expect(
			modemMutationAckInputSchema.safeParse({
				stableKey: KEY,
				confirm: true,
			}).success,
		).toBe(false);
		// …nor an unconfirmed one, nor one carrying an unknown extra key.
		expect(
			modemMutationAckInputSchema.safeParse({
				stableKey: KEY,
				mode: "verified-rollback",
			}).success,
		).toBe(false);
		expect(
			modemMutationAckInputSchema.safeParse({
				stableKey: KEY,
				mode: "verified-rollback",
				confirm: true,
				dismiss: true,
			}).success,
		).toBe(false);
	});

	test("acknowledging a device that is not blocked is refused", async () => {
		await seed("armed");
		useDevice("qmi");
		expect(await acknowledgeMutation(KEY, "force-rebaseline")).toEqual({
			success: false,
			error: "not_blocked",
		});
	});

	test("acknowledging an unknown device is refused", async () => {
		useDevice("qmi");
		expect(await acknowledgeMutation("usb-0:9.9", "force-rebaseline")).toEqual({
			success: false,
			error: "no_entry",
		});
	});

	test("an ABSENT device quarantines instead of unblocking", async () => {
		await seed("failed");
		useDevice("absent");
		expect(await acknowledgeMutation(KEY, "verified-rollback")).toEqual({
			success: false,
			error: "device_absent",
		});
		expect((await readMutationEntry(KEY))?.state).toBe(
			"device-absent-quarantine",
		);
	});

	test("the REAL procedure is the same code path", async () => {
		await seed("failed");
		useDevice("qmi");
		await initMutationRecovery();
		expect(
			await call(
				acknowledgeMutationProcedure,
				{ stableKey: KEY, mode: "verified-rollback", confirm: true },
				{ context: makeContext() },
			),
		).toEqual({ success: true, state: "acknowledged" });
	});
});

describe("decommission and rebaseline", () => {
	test("a decommission releases GLOBAL streaming and blocks only that identity", async () => {
		await seed("failed");
		useDevice("absent");
		await initMutationRecovery();
		// The replay table leaves a `failed` entry alone; quarantine is entered
		// when an ACKNOWLEDGEMENT finds the device gone, which is the moment the
		// operator learns it and the only moment a decommission can follow.
		await acknowledgeMutation(KEY, "verified-rollback");
		expect((await readMutationEntry(KEY))?.state).toBe(
			"device-absent-quarantine",
		);
		await refreshBlocks();
		expect(streamingBlockingMutation()?.stableKey).toBe(KEY);

		expect(await decommissionMutation(KEY)).toEqual({
			success: true,
			state: "decommissioned",
		});
		expect(streamingBlockingMutation()).toBeUndefined();
	});

	test("a decommission is refused while the failed device is still connected", async () => {
		await seed("failed");
		useDevice("qmi");
		expect(await decommissionMutation(KEY)).toEqual({
			success: false,
			error: "state_mismatch",
		});
	});

	test("a rebaseline adopts the device now occupying the identity", async () => {
		await seed("failed");
		useDevice("absent");
		await acknowledgeMutation(KEY, "verified-rollback");
		await decommissionMutation(KEY);

		// A REPLACEMENT unit appears in the same port.
		useDevice("mbim", "SIM7600G-H");
		await initMutationRecovery();
		expect((await readMutationEntry(KEY))?.state).toBe("recommission-pending");

		expect(await rebaselineMutation(KEY)).toEqual({
			success: true,
			state: "acknowledged",
		});
		expect(await readdir(dir)).toEqual([]);
	});

	test("a rebaseline is refused while the identity is not awaiting one", async () => {
		await seed("failed");
		useDevice("qmi");
		expect(await rebaselineMutation(KEY)).toEqual({
			success: false,
			error: "not_blocked",
		});
	});
});

test("eSIM recovery cannot be verified through unchanged USB descriptors", async () => {
	useDevice("qmi");
	const entry = await seed("failed");
	await commitMutationEntry({ ...entry, kind: "esim" });
	expect(await acknowledgeMutation(KEY, "verified-rollback")).toEqual({
		success: false,
		error: "state_mismatch",
	});
	expect((await listMutationEntries()).length).toBe(1);
});

describe("a journaled unit link and the state come from one observation", () => {
	const unit = (serialNumber: string) => ({
		vendorId: "2c7c",
		productId: "0801",
		model: "RM520N-GL",
		firmwareRevision: "RM520NGLAAR01A07M4G",
		bDeviceClass: 0,
		ifname: "wwan0",
		physicalUid: KEY,
		serialNumber,
		interfaces: QMI,
	});

	/** Each enumeration answers the next unit; the last one repeats. */
	function units(...serials: string[]): () => number {
		let calls = 0;
		setMutationCaptureDeps({
			enumerate: () =>
				Promise.resolve([
					unit(serials[Math.min(calls++, serials.length - 1)] ?? ""),
				] as never),
		});
		return () => calls;
	}

	async function seedWithUnit(serial: string): Promise<void> {
		useDevice("qmi");
		units(serial);
		const unitLinkId = await captureModemUnitLinkId(KEY);
		expect(unitLinkId).toBeDefined();
		await commitMutationEntry({ ...(await seed("failed")), unitLinkId });
		await initMutationRecovery();
	}

	test("the original unit is verified and archived", async () => {
		await seedWithUnit("UNIT-ORIGINAL-0001");
		const enumerations = units("UNIT-ORIGINAL-0001");
		expect(await acknowledgeMutation(KEY, "verified-rollback")).toEqual({
			success: true,
			state: "acknowledged",
		});
		expect(enumerations()).toBe(1);
	});

	test("a replacement with the original's descriptors quarantines", async () => {
		await seedWithUnit("UNIT-ORIGINAL-0001");
		units("UNIT-REPLACEMENT-0002");
		expect(await acknowledgeMutation(KEY, "verified-rollback")).toEqual({
			success: false,
			error: "device_absent",
		});
		expect((await readMutationEntry(KEY))?.state).toBe(
			"device-absent-quarantine",
		);
	});

	test("a unit swap between two reads cannot pair one unit's state with the other's link", async () => {
		await seedWithUnit("UNIT-ORIGINAL-0001");
		// The replacement is seen first; the original returns right after.
		units("UNIT-REPLACEMENT-0002", "UNIT-ORIGINAL-0001");
		expect(await acknowledgeMutation(KEY, "verified-rollback")).toEqual({
			success: false,
			error: "device_absent",
		});
		expect(await readMutationEntry(KEY)).toBeDefined();
	});

	test("a serial read after a replug at the same port is not the enumerated unit's", async () => {
		await seedWithUnit("UNIT-ORIGINAL-0001");
		// The snapshot holds a replacement without a udev serial (device 7);
		// the original is back at the same sysfs path by the time the serial
		// is read, as device 8.
		const replacement = {
			...unit("UNIT-REPLACEMENT-0002"),
			serialNumber: undefined,
			sysfsPath: "/sys/devices/platform/xhci-hcd.0.auto/usb1/1-1/1-1.4/1-1.4.1",
			udevProperties: { DEVNUM: "007" },
		};
		let devnum = "8";
		setMutationCaptureDeps({
			enumerate: () => Promise.resolve([replacement] as never),
			readSerial: () => Promise.resolve("UNIT-ORIGINAL-0001"),
			readDevnum: () => Promise.resolve(devnum),
		});
		expect((await operatorMutationBlocks()).map((b) => b.checkable)).toEqual([
			false,
		]);
		expect(await acknowledgeMutation(KEY, "verified-rollback")).toEqual({
			success: false,
			error: "device_absent",
		});
		expect(await readMutationEntry(KEY)).toBeDefined();

		// Control: the same read while device 7 still holds is that unit's.
		devnum = "7";
		expect(await captureModemUnitLinkId(KEY)).toBeDefined();
	});

	test("a sysfs serial without the enumerated device number is no unit evidence", async () => {
		await seedWithUnit("UNIT-ORIGINAL-0001");
		// A partial udev record: no DEVNUM to bind the later sysfs read to.
		const partial = {
			...unit("UNIT-REPLACEMENT-0002"),
			serialNumber: undefined,
			sysfsPath: "/sys/devices/platform/xhci-hcd.0.auto/usb1/1-1/1-1.4/1-1.4.1",
			udevProperties: {},
		};
		let devnumReads = 0;
		setMutationCaptureDeps({
			enumerate: () => Promise.resolve([partial] as never),
			readSerial: () => Promise.resolve("UNIT-ORIGINAL-0001"),
			readDevnum: () => {
				devnumReads += 1;
				return Promise.resolve("7");
			},
		});
		expect(await captureModemUnitLinkId(KEY)).toBeUndefined();
		expect((await operatorMutationBlocks()).map((b) => b.checkable)).toEqual([
			false,
		]);
		expect(await acknowledgeMutation(KEY, "verified-rollback")).toEqual({
			success: false,
			error: "device_absent",
		});
		expect(devnumReads).toBe(0);
	});

	test("a peer's serial counts against a duplicate even without its device number", async () => {
		useDevice("qmi");
		const bound = (uid: string, udevProperties: object) => ({
			...unit("UNIT-SHARED-0003"),
			physicalUid: uid,
			serialNumber: undefined,
			sysfsPath: `/sys/devices/platform/xhci-hcd.0.auto/usb1/${uid}`,
			udevProperties,
		});
		setMutationCaptureDeps({
			enumerate: () =>
				Promise.resolve([
					bound(KEY, { DEVNUM: "7" }),
					// Same vendor on another port, same serial, partial record.
					bound("platform-xhci-hcd.0.auto-usb-0:1.3", {}),
				] as never),
			readSerial: () => Promise.resolve("UNIT-SHARED-0003"),
			readDevnum: () => Promise.resolve("7"),
		});
		expect(await captureModemUnitLinkId(KEY)).toBeUndefined();
	});

	test("a router-subnet row offers Check again only with the journaled unit", async () => {
		await seedWithUnit("UNIT-ORIGINAL-0001");
		const entry = await readMutationEntry(KEY);
		if (!entry) throw new Error("seeded entry missing");
		await commitMutationEntry({ ...entry, kind: "router-subnet" });
		await initMutationRecovery();
		// The netdev witness holds; only the unit tells the two dongles apart.
		spyOn(subnetVerify, "routerSubnetCheckProof").mockReturnValue({
			isCurrent: () => true,
		} as never);
		units("UNIT-REPLACEMENT-0002");
		expect((await operatorMutationBlocks()).map((b) => b.checkable)).toEqual([
			false,
		]);
		units("UNIT-ORIGINAL-0001");
		expect((await operatorMutationBlocks()).map((b) => b.checkable)).toEqual([
			true,
		]);
	});

	test("Check again is offered only for the journaled unit", async () => {
		await seedWithUnit("UNIT-ORIGINAL-0001");
		units("UNIT-REPLACEMENT-0002");
		expect((await operatorMutationBlocks()).map((b) => b.checkable)).toEqual([
			false,
		]);
		units("UNIT-ORIGINAL-0001");
		expect((await operatorMutationBlocks()).map((b) => b.checkable)).toEqual([
			true,
		]);
	});
});
