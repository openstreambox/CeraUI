import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePrivateStateLease } from "../../helpers/private-state-lease.ts";
import { cellularHandoffSteps } from "../network/cellular-host-handoff.ts";
import { resetLifecycleInterlock } from "../streaming/lifecycle-admission.ts";
import {
	beginRecoveryBarrier,
	resetRecoveryBarrier,
} from "../streaming/recovery-barrier.ts";
import {
	accessInternalCallAuthority,
	internalCallAuthorityKey,
	listInternalCallAuthorities,
	parseInternalCallAuthority,
} from "./internal-call-authority.ts";
import {
	InternalCallRecovery,
	type InternalCallRecoveryHostDeps,
	internalCallLeaseStore,
	retainInternalCallInverse,
} from "./internal-call-recovery.ts";
import {
	internalCallSubscriptionKey,
	internalCallUnitKey,
} from "./internal-call-unit.ts";
import {
	accessInternalContextAuthority,
	internalContextAuthorityKey,
	planInternalContextAuthority,
} from "./internal-context-authority.ts";
import type { CellularControl, CellularControlTarget } from "./modems.ts";
import {
	commitMutationEntry,
	defaultMutationJournalFs,
	readMutationEntry,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "./mutation-journal.ts";
import { mutationSlotName } from "./mutation-journal-parse.ts";

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Synthetic authority unavailable");
	return value;
}
async function fixture(
	run: (f: Awaited<ReturnType<typeof state>>) => Promise<void>,
) {
	const dir = await mkdtemp(join(tmpdir(), "internal-replay-"));
	const names = [
		"CERALIVE_CELLULAR_INTERNAL_OWNER_STATE_DIR",
		"CERALIVE_CELLULAR_INTERNAL_CONTEXT_STATE_DIR",
	] as const;
	const saved = names.map((name) => process.env[name]);
	names.forEach((name, index) => {
		process.env[name] = join(dir, String(index));
	});
	resetRecoveryBarrier();
	resetLifecycleInterlock();
	beginRecoveryBarrier();
	setMutationJournalDeps({
		fs: defaultMutationJournalFs,
		dir: join(dir, "journal"),
		now: () => 2000,
	});
	try {
		await run(await state(join(dir, "journal")));
	} finally {
		names.forEach((name, index) => {
			if (saved[index] === undefined) delete process.env[name];
			else process.env[name] = saved[index];
		});
		resetMutationJournalDeps();
		resetRecoveryBarrier();
		resetLifecycleInterlock();
		await rm(dir, { recursive: true, force: true });
	}
}
async function state(journalDir: string) {
	const equipment = "000000000000001",
		subscriber = "000000000000003";
	const unit = required(internalCallUnitKey(equipment)),
		subscription = required(internalCallSubscriptionKey(subscriber));
	const key = internalCallAuthorityKey(unit),
		owner = "b".repeat(64),
		epoch = "c".repeat(64);
	const bootId = "11111111-1111-4111-8111-111111111111";
	const physical = {
		ifname: "wwan0",
		ifindex: "17",
		usbDevice: "synthetic-usb",
		netDevice: "synthetic-net",
		generation: "one",
	};
	const device = {
		path: "/org/freedesktop/NetworkManager/Devices/1",
		udi: physical.netDevice,
		iface: physical.ifname,
		ipIface: physical.ifname,
		managed: true,
	};
	const plan = {
		version: 1 as const,
		bootId,
		link: physical,
		nmOwner: ":1.17",
		device,
		raDefault: "1" as const,
		up: false,
	};
	const initial = parseInternalCallAuthority(
		{
			version: 1,
			key,
			unit,
			owner,
			epoch,
			bootId,
			stableKey: "synthetic-key",
			physical,
			identity: {
				model: "FM350-GL",
				firmware: "81600.0000.00.29.18.01",
				mode: "rndis",
			},
			subscription,
			cid: 1,
			contextKey: internalContextAuthorityKey(unit, 1),
			contextExpected: true,
			contextReleased: false,
			phase: "holding",
			handoff: {
				version: 1,
				owner,
				epoch,
				plan,
				steps: cellularHandoffSteps(plan),
				cursor: 3,
				phase: "active",
			},
		},
		key,
	);
	const original = {
		apn: "baseline.invalid",
		family: "ipv4" as const,
		settings: ["0.0.0.0", "0"],
	};
	const base = required(
		planInternalContextAuthority(
			{
				unit,
				subscription,
				cid: 1,
				desired: { apn: "current.invalid", family: "ipv4v6" },
			},
			original,
			false,
		),
	);
	await accessInternalContextAuthority(unit, 1, async (_value, write) =>
		write({ ...base, phase: "active", activationOwned: true }),
	);
	await accessInternalCallAuthority(unit, async (_value, write) =>
		write(initial),
	);
	let present = true,
		consumers = true,
		hostCount = 0,
		active = true,
		managed = false,
		up = true,
		ra: "0" | "1" = "0";
	let readSubscriber: string | undefined = subscriber,
		canLookup = true,
		closeFails = false,
		nmRestored = true;
	let context = structuredClone(base.desired);
	const events: string[] = [];
	const control: CellularControl = {
		valid: async () => true,
		readSubscriber: async () => readSubscriber,
		verifySubscriber: async () => readSubscriber === subscriber,
		onRevoked: () => () => {},
		registration: async () => true,
		registrationState: async () => "home",
		readContext: async () => structuredClone(context),
		contextActive: async () => active,
		defineContext: async (_cid, apn, family, settings) => {
			events.push("define");
			context = { apn, family, settings: [...(settings ?? [])] };
		},
		activateContext: async (_cid, value) => {
			events.push(`activate-${value}`);
			active = value;
		},
		readGrant: async () => undefined,
		readContextDns: async () => undefined,
		readIpv4Grant: async () => undefined,
		readAutoConnect: async () => undefined,
		disableAutoConnect: async () => false,
		reset: async () => {
			throw new Error("Recovery cannot reset");
		},
		close: async () => {
			events.push("control-close");
			if (closeFails) throw new Error("close pending");
		},
	};
	const target = {
		id: 12,
		key: initial.stableKey,
		equipment,
		subscriber,
		simId: "synthetic-new-object",
		...physical,
		identity: initial.identity,
	} as CellularControlTarget;
	const nm = {
		owner: ":1.17",
		devices: [device],
		valid: () => true,
		onRevoked: () => () => {},
		read: async () => ({ ...device, managed }),
		setManaged: async (
			_device: unknown,
			_expected: boolean,
			value: boolean,
		) => {
			events.push(`managed-${value}`);
			managed = value;
			return true;
		},
		close: async () => {
			events.push("nm-close");
		},
	};
	const deps: InternalCallRecoveryHostDeps = {
		bootId: async () => bootId,
		physical: async () => (present ? "present" : "absent"),
		hosts: async () => Array.from({ length: hostCount }, () => ({}) as never),
		consumers: async () => consumers,
		lookup: async () => {
			events.push("lookup");
			return canLookup ? target : undefined;
		},
		control: async () => {
			events.push("acquire");
			return control;
		},
		nm: async () => nm,
		io: (_link, selectedNm) => ({
			nm: selectedNm,
			present: async () => present,
			resourceState: async () => (present ? "present" : "absent"),
			nmRestored: async () => nmRestored && (!present || managed),
			readRaDefault: async () => ra,
			readUp: async () => up,
			setRaDefault: async (_expected, value) => {
				events.push(`ra-${value}`);
				ra = value;
				return true;
			},
			setUp: async (_expected, value) => {
				events.push(`up-${value}`);
				up = value;
				return true;
			},
		}),
	};
	const entry = (state: "executing" | "failed" = "executing", own = true) => ({
		version: 1 as const,
		stableKey: initial.stableKey,
		kind: "modem-config" as const,
		state,
		attemptId: "attempt-one",
		startedAt: 1000,
		updatedAt: 1000,
		preState: own
			? {
					format: "cellular-internal-context-v1",
					unit,
					subscription,
					cid: 1,
					contextKey: initial.contextKey,
				}
			: { format: "other-format" },
		history: [{ state, at: 1000 }],
	});
	return {
		journalDir,
		initial,
		deps,
		events,
		entry,
		read: () => accessInternalCallAuthority(unit, async (value) => value),
		context: () =>
			accessInternalContextAuthority(unit, 1, async (value) => value),
		set: (value: {
			present?: boolean;
			active?: boolean;
			consumers?: boolean;
			hostCount?: number;
			subscriber?: string | null;
			lookup?: boolean;
			closeFails?: boolean;
			nmRestored?: boolean;
			ra?: "0" | "1";
		}) => {
			if (value.present !== undefined) present = value.present;
			if (value.active !== undefined) active = value.active;
			if (value.consumers !== undefined) consumers = value.consumers;
			if (value.hostCount !== undefined) hostCount = value.hostCount;
			if (value.subscriber !== undefined)
				readSubscriber = value.subscriber ?? undefined;
			if (value.lookup !== undefined) canLookup = value.lookup;
			if (value.closeFails !== undefined) closeFails = value.closeFails;
			if (value.nmRestored !== undefined) nmRestored = value.nmRestored;
			if (value.ra !== undefined) ra = value.ra;
		},
	};
}

