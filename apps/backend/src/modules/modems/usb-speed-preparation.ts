/*
  KEEP A MODEM'S OWN USB LINK AT USB 2 WHEN ITS QUIRK ASKS FOR IT.

  The RM520N-GL raises its own receiver's noise floor when its USB 3 link is
  active (about 14 dB measured; one US carrier never registered at USB 3 and
  always did at USB 2). `AT+QCFG="usbspeed","20"` keeps the module at USB 2 and
  survives resets.

  - The read is the link speed in sysfs. At 480 Mbit/s or slower nothing is
    touched: no inhibition and no AT command.
  - A faster link means the setting is not in effect. Only then, and only while
    no stream runs, the modem is inhibited, the stored value is read and kept as
    `original` before any setter, and "20" is written if it differs. After
    readback the box reserves the reset and sends `AT+CFUN=1,1`. A setter
    has a durable attempt before dispatch. A confirmed deferral returns that
    attempt when Start wins before reset admission.
  - The next USB generation verifies it: back at 480 Mbit/s or slower.
  - At most one modem is switched at a time, 15 minutes between attempts, two
    attempts per unit; then the unit is blocked until its record is removed.
  - This does not depend on the carrier or on a saved profile: a modem that never
    registers at USB 3 must still be switched.
  - `/etc/ceralive/no-usbspeed` stops every write; the step still logs what it
    would do.
*/

import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../../helpers/logger.ts";
import { listPrivateJsonKeys } from "../../helpers/private-json-state.ts";
import {
	currentLifecycleHolder,
	type ModemJournalLease,
	tryAcquireModemJournalKey,
} from "../streaming/lifecycle-admission.ts";
import { isRecoveryPending } from "../streaming/recovery-barrier.ts";
import { getStreamLifecycleState } from "../streaming/stream-lifecycle-status.ts";
import { readCellularSlot } from "./cellular-authority-revision.ts";
import {
	accessCellularAuthority,
	cellularAuthorityMigration,
} from "./cellular-authority-store.ts";
import {
	type PreparationRecord,
	parsePreparationRecord,
	preparationKey,
} from "./cellular-preparation-state.ts";
import {
	acquireCellularControl,
	type CellularControlTarget,
	cellularTargetPresent,
	readCellularControlTarget,
	readCellularUsbSpeed,
} from "./modems.ts";
import { getModemIds } from "./modems-state.ts";
import { modemStableKeyForId } from "./mutation-identity.ts";
import { backgroundModemRefusal } from "./mutation-lease.ts";
import { resolveTransportQuirk } from "./transport-policy.ts";

export const USB2_MBITS = 480;
export const USB_SPEED_ATTEMPTS = 2;
export const USB_SPEED_PAUSE_MS = 15 * 60_000;
export const USB_SPEED_RETURN_WINDOW_MS = 180_000;
const SWITCHED_OFF = "/etc/ceralive/no-usbspeed";

export type UsbSpeedRecord = Extract<PreparationRecord, { kind: "usbspeed" }>;
export type UsbSpeedAction =
	| "none"
	| "aligned"
	| "wait"
	| "verified"
	| "hold"
	| "blocked"
	| "write";

export interface UsbSpeedInput {
	readonly desired: "20" | undefined;
	readonly speed: number | undefined;
	readonly generation: string;
	readonly record: UsbSpeedRecord | undefined;
	readonly now: number;
	readonly switchedOff: boolean;
	readonly streaming: boolean;
	readonly otherInFlight: boolean;
	/** The last aborted takeover, which pauses like an attempt without counting. */
	readonly abortedAt?: number;
}
export interface UsbSpeedDecision {
	readonly action: UsbSpeedAction;
	readonly reason: string;
	/** A record change to persist before acting, if any. */
	readonly update?: UsbSpeedRecord;
}

function withinWindow(
	now: number,
	started: number | undefined,
	duration: number,
): boolean {
	if (started === undefined) return false;
	const age = now - started;
	return age >= 0 && age < duration;
}

