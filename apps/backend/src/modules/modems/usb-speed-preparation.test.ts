import { beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	setMutationBlocks,
	tryAcquireLifecycle,
	tryAcquireModemMutation,
} from "../streaming/lifecycle-admission.ts";
import {
	beginRecoveryBarrier,
	resetRecoveryBarrier,
} from "../streaming/recovery-barrier.ts";
import type { CellularControl, CellularControlTarget } from "./modems.ts";
import { mutationJournalRevision } from "./mutation-journal-revision.ts";
import {
	parseQcfgUsbSpeed,
	resolveTransportQuirk,
} from "./transport-policy.ts";
import {
	decideUsbSpeed,
	defaultUsbSpeedDeps,
	resetUsbSpeedPreparationForTest,
	runUsbSpeedPreparation,
	USB_SPEED_PAUSE_MS,
	USB_SPEED_RETURN_WINDOW_MS,
	type UsbSpeedDeps,
	type UsbSpeedInput,
	type UsbSpeedRecord,
	usbSpeedKey,
} from "./usb-speed-preparation.ts";

const RM520 = {
	model: "RM520N-GL",
	firmware: "RM520NGLAAR01A08M4G",
	mode: "qmi",
} as const;

beforeEach(() => resetUsbSpeedPreparationForTest());

test("the RM520 quirk asks for USB 2; other admitted modems do not", () => {
	expect(resolveTransportQuirk(RM520)?.usbSpeed).toBe("20");
	expect(
		resolveTransportQuirk({
			model: "DW5821e Snapdragon X20 LTE",
			firmware: "T77W968.F1.0.0.4.2.GC.010\n026",
			mode: "mbim",
		})?.usbSpeed,
	).toBeUndefined();
	expect(
		resolveTransportQuirk({
			model: "FM350-GL",
			firmware: "81600.0000.00.29.18.01",
			mode: "rndis",
		})?.usbSpeed,
	).toBeUndefined();
});

test("usbspeed replies need exactly one well-formed answer", () => {
	expect(parseQcfgUsbSpeed('+QCFG: "usbspeed","20"\r\n\r\nOK')).toBe("20");
	expect(parseQcfgUsbSpeed('+QCFG: "usbspeed",312\nOK')).toBe("312");
	expect(parseQcfgUsbSpeed("OK")).toBeUndefined();
	expect(parseQcfgUsbSpeed('+QCFG: "usbspeed","x"')).toBeUndefined();
	expect(
		parseQcfgUsbSpeed('+QCFG: "usbspeed","20"\n+QCFG: "usbspeed","312"'),
	).toBeUndefined();
});

const base: UsbSpeedInput = {
	desired: "20",
	speed: 5000,
	generation: "g1",
	record: undefined,
	now: 10 * USB_SPEED_PAUSE_MS,
	switchedOff: false,
	streaming: false,
	otherInFlight: false,
};
const record = (patch: Partial<UsbSpeedRecord> = {}): UsbSpeedRecord => ({
	version: 1,
	kind: "usbspeed",
	key: "k",
	original: "312",
	desired: "20",
	wrote: true,
	attempts: 1,
	phase: "awaiting-usb",
	epoch: "g1",
	started: base.now - 1000,
	...patch,
});

test("a USB 2 link is left alone and a fast idle link is written", () => {
	expect(decideUsbSpeed({ ...base, speed: 480 }).action).toBe("aligned");
	expect(decideUsbSpeed({ ...base, speed: 12 }).action).toBe("aligned");
	expect(decideUsbSpeed(base).action).toBe("write");
	expect(decideUsbSpeed({ ...base, desired: undefined }).action).toBe("none");
	expect(decideUsbSpeed({ ...base, speed: undefined }).action).toBe("none");
});

test("a stream, the switch, the pause and another switch in flight all hold", () => {
	for (const patch of [
		{ streaming: true },
		{ switchedOff: true },
		{ otherInFlight: true },
		{ abortedAt: base.now - 1000 },
		{ record: record({ phase: "failed", started: base.now - 1000 }) },
	])
		expect(decideUsbSpeed({ ...base, ...patch }).action).toBe("hold");
	expect(
		decideUsbSpeed({
			...base,
			record: record({
				phase: "failed",
				started: base.now - USB_SPEED_PAUSE_MS,
			}),
		}).action,
	).toBe("write");
});