test("startup restores the current unit context and host before completing its journal and releasing its lease", async () =>
	fixture(async (f) => {
		await commitMutationEntry(f.entry());
		const retained = await retainInternalCallInverse(f.initial, f.deps);
		expect(retained).toBeDefined();
		expect(
			await acquirePrivateStateLease(internalCallLeaseStore(), f.initial.key),
		).toBeUndefined();
		expect(await required(retained).cleanup()).toBe(true);
		expect(f.events).toEqual([
			"lookup",
			"acquire",
			"activate-false",
			"define",
			"up-false",
			"managed-true",
			"ra-1",
			"control-close",
			"nm-close",
		]);
		expect(await f.read()).toBeUndefined();
		expect((await f.context())?.phase).toBe("parked");
		expect((await readMutationEntry(f.initial.stableKey))?.state).toBe(
			"completed",
		);
		const lease = await acquirePrivateStateLease(
			internalCallLeaseStore(),
			f.initial.key,
		);
		expect(lease).toBeDefined();
		lease?.release();
		expect(await required(retained).cleanup()).toBe(true);
	}));

test("consumer and host uncertainty retain authority without acquiring a modem control", async () =>
	fixture(async (f) => {
		const retained = await retainInternalCallInverse(f.initial, f.deps);
		f.set({ consumers: false });
		expect(await required(retained).cleanup()).toBe(false);
		f.set({ consumers: true, hostCount: 1 });
		expect(await required(retained).cleanup()).toBe(false);
		expect(f.events).toEqual([]);
		expect(await f.read()).toBeDefined();
		f.set({ hostCount: 0 });
		expect(await required(retained).cleanup()).toBe(true);
	}));