/** Pure: the next step for one unit. */
export function decideUsbSpeed(input: UsbSpeedInput): UsbSpeedDecision {
	const { desired, speed, generation, now } = input;
	if (!desired) return { action: "none", reason: "no usbspeed quirk" };
	let record = input.record;
	let update: UsbSpeedRecord | undefined;
	if (record?.phase === "awaiting-usb") {
		if (generation === record.epoch) {
			// The reset has not taken the old enumeration away yet.
			if (withinWindow(now, record.started, USB_SPEED_RETURN_WINDOW_MS))
				return { action: "wait", reason: "module reset pending" };
			record = {
				...record,
				phase: "failed",
				reason: "module did not re-enumerate",
			};
			update = record;
		} else if (speed !== undefined && speed <= USB2_MBITS) {
			return {
				action: "verified",
				reason: `back at ${speed} Mbit/s`,
				update: { ...record, phase: "verified", epoch: generation },
			};
		} else if (
			speed === undefined &&
			withinWindow(now, record.started, USB_SPEED_RETURN_WINDOW_MS)
		) {
			return { action: "wait", reason: "link speed unreadable" };
		} else {
			record = {
				...record,
				phase: "failed",
				reason: `back at ${speed} Mbit/s`,
			};
			update = record;
		}
	}
	const withUpdate = (d: Omit<UsbSpeedDecision, "update">): UsbSpeedDecision =>
		update ? { ...d, update } : d;
	if (record?.phase === "blocked")
		return withUpdate({
			action: "blocked",
			reason: record.reason ?? "blocked",
		});
	if (speed === undefined)
		return withUpdate({ action: "none", reason: "link speed unreadable" });
	if (speed <= USB2_MBITS)
		return withUpdate({ action: "aligned", reason: `link at ${speed} Mbit/s` });
	if (record && record.attempts >= USB_SPEED_ATTEMPTS) {
		const reason = `still at ${speed} Mbit/s after ${record.attempts} attempts`;
		return {
			action: "blocked",
			reason,
			update: { ...record, phase: "blocked", reason },
		};
	}
	if (input.switchedOff)
		return withUpdate({ action: "hold", reason: "switched off (no-usbspeed)" });
	if (
		withinWindow(now, record?.started, USB_SPEED_PAUSE_MS) ||
		withinWindow(now, input.abortedAt, USB_SPEED_PAUSE_MS)
	)
		return withUpdate({
			action: "hold",
			reason: "pause after the last attempt",
		});
	if (input.streaming)
		return withUpdate({ action: "hold", reason: "a stream is running" });
	if (input.otherInFlight)
		return withUpdate({
			action: "hold",
			reason: "another modem is being switched",
		});
	return withUpdate({
		action: "write",
		reason: `link at ${speed} Mbit/s; set usbspeed ${desired}`,
	});
}

async function readRecord(key: string): Promise<PreparationRecord | undefined> {
	return accessCellularAuthority(
		"cellular-preparation",
		key,
		parsePreparationRecord,
		async (value) => value,
		process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR,
		true,
		// Each unit's record is its own slot: writing it is not a change to the
		// modem mutation journal, so it can never raise the global barrier.
		"slot",
	);
}
async function writeRecord(record: PreparationRecord) {
	await accessCellularAuthority(
		"cellular-preparation",
		record.key,
		parsePreparationRecord,
		async (_value, write) => write(record),
		process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR,
		true,
		"slot",
	);
}

function preparationDirectory(): string {
	return (
		process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR ??
		cellularAuthorityMigration("cellular-preparation", parsePreparationRecord)
			.destination.dir
	);
}

/** After boot migration the destination holds every unit, including one still off
 * the bus. Only a prospective switch needs to inspect the missing units. */
async function missingUnitReturning(
	visible: ReadonlySet<string>,
	now: number,
): Promise<boolean> {
	const store = { dir: preparationDirectory() };
	for (const key of await listPrivateJsonKeys(store)) {
		if (visible.has(key)) continue;
		const raw = await readCellularSlot(store, key);
		if (raw === undefined) continue;
		const record = parsePreparationRecord(raw, key);
		if (
			record.kind === "usbspeed" &&
			record.phase === "awaiting-usb" &&
			withinWindow(now, record.started, USB_SPEED_RETURN_WINDOW_MS)
		)
			return true;
	}
	return false;
}

export interface UsbSpeedDeps {
	readonly missingUnitReturning: typeof missingUnitReturning;
	readonly ids: () => readonly number[];
	readonly stableKey: (id: number) => string | undefined;
	readonly target: typeof readCellularControlTarget;
	readonly present: typeof cellularTargetPresent;
	readonly speed: typeof readCellularUsbSpeed;
	readonly acquire: typeof acquireCellularControl;
	readonly read: typeof readRecord;
	readonly write: typeof writeRecord;
	readonly streaming: () => boolean;
	readonly switchedOff: () => boolean;
	readonly now: () => number;
	readonly log: (message: string) => void;
}
export const defaultUsbSpeedDeps: UsbSpeedDeps = {
	missingUnitReturning,
	ids: getModemIds,
	stableKey: modemStableKeyForId,
	target: readCellularControlTarget,
	present: cellularTargetPresent,
	speed: readCellularUsbSpeed,
	acquire: acquireCellularControl,
	read: readRecord,
	write: writeRecord,
	streaming: () => getStreamLifecycleState() !== "idle",
	switchedOff: () => existsSync(SWITCHED_OFF),
	now: Date.now,
	log: (message) => logger.info(message, { module: "modems" }),
};