test("the next USB generation verifies by link speed", () => {
	const waiting = record();
	expect(decideUsbSpeed({ ...base, record: waiting }).action).toBe("wait");
	const back = decideUsbSpeed({
		...base,
		record: waiting,
		generation: "g2",
		speed: 480,
	});
	expect(back.action).toBe("verified");
	expect(back.update).toMatchObject({ phase: "verified", epoch: "g2" });
	expect(
		decideUsbSpeed({
			...base,
			record: waiting,
			generation: "g2",
			speed: undefined,
		}).action,
	).toBe("wait");
});

test("still fast after the reset counts, and two attempts block the unit", () => {
	const first = decideUsbSpeed({
		...base,
		record: record(),
		generation: "g2",
		now: base.now + USB_SPEED_PAUSE_MS,
	});
	expect(first.update).toMatchObject({ phase: "failed" });
	expect(first.action).toBe("write");
	const second = decideUsbSpeed({
		...base,
		record: record({ attempts: 2 }),
		generation: "g2",
		now: base.now + USB_SPEED_PAUSE_MS,
	});
	expect(second.action).toBe("blocked");
	expect(second.update).toMatchObject({ phase: "blocked" });
	expect(
		decideUsbSpeed({
			...base,
			record: record({ phase: "blocked" }),
			speed: 5000,
		}).action,
	).toBe("blocked");
});

test("a module that never re-enumerates fails once the return window ends", () => {
	const late = decideUsbSpeed({
		...base,
		record: record({ started: base.now - USB_SPEED_RETURN_WINDOW_MS }),
		now: base.now + USB_SPEED_PAUSE_MS,
	});
	expect(late.update).toMatchObject({
		phase: "failed",
		reason: "module did not re-enumerate",
	});
});

function box(
	opts: {
		units?: number;
		speeds?: number[];
		stored?: string;
		setterReadback?: string;
		streamAfterAcquire?: boolean;
		resetThrows?: boolean;
	} = {},
) {
	const units = opts.units ?? 1;
	const speeds = opts.speeds ?? Array(units).fill(5000);
	const calls: string[] = [];
	const records = new Map<string, UsbSpeedRecord>();
	let now = 10 * USB_SPEED_PAUSE_MS;
	let streaming = false;
	const target = (id: number) =>
		({
			id,
			key: `key-${id}`,
			deviceId: `device-${id}`,
			simId: `8900000000000000000${id}`,
			subscriber: `00000000000000${id}`,
			equipment: `35000000000000${id}`,
			ifname: `wwan${id}`,
			netDevice: `net-${id}`,
			ifindex: `${10 + id}`,
			usbDevice: `usb-${id}`,
			generation: `g-${id}`,
			identity: RM520,
			sim: {} as never,
		}) as CellularControlTarget;
	const control = (id: number): CellularControl =>
		({
			valid: async () => true,
			verifySubscriber: async () => true,
			readUsbSpeed: async () => {
				calls.push(`read ${id}`);
				return opts.stored ?? "312";
			},
			setUsbSpeed: async (value: string) => {
				calls.push(`set ${id} ${value}`);
				return opts.setterReadback ?? value;
			},
			reset: async () => {
				calls.push(`reset ${id}`);
				if (opts.resetThrows) throw new Error("port gone");
			},
			close: async () => {
				calls.push(`release ${id}`);
			},
		}) as unknown as CellularControl;
	const deps: UsbSpeedDeps = {
		missingUnitReturning: async () => false,
		ids: () => Array.from({ length: units }, (_, i) => i),
		stableKey: (id) => `key-${id}`,
		target: async (id) => target(id),
		present: async () => true,
		speed: async (t) => speeds[t.id],
		acquire: async (t) => {
			calls.push(`inhibit ${t.id}`);
			if (opts.streamAfterAcquire) streaming = true;
			return control(t.id);
		},
		read: async (key) => records.get(key),
		write: async (r) => {
			if (r.kind !== "usbspeed") throw new Error("unexpected record");
			calls.push(`record ${r.phase}${r.wrote ? " wrote" : ""}`);
			records.set(r.key, r);
		},
		streaming: () => streaming,
		switchedOff: () => false,
		now: () => now,
		log: () => undefined,
	};
	return {
		deps,
		calls,
		records,
		key: (id: number) => usbSpeedKey(target(id).equipment),
		advance: (ms: number) => {
			now += ms;
		},
		setStreaming: (v: boolean) => {
			streaming = v;
		},
	};
}