test("a failed journal remains blocked and is never silently healed", async () =>
	fixture(async (f) => {
		await commitMutationEntry(f.entry("failed"));
		const retained = await retainInternalCallInverse(f.initial, f.deps);
		expect(await required(retained).cleanup()).toBe(false);
		expect(f.events).toEqual([]);
		expect((await f.read())?.phase).toBe("holding");
	}));

test("unknown identity and an absent fresh unit cannot authorize AT or host restoration", async () =>
	fixture(async (f) => {
		const retained = await retainInternalCallInverse(f.initial, f.deps);
		f.set({ lookup: false });
		expect(await required(retained).cleanup()).toBe(false);
		expect(f.events).toEqual(["lookup"]);
		f.set({ lookup: true, subscriber: null });
		expect(await required(retained).cleanup()).toBe(false);
		expect(f.events).toEqual(["lookup", "lookup", "acquire"]);
		f.set({ subscriber: "000000000000003" });
		expect(await required(retained).cleanup()).toBe(true);
	}));

test("positive physical absence retires host ownership without issuing any modem command", async () =>
	fixture(async (f) => {
		f.set({ present: false });
		const retained = await retainInternalCallInverse(f.initial, f.deps);
		expect(await required(retained).cleanup()).toBe(true);
		expect(f.events).toEqual([]);
		expect((await f.context())?.phase).toBe("active");
		expect(await f.read()).toBeUndefined();
	}));