export const usbSpeedKey = (equipment: string) =>
	preparationKey("usbspeed", equipment);

/** Aborted takeovers per unit, so a failing takeover is not retried every poll. */
const aborted = new Map<string, number>();
/** The last logged decision per unit; one log line per change. */
const reported = new Map<string, string>();
let inFlight: Promise<readonly number[]> | undefined;

export function resetUsbSpeedPreparationForTest(): void {
	aborted.clear();
	reported.clear();
}

/** One attempt on one unit: inhibit, read, record, write if different, read back, reset. */
async function applyUsbSpeed(
	target: CellularControlTarget,
	desired: "20",
	record: UsbSpeedRecord | undefined,
	key: string,
	owner: ModemJournalLease,
	deps: UsbSpeedDeps,
): Promise<UsbSpeedRecord | undefined> {
	const control = await deps.acquire(target);
	try {
		if (deps.streaming()) throw new Error("a stream started");
		if (backgroundModemRefusal(target.key)) return undefined;
		const fresh = await deps.read(key);
		if (fresh && fresh.kind !== "usbspeed")
			throw new Error("Unexpected preparation authority");
		record = fresh;
		const decision = decideUsbSpeed({
			desired,
			speed: await deps.speed(target),
			generation: target.generation,
			record,
			now: deps.now(),
			switchedOff: deps.switchedOff(),
			streaming: deps.streaming(),
			otherInFlight: false,
		});
		if (decision.update) await deps.write(decision.update);
		if (decision.action !== "write") return undefined;
		if (!(await deps.present(target)))
			throw new Error("modem changed before the switch");
		const current = await control.readUsbSpeed();
		if (current === undefined) throw new Error("usbspeed readback missing");
		if (deps.streaming() || backgroundModemRefusal(target.key))
			return undefined;
		const previousAttempts = record?.attempts ?? 0;
		const needsSetter = current !== desired;
		let next: UsbSpeedRecord = {
			version: 1,
			kind: "usbspeed",
			key,
			// The value before our first write: the one a restore puts back.
			original: record?.original ?? current,
			desired,
			// Set before the setter: a lost reply must still count as our write.
			wrote: (record?.wrote ?? false) || needsSetter,
			// An interrupted setting request must keep its place in the budget.
			attempts: needsSetter ? previousAttempts + 1 : previousAttempts,
			phase: "attempted",
			epoch: target.generation,
			started: deps.now(),
		};
		await deps.write(next);
		const defer = async () => {
			const reason =
				deps.streaming() || currentLifecycleHolder() === "streaming"
					? "stream started"
					: "modem control busy";
			deps.log(`${target.ifname} usbspeed deferred: ${reason}`);
			// Only a known deferral gives back the reserved attempt. Keep the
			// original setting and cooldown even if the setter already succeeded.
			await deps.write({ ...next, attempts: previousAttempts, reason });
		};
		if (needsSetter) {
			if (deps.streaming() || backgroundModemRefusal(target.key)) {
				await defer();
				return undefined;
			}
			let readback: string | undefined;
			try {
				readback = await control.setUsbSpeed(desired);
			} finally {
				// A failed setting request still spends an attempt, including a lost reply.
				if (readback !== desired) {
					next = {
						...next,
						phase: "failed",
						reason:
							readback === undefined
								? "setter readback missing"
								: "setter readback differs",
					};
					await deps.write(next);
				}
			}
			if (readback !== desired) return next;
		}
		if (deps.streaming() || !owner.tryUpgrade()) {
			await defer();
			return undefined;
		}
		// The setter and reset belong to the same attempt. A reset-only
		// attempt takes its place in the budget here, before dispatch.
		next = { ...next, attempts: previousAttempts + 1, phase: "awaiting-usb" };
		await deps.write(next);
		if (deps.streaming()) throw new Error("a stream started");
		try {
			await control.reset();
		} catch {
			// The reset may remove the serial endpoint before it answers OK.
		}
		return next;
	} finally {
		await control.close().catch(() => undefined);
	}
}