test("inhibit, read, record before the setter, write, read back, reset, release", async () => {
	const b = box();
	expect(await runUsbSpeedPreparation(b.deps)).toEqual([0]);
	expect(b.calls).toEqual([
		"inhibit 0",
		"read 0",
		"record attempted wrote",
		"set 0 20",
		"record awaiting-usb wrote",
		"reset 0",
		"release 0",
	]);
	expect(b.records.get(b.key(0))).toMatchObject({
		original: "312",
		attempts: 1,
		phase: "awaiting-usb",
	});
});

test("a USB 2 modem is never inhibited or sent a command", async () => {
	const b = box({ speeds: [480] });
	expect(await runUsbSpeedPreparation(b.deps)).toEqual([]);
	expect(b.calls).toEqual([]);
});

test("a stored value that is already right needs only the reset", async () => {
	const b = box({ stored: "20" });
	await runUsbSpeedPreparation(b.deps);
	expect(b.calls).not.toContain("set 0 20");
	expect(b.calls).toContain("reset 0");
	expect(b.records.get(b.key(0))).toMatchObject({
		wrote: false,
		original: "20",
	});
});

test("a setter readback mismatch stops before the reset", async () => {
	const b = box({ setterReadback: "312" });
	const messages: string[] = [];
	await runUsbSpeedPreparation({
		...b.deps,
		log: (message) => messages.push(message),
	});
	expect(messages.at(-1)).toContain("setter readback differs");
	expect(messages.at(-1)).not.toContain("module reset");
	expect(b.calls).not.toContain("reset 0");
	expect(b.calls).toContain("release 0");
	expect(b.records.get(b.key(0))).toMatchObject({
		phase: "failed",
		attempts: 1,
	});
});

test("two lost setter replies exhaust the budget and preserve the original USB setting", async () => {
	const b = box();
	const deps: UsbSpeedDeps = {
		...b.deps,
		acquire: async (target) => {
			const control = await b.deps.acquire(target);
			return {
				...control,
				setUsbSpeed: async (desired) => {
					await control.setUsbSpeed(desired);
					throw new Error("port closed before readback");
				},
			};
		},
	};
	for (let poll = 0; poll < 3; poll++) {
		await runUsbSpeedPreparation(deps);
		b.advance(USB_SPEED_PAUSE_MS);
	}
	expect(b.calls.filter((call) => call === "set 0 20")).toHaveLength(2);
	expect(b.calls).not.toContain("reset 0");
	expect(b.records.get(b.key(0))).toMatchObject({
		original: "312",
		wrote: true,
		attempts: 2,
		phase: "blocked",
	});
});

test("a restart after setter dispatch retains the attempt even when the outcome never reached disk", async () => {
	const dir = await mkdtemp(join(tmpdir(), "usbspeed-interrupted-"));
	const previous = process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR;
	process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR = dir;
	const b = box({ setterReadback: "312" });
	const countsAtDispatch: number[] = [];
	try {
		for (let boot = 0; boot < 3; boot++) {
			resetUsbSpeedPreparationForTest();
			let interrupted = false;
			await runUsbSpeedPreparation({
				...b.deps,
				read: defaultUsbSpeedDeps.read,
				write: async (entry) => {
					// Nothing after this process cut can reach the next boot.
					if (interrupted) throw new Error("process interrupted");
					await defaultUsbSpeedDeps.write(entry);
				},
				acquire: async (target) => {
					const control = await b.deps.acquire(target);
					return {
						...control,
						setUsbSpeed: async (value) => {
							const result = await control.setUsbSpeed(value);
							interrupted = true;
							const saved = await defaultUsbSpeedDeps.read(b.key(0));
							if (saved?.kind !== "usbspeed")
								throw new Error("missing original setting");
							countsAtDispatch.push(saved.attempts);
							return result;
						},
					};
				},
			});
			b.advance(USB_SPEED_PAUSE_MS);
		}
		expect(b.calls.filter((line) => line === "set 0 20")).toHaveLength(2);
		expect(countsAtDispatch).toEqual([1, 2]);
		expect(b.calls).not.toContain("reset 0");
		expect(await defaultUsbSpeedDeps.read(b.key(0))).toMatchObject({
			original: "312",
			wrote: true,
			attempts: 2,
			phase: "blocked",
		});
	} finally {
		if (previous === undefined)
			delete process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR;
		else process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR = previous;
		await rm(dir, { recursive: true, force: true });
	}
});