test("control-close uncertainty cannot repeat AT effects after the host guard was restored", async () =>
	fixture(async (f) => {
		f.set({ closeFails: true });
		const retained = await retainInternalCallInverse(f.initial, f.deps);
		await expect(required(retained).cleanup()).rejects.toThrow("close pending");
		expect((await f.read())?.contextReleased).toBe(true);
		const effects = f.events.filter(
			(event) => event.startsWith("activate") || event === "define",
		);
		f.set({ closeFails: false });
		expect(await required(retained).cleanup()).toBe(true);
		expect(
			f.events.filter(
				(event) => event.startsWith("activate") || event === "define",
			),
		).toEqual(effects);
	}));

test("unrelated completed journal bytes remain unchanged by whole-owner retirement", async () =>
	fixture(async (f) => {
		await commitMutationEntry({
			...f.entry("executing", false),
			state: "completed",
			history: [{ state: "completed", at: 1000 }],
		});
		const before = await readMutationEntry(f.initial.stableKey),
			retained = await retainInternalCallInverse(f.initial, f.deps);
		expect(await required(retained).cleanup()).toBe(true);
		expect(await readMutationEntry(f.initial.stableKey)).toEqual(before);
	}));

test("read-only verification does not run a retained inverse or acquire a unit", async () =>
	fixture(async (f) => {
		let retains = 0;
		const owner = new InternalCallRecovery({
			list: listInternalCallAuthorities,
			retain: async (row) => {
				retains++;
				return retainInternalCallInverse(row, f.deps);
			},
		});
		await owner.verify();
		expect(retains).toBe(0);
		expect(f.events).toEqual([]);
		f.set({ consumers: false });
		await expect(owner.replay()).rejects.toThrow("incomplete");
		await owner.verify();
		expect(retains).toBe(1);
		expect(f.events).toEqual([]);
		f.set({ consumers: true });
		await owner.replay();
		expect(retains).toBe(1);
	}));

test("a lost completion fsync retains whole-owner authority and retries only bookkeeping", async () =>
	fixture(async (f) => {
		await commitMutationEntry(f.entry());
		let lost = true;
		setMutationJournalDeps({
			dir: f.journalDir,
			fs: {
				...defaultMutationJournalFs,
				fsyncDir: async (dir) => {
					if (lost) {
						lost = false;
						throw new Error("completion fsync lost");
					}
					await defaultMutationJournalFs.fsyncDir(dir);
				},
			},
		});
		const retained = required(
			await retainInternalCallInverse(f.initial, f.deps),
		);
		await expect(retained.cleanup()).rejects.toThrow("completion fsync lost");
		expect((await f.read())?.contextReleased).toBe(true);
		expect((await readMutationEntry(f.initial.stableKey))?.state).toBe(
			"completed",
		);
		const effects = [...f.events];
		expect(await retained.cleanup()).toBe(true);
		expect(
			f.events.filter(
				(event) => event === "define" || event.startsWith("activate"),
			),
		).toEqual(
			effects.filter(
				(event) => event === "define" || event.startsWith("activate"),
			),
		);
		expect(await f.read()).toBeUndefined();
	}));

test("a later SIM cannot receive the predecessor's APN or an activity setter", async () =>
	fixture(async (f) => {
		f.set({ subscriber: "000000000000004" });
		const retained = required(
			await retainInternalCallInverse(f.initial, f.deps),
		);
		expect(await retained.cleanup()).toBe(false);
		expect(f.events).toEqual(["lookup", "acquire"]);
		// Only a positively inactive, exactly owned context may be parked.
		expect((await f.read())?.contextReleased).toBe(false);
		f.set({ active: false });
		expect(await retained.cleanup()).toBe(true);
		expect(
			f.events.filter(
				(event) => event === "define" || event.startsWith("activate"),
			),
		).toEqual([]);
		expect((await f.context())?.phase).toBe("parked");
	}));

test("a malformed journal slot cannot turn a read fault into permission to recover hardware", async () =>
	fixture(async (f) => {
		await commitMutationEntry(f.entry());
		await Bun.write(
			join(f.journalDir, `${mutationSlotName(f.initial.stableKey)}.json`),
			"{broken",
		);
		const retained = required(
			await retainInternalCallInverse(f.initial, f.deps),
		);
		await expect(retained.cleanup()).rejects.toThrow();
		expect(f.events).toEqual([]);
		expect((await f.read())?.phase).toBe("holding");
	}));