/** Check each unit once; switch at most one modem. Returns the modem ids switched. */
async function runUsbSpeedPreparationOnce(
	deps: UsbSpeedDeps = defaultUsbSpeedDeps,
): Promise<readonly number[]> {
	if (isRecoveryPending()) return [];
	const units: {
		id: number;
		target: CellularControlTarget;
		desired: "20";
		key: string;
		record: UsbSpeedRecord | undefined;
	}[] = [];
	for (const id of deps.ids()) {
		const stable = deps.stableKey(id);
		if (!stable) continue;
		try {
			const target = await deps.target(id, stable);
			const desired = target
				? resolveTransportQuirk(target.identity)?.usbSpeed
				: undefined;
			if (!target || !desired || !/^\d{14,16}$/.test(target.equipment))
				continue;
			const key = usbSpeedKey(target.equipment);
			const stored = await deps.read(key);
			if (stored && stored.kind !== "usbspeed")
				throw new Error("Unexpected preparation authority");
			units.push({ id, target, desired, key, record: stored });
		} catch {
			logger.warn("usbspeed check deferred", { module: "modems" });
		}
	}
	const visible = new Set(units.map((unit) => unit.key));
	let missingReturn: boolean | undefined;
	const switched: number[] = [];
	for (const unit of units) {
		const others = units.some(
			(other) => other !== unit && other.record?.phase === "awaiting-usb",
		);
		const speed = await deps.speed(unit.target);
		const abortedAt = aborted.get(unit.key);
		const decision = decideUsbSpeed({
			desired: unit.desired,
			speed,
			generation: unit.target.generation,
			record: unit.record,
			now: deps.now(),
			switchedOff: deps.switchedOff(),
			streaming: deps.streaming(),
			otherInFlight: others || switched.length > 0,
			...(abortedAt !== undefined ? { abortedAt } : {}),
		});
		if (decision.update) {
			await deps.write(decision.update);
			unit.record = decision.update;
		}
		let line = `${unit.target.ifname} usbspeed: ${decision.action} (${decision.reason})`;
		if (decision.action === "blocked") {
			const record = join(preparationDirectory(), `${unit.key}.json`);
			line += ` modem=${unit.id} record=${record}`;
		}
		if (reported.get(unit.key) !== line) {
			reported.set(unit.key, line);
			deps.log(line);
		}
		if (decision.action !== "write" || switched.length > 0) continue;
		// Checking a missing peer is read-only. Keep Start available throughout
		// this census. Overlapping USB polls share the same in-flight attempt.
		try {
			missingReturn ??= await deps.missingUnitReturning(visible, deps.now());
		} catch {
			deps.log("usbspeed deferred: return records unavailable");
			break;
		}
		if (missingReturn) continue;
		if (deps.streaming() || backgroundModemRefusal(unit.target.key)) continue;
		const owner = tryAcquireModemJournalKey(unit.target.key);
		if (!owner) continue;
		try {
			if (!(await deps.present(unit.target)))
				throw new Error("modem changed before the switch");
			if (deps.streaming() || isRecoveryPending()) continue;
			unit.record = await applyUsbSpeed(
				unit.target,
				unit.desired,
				unit.record,
				unit.key,
				owner,
				deps,
			);
			if (!unit.record) continue;
			aborted.delete(unit.key);
			const outcome =
				unit.record.phase === "awaiting-usb"
					? "module reset requested"
					: (unit.record.reason ?? unit.record.phase);
			deps.log(
				`${unit.target.ifname} usbspeed: ${outcome} (stored ${unit.record.original}, wanted ${unit.desired})`,
			);
		} catch (error) {
			// A takeover error also pauses. The durable record owns the count.
			aborted.set(unit.key, deps.now());
			deps.log(
				`${unit.target.ifname} usbspeed: attempt stopped (${error instanceof Error ? error.message : "error"}); next try after the pause`,
			);
		} finally {
			owner.release();
		}
		switched.push(unit.id);
	}
	return switched;
}

/** Overlapping polls join the same attempt and receive the same reset list. */
export function runUsbSpeedPreparation(
	deps: UsbSpeedDeps = defaultUsbSpeedDeps,
): Promise<readonly number[]> {
	if (inFlight) return inFlight;
	inFlight = runUsbSpeedPreparationOnce(deps).finally(() => {
		inFlight = undefined;
	});
	return inFlight;
}