test("a stream that starts during the takeover stops before any command", async () => {
	const b = box({ streamAfterAcquire: true });
	await runUsbSpeedPreparation(b.deps);
	expect(b.calls).toEqual(["inhibit 0", "release 0"]);
	expect(b.records.size).toBe(0);
	// The aborted takeover pauses like an attempt.
	b.setStreaming(false);
	b.calls.length = 0;
	await runUsbSpeedPreparation({ ...b.deps, acquire: b.deps.acquire });
	expect(b.calls).toEqual([]);
});

test("a running stream holds without touching the modem", async () => {
	const b = box();
	b.setStreaming(true);
	expect(await runUsbSpeedPreparation(b.deps)).toEqual([]);
	expect(b.calls).toEqual([]);
});

test("a reset that takes the port away is not an error", async () => {
	const b = box({ resetThrows: true });
	await runUsbSpeedPreparation(b.deps);
	expect(b.records.get(b.key(0))).toMatchObject({ phase: "awaiting-usb" });
});

test("one modem at a time: the second waits until the first is verified", async () => {
	const b = box({ units: 2 });
	expect(await runUsbSpeedPreparation(b.deps)).toEqual([0]);
	b.calls.length = 0;
	// The first is still at its old generation, inside the return window.
	expect(await runUsbSpeedPreparation(b.deps)).toEqual([]);
	expect(b.calls).toEqual([]);
	// It comes back at USB 2 under a new generation; then the second goes.
	const first = b.records.get(b.key(0));
	if (!first) throw new Error("missing record");
	b.records.set(b.key(0), { ...first, epoch: "old" });
	const slowFirst = {
		...b.deps,
		speed: async (t: CellularControlTarget) => (t.id === 0 ? 480 : 5000),
	};
	expect(await runUsbSpeedPreparation(slowFirst)).toEqual([1]);
	expect(b.records.get(b.key(0))).toMatchObject({ phase: "verified" });
});

test("modems without the quirk are skipped entirely", async () => {
	const b = box();
	const other = {
		...b.deps,
		target: async (id: number) =>
			({
				...((await b.deps.target(id, "key")) as CellularControlTarget),
				identity: {
					model: "FM350-GL",
					firmware: "81600.0000.00.29.18.01",
					mode: "rndis",
				},
			}) as CellularControlTarget,
	};
	expect(await runUsbSpeedPreparation(other)).toEqual([]);
	expect(b.calls).toEqual([]);
});

test("a unit's usbspeed record is slot-scoped and never moves the journal revision", async () => {
	const dir = await mkdtemp(join(tmpdir(), "usbspeed-slot-"));
	const previous = process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR;
	process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR = dir;
	try {
		const key = usbSpeedKey("350000000000001");
		const before = mutationJournalRevision();
		await defaultUsbSpeedDeps.write(record({ key }));
		expect(await defaultUsbSpeedDeps.read(key)).toMatchObject({
			kind: "usbspeed",
			phase: "awaiting-usb",
		});
		expect(mutationJournalRevision()).toBe(before);
	} finally {
		if (previous === undefined)
			delete process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR;
		else process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR = previous;
		await rm(dir, { recursive: true, force: true });
	}
});

test("overlapping polls share one non-exclusive takeover and reset list", async () => {
	const b = box();
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const deps = {
		...b.deps,
		acquire: async (t: CellularControlTarget) => {
			await barrier;
			return b.deps.acquire(t);
		},
	};
	const a = runUsbSpeedPreparation(deps);
	const c = runUsbSpeedPreparation(deps);
	expect(a).toBe(c);
	release();
	expect(await a).toEqual([0]);
	expect(await c).toEqual([0]);
	expect(b.calls.filter((x) => x === "reset 0")).toHaveLength(1);
	expect(b.records.get(b.key(0))?.attempts).toBe(1);
});

test("authority is read again after inhibition", async () => {
	const b = box();
	await runUsbSpeedPreparation({
		...b.deps,
		acquire: async (t) => {
			b.records.set(
				b.key(0),
				record({ key: b.key(0), attempts: 2, phase: "blocked" }),
			);
			return b.deps.acquire(t);
		},
	});
	expect(b.calls).toEqual(["inhibit 0", "release 0"]);
});

test("a modem that vanished is never switched", async () => {
	const b = box();
	await runUsbSpeedPreparation({ ...b.deps, present: async () => false });
	expect(b.calls).toEqual([]);
});

test("a start during the setter stops before recording a USB return wait", async () => {
	const b = box();
	await runUsbSpeedPreparation({
		...b.deps,
		acquire: async (t) => {
			const c = await b.deps.acquire(t);
			return {
				...c,
				setUsbSpeed: async (value) => {
					b.setStreaming(true);
					return value;
				},
			};
		},
	});
	expect(b.records.get(b.key(0))?.phase).toBe("attempted");
	expect(b.calls).not.toContain("reset 0");
	expect(b.calls).toContain("release 0");
});

test("a start during the USB return record write stops before reset", async () => {
	const b = box();
	await runUsbSpeedPreparation({
		...b.deps,
		write: async (record) => {
			await b.deps.write(record);
			if (record.kind === "usbspeed" && record.phase === "awaiting-usb")
				b.setStreaming(true);
		},
	});
	expect(b.records.get(b.key(0))?.phase).toBe("awaiting-usb");
	expect(b.calls).not.toContain("reset 0");
	expect(b.calls).toContain("release 0");
});

test("unreadable speed on a new enumeration has a bounded wait", () => {
	const d = decideUsbSpeed({
		...base,
		generation: "g2",
		speed: undefined,
		record: record({ started: base.now - USB_SPEED_RETURN_WINDOW_MS }),
	});
	expect(d.action).not.toBe("wait");
	expect(d.update?.phase).toBe("failed");
});

test("starting is busy even before the streaming commit", async () => {
	const { seedStreamLifecycleState } = await import(
		"../streaming/stream-lifecycle-status.ts"
	);
	try {
		seedStreamLifecycleState("starting");
		expect(defaultUsbSpeedDeps.streaming()).toBe(true);
	} finally {
		seedStreamLifecycleState("idle");
	}
	expect(defaultUsbSpeedDeps.streaming()).toBe(false);
});

for (const guard of ["boot replay", "quarantine", "mode write"] as const) {
	test(`USB preparation waits for ${guard} without spending a reset attempt`, async () => {
		const b = box();
		const key = "key-0";
		if (guard === "boot replay") beginRecoveryBarrier();
		if (guard === "quarantine")
			setMutationBlocks([
				{ stableKey: key, refusal: "mutation_blocked", blocksStreaming: true },
			]);
		const owner =
			guard === "mode write" ? tryAcquireModemMutation(key) : undefined;
		try {
			expect(await runUsbSpeedPreparation(b.deps)).toEqual([]);
			expect(b.calls).toEqual([]);
		} finally {
			if (owner?.admitted) owner.lease.release();
			setMutationBlocks([]);
			resetRecoveryBarrier();
		}
		expect(await runUsbSpeedPreparation(b.deps)).toEqual([0]);
	});
}

test("Start wins during slow inhibition without consuming a reset or releasing the modem key", async () => {
	const b = box();
	const inhibit = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const run = runUsbSpeedPreparation({
		...b.deps,
		acquire: async (target) => {
			entered.resolve();
			await inhibit.promise;
			return b.deps.acquire(target);
		},
	});
	await entered.promise;
	const start = tryAcquireLifecycle("streaming");
	try {
		expect(start.admitted).toBe(true);
		expect(tryAcquireModemMutation("key-0").admitted).toBe(false);
		inhibit.resolve();
		expect(await run).toEqual([]);
		expect(b.records.size).toBe(0);
		expect(b.calls).not.toContain("reset 0");
	} finally {
		inhibit.resolve();
		if (start.admitted) start.lease.release();
	}
});

for (const cut of ["attempted write", "setter readback"] as const) {
	test(`two Starts winning at the ${cut} leave the USB reset budget available`, async () => {
		const b = box();
		const counts = [];
		const messages: string[] = [];
		for (let win = 0; win < 2; win++) {
			const entered = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const run = runUsbSpeedPreparation({
				...b.deps,
				log: (message) => messages.push(message),
				write: async (record) => {
					await b.deps.write(record);
					if (cut === "attempted write" && record.phase === "attempted") {
						entered.resolve();
						await resume.promise;
					}
				},
				acquire: async (target) => {
					const control = await b.deps.acquire(target);
					return {
						...control,
						setUsbSpeed: async (value) => {
							const readback = await control.setUsbSpeed(value);
							if (cut === "setter readback") {
								entered.resolve();
								await resume.promise;
							}
							return readback;
						},
					};
				},
			});
			await entered.promise;
			const start = tryAcquireLifecycle("streaming");
			try {
				expect(start.admitted).toBe(true);
				resume.resolve();
				expect(await run).toEqual([]);
			} finally {
				resume.resolve();
				if (start.admitted) start.lease.release();
			}
			const record = b.records.get(b.key(0));
			expect(record).toMatchObject({
				original: "312",
				phase: "attempted",
				wrote: true,
			});
			counts.push(record?.attempts);
			b.advance(USB_SPEED_PAUSE_MS);
		}
		expect(b.calls).not.toContain("reset 0");
		expect(counts).toEqual([0, 0]);
		expect(
			messages.filter(
				(line) => line === "wwan0 usbspeed deferred: stream started",
			),
		).toHaveLength(2);
		expect(await runUsbSpeedPreparation(b.deps)).toEqual([0]);
		expect(b.records.get(b.key(0))).toMatchObject({
			attempts: 1,
			phase: "awaiting-usb",
		});
	});
}

test("a reset-only deferral keeps an earlier attempt through restart", async () => {
	const b = box({ stored: "20" });
	const key = b.key(0);
	b.records.set(key, record({ key, phase: "failed", attempts: 1, started: 0 }));
	await runUsbSpeedPreparation({
		...b.deps,
		write: async (entry) => {
			await b.deps.write(entry);
			b.setStreaming(true);
		},
	});
	expect(b.records.get(key)).toMatchObject({
		original: "312",
		attempts: 1,
		reason: "stream started",
	});
	expect(b.calls).not.toContain("reset 0");
	b.setStreaming(false);
	resetUsbSpeedPreparationForTest();
	b.advance(USB_SPEED_PAUSE_MS);
	expect(await runUsbSpeedPreparation(b.deps)).toEqual([0]);
	expect(b.calls).not.toContain("set 0 20");
	expect(b.records.get(key)).toMatchObject({
		attempts: 2,
		phase: "awaiting-usb",
	});
});

test("Start is refused through USB reset and pending control release", async () => {
	const b = box();
	const closing = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const run = runUsbSpeedPreparation({
		...b.deps,
		acquire: async (target) => {
			const control = await b.deps.acquire(target);
			return {
				...control,
				close: async () => {
					closing.resolve();
					await release.promise;
					await control.close();
				},
			};
		},
	});
	await closing.promise;
	try {
		expect(b.calls).toContain("reset 0");
		const start = tryAcquireLifecycle("streaming");
		if (start.admitted) start.lease.release();
		expect(start.admitted).toBe(false);
	} finally {
		release.resolve();
		await run;
	}
	const start = tryAcquireLifecycle("streaming");
	if (start.admitted) start.lease.release();
	expect(start.admitted).toBe(true);
});

test("a negative wall-clock age expires the USB return and takeover cooldown", () => {
	const future = base.now + 86_400_000;
	expect(
		decideUsbSpeed({ ...base, record: record({ started: future }) }).update
			?.phase,
	).toBe("failed");
	expect(decideUsbSpeed({ ...base, abortedAt: future }).action).toBe("write");
});

test("another modem waits through an absent unit's durable return window after restart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "usb-return-window-"));
	const previous = process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR;
	process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR = dir;
	try {
		const a = box();
		const disk = {
			read: defaultUsbSpeedDeps.read,
			write: defaultUsbSpeedDeps.write,
			missingUnitReturning: defaultUsbSpeedDeps.missingUnitReturning,
		};
		expect(await runUsbSpeedPreparation({ ...a.deps, ...disk })).toEqual([0]);
		resetUsbSpeedPreparationForTest();
		expect(await disk.missingUnitReturning(new Set(), a.deps.now() - 1)).toBe(
			false,
		);
		const b = box({ units: 2 });
		const remaining = { ...b.deps, ...disk, ids: () => [1] };
		b.advance(USB_SPEED_RETURN_WINDOW_MS - 1);
		expect(await runUsbSpeedPreparation(remaining)).toEqual([]);
		expect(b.calls).toEqual([]);
		b.advance(1);
		expect(await runUsbSpeedPreparation(remaining)).toEqual([1]);
	} finally {
		if (previous === undefined)
			delete process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR;
		else process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR = previous;
		await rm(dir, { recursive: true, force: true });
	}
});

test("the read-only census of missing units leaves Start available", async () => {
	const b = box();
	let admitted: boolean | undefined;
	expect(
		await runUsbSpeedPreparation({
			...b.deps,
			missingUnitReturning: async () => {
				const start = tryAcquireLifecycle("streaming");
				admitted = start.admitted;
				if (start.admitted) start.lease.release();
				return true;
			},
		}),
	).toEqual([]);
	expect(admitted).toBe(true);
	expect(b.calls).toEqual([]);
});
