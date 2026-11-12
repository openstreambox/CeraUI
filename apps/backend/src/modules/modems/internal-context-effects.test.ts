import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivateJson } from "../../helpers/private-json-state.ts";
import {
	getMutationBlocks,
	resetLifecycleInterlock,
	tryAcquireLifecycle,
	tryAcquireModemMutation,
} from "../streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../streaming/recovery-barrier.ts";
import {
	type InternalContextAuthority,
	type InternalContextRequest,
	parseInternalContextAuthority,
} from "./internal-context-authority.ts";
import {
	deactivateInternalContextEffects,
	defaultInternalContextAccess,
	ensureInternalContextEffects,
	type InternalContextEffectsDeps,
	journalInternalContextEffects,
	parkChangedInternalContextEffects,
	restoreInternalContextEffects,
} from "./internal-context-effects.ts";
import type { CellularControl } from "./modems.ts";
import {
	readMutationEntry,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "./mutation-journal.ts";
import { withJournaledModemMutation } from "./mutation-lease.ts";
import type { InternalContext } from "./transport-policy.ts";

const unit = "a".repeat(64),
	simOne = "b".repeat(64),
	simTwo = "c".repeat(64),
	baseline: InternalContext = {
		apn: "baseline.invalid",
		family: "ipv4",
		settings: ["0.0.0.0", "0"],
	},
	request: InternalContextRequest = {
		unit,
		subscription: simOne,
		cid: 1,
		desired: { apn: "first.invalid", family: "ipv4v6" },
	};

function fixture() {
	let context = structuredClone(baseline),
		active = false,
		subscription: string | undefined = simOne,
		currentUnit = unit,
		owned = true,
		controlValid = true,
		withdrawn = true,
		policy = true,
		record: InternalContextAuthority | undefined,
		definition: "normal" | "lost" | "refuse" = "normal",
		activation: "normal" | "lost" | "refuse" = "normal",
		readable = true,
		baselineSeen = false,
		executed = 0;
	let onWrite: (value: InternalContextAuthority | undefined) => void = () => {},
		onPrepare = () => {},
		onMark = () => {};
	const events: string[] = [];
	const mutation = {
		markExecuting: async () => {
			expect(record).toBeDefined();
			executed++;
			events.push("journal-executing");
			onMark();
		},
	};
	const deps: InternalContextEffectsDeps = {
		owned: () => owned,
		withdrawn: () => withdrawn,
		baselineAllowed: () => !baselineSeen,
		current: async () => policy,
		identity: async () =>
			subscription
				? { unit: currentUnit, subscription, stableKey: "synthetic-key" }
				: undefined,
		prepareCall: async () => {
			events.push("link-up");
			onPrepare();
		},
		access: async (operation) =>
			operation(record && structuredClone(record), async (value) => {
				if (value) baselineSeen = true;
				record = value
					? parseInternalContextAuthority(structuredClone(value), value.key)
					: undefined;
				events.push(`persist-${record?.phase ?? "absent"}`);
				onWrite(record);
			}),
	};
	function control(): CellularControl {
		const capturedSim = subscription;
		return {
			valid: async () => controlValid && owned && currentUnit === unit,
			readSubscriber: async () => subscription,
			verifySubscriber: async () => capturedSim === subscription,
			onRevoked: () => () => {},
			registration: async () => true,
			registrationState: async () => "home",
			readContext: async () =>
				readable ? structuredClone(context) : undefined,
			contextActive: async () => (readable ? active : undefined),
			defineContext: async (cid, apn, family, settings) => {
				expect(cid).toBe(record?.cid);
				expect(["defining", "restoring"]).toContain(record?.phase);
				expect(subscription).toBe(capturedSim);
				expect(withdrawn).toBe(true);
				expect(executed).toBeGreaterThan(0);
				events.push(`define-${apn}`);
				if (definition !== "refuse")
					context = {
						apn,
						family,
						...(settings ? { settings: [...settings] } : {}),
					};
				if (definition !== "normal") throw new Error("Definition reply lost");
			},
			activateContext: async (cid, value) => {
				expect(cid).toBe(record?.cid);
				expect(record?.phase).toBe(value ? "activating" : "deactivating");
				expect(record?.activationOwned).toBe(true);
				expect(subscription).toBe(capturedSim);
				expect(withdrawn).toBe(true);
				expect(executed).toBeGreaterThan(0);
				events.push(`activate-${value}`);
				if (activation !== "refuse") active = value;
				if (activation !== "normal") throw new Error("Activation reply lost");
			},
			readGrant: async () => undefined,
			readContextDns: async () => undefined,
			readIpv4Grant: async () => undefined,
			readAutoConnect: async () => undefined,
			disableAutoConnect: async () => false,
			reset: async () => {
				throw new Error("Reset forbidden");
			},
			close: async () => {},
		};
	}
	return {
		deps,
		mutation,
		control,
		events,
		view: () => ({ context, active, record, executed }),
		set: (next: {
			context?: InternalContext;
			active?: boolean;
			subscription?: string | null;
			unit?: string;
			owned?: boolean;
			controlValid?: boolean;
			withdrawn?: boolean;
			policy?: boolean;
			definition?: typeof definition;
			activation?: typeof activation;
			readable?: boolean;
			onWrite?: typeof onWrite;
			onPrepare?: typeof onPrepare;
			onMark?: typeof onMark;
		}) => {
			if (next.context !== undefined) context = structuredClone(next.context);
			if (next.active !== undefined) active = next.active;
			if (next.subscription !== undefined)
				subscription = next.subscription ?? undefined;
			if (next.unit !== undefined) currentUnit = next.unit;
			if (next.owned !== undefined) owned = next.owned;
			if (next.controlValid !== undefined) controlValid = next.controlValid;
			if (next.withdrawn !== undefined) withdrawn = next.withdrawn;
			if (next.policy !== undefined) policy = next.policy;
			if (next.definition !== undefined) definition = next.definition;
			if (next.activation !== undefined) activation = next.activation;
			if (next.readable !== undefined) readable = next.readable;
			if (next.onWrite) onWrite = next.onWrite;
			if (next.onPrepare) onPrepare = next.onPrepare;
			if (next.onMark) onMark = next.onMark;
		},
	};
}

test("durable baseline, executing journal and link-up precede definition and activation", async () => {
	const f = fixture();
	expect(
		await ensureInternalContextEffects(
			request,
			f.control(),
			f.mutation,
			f.deps,
		),
	).toEqual({ confirmed: true, value: true });
	expect(f.events).toEqual([
		"persist-baseline",
		"journal-executing",
		"link-up",
		"persist-defining",
		"define-first.invalid",
		"persist-defined",
		"persist-activating",
		"activate-true",
		"persist-active",
	]);
	expect(f.view().record?.original).toEqual({
		subscription: simOne,
		context: baseline,
		active: false,
	});
});

test("lost replies settle only by positive same-unit/subscription read-back", async () => {
	const f = fixture();
	f.set({ definition: "lost", activation: "lost" });
	expect(
		await ensureInternalContextEffects(
			request,
			f.control(),
			f.mutation,
			f.deps,
		),
	).toEqual({ confirmed: true, value: true });
	expect(
		await deactivateInternalContextEffects(
			request,
			f.control(),
			f.mutation,
			f.deps,
		),
	).toEqual({ confirmed: true, value: true });
	expect(f.view().record).toMatchObject({
		phase: "defined",
		activationOwned: false,
	});
	expect(f.view().active).toBe(false);
});

test("unconfirmed definitions and activations retain the pending durable cursor", async () => {
	for (const action of ["definition", "activation"] as const) {
		const f = fixture();
		f.set({ [action]: "refuse" });
		const result = await ensureInternalContextEffects(
			request,
			f.control(),
			f.mutation,
			f.deps,
		);
		expect(result).toMatchObject({ confirmed: false, value: false });
		expect(f.view().record?.phase).toBe(
			action === "definition" ? "defining" : "activating",
		);
		expect(f.view().record?.original.context).toEqual(baseline);
		if (action === "definition")
			expect(f.events).not.toContain("activate-true");
	}
});

test("ownership, unit, SIM, policy or consumer refusal before dispatch writes nothing", async () => {
	for (const state of [
		{ owned: false },
		{ unit: "d".repeat(64) },
		{ subscription: simTwo },
		{ subscription: null },
		{ policy: false },
		{ withdrawn: false },
	]) {
		const f = fixture();
		f.set(state);
		expect(
			await ensureInternalContextEffects(
				request,
				f.control(),
				f.mutation,
				f.deps,
			),
		).toEqual({ confirmed: true, value: false });
		expect(f.events).toEqual([]);
	}
});

test("a successor or changed subscription during durable command preparation prevents dispatch", async () => {
	for (const state of [
		{ subscription: simTwo },
		{ withdrawn: false },
		{ owned: false },
	]) {
		const f = fixture();
		f.set({
			onWrite: (value) => {
				if (value?.phase === "defining") f.set(state);
			},
		});
		expect(
			await ensureInternalContextEffects(
				request,
				f.control(),
				f.mutation,
				f.deps,
			),
		).toMatchObject({ confirmed: false, value: false });
		expect(f.events.some((event) => event.startsWith("define-"))).toBe(false);
		expect(f.events).not.toContain("activate-true");
		expect(f.view().record?.phase).toBe("defining");
	}
});

test("caller mutation after the baseline cannot change context slot or desired APN", async () => {
	const f = fixture(),
		input = { ...request, desired: { ...request.desired } };
	f.set({
		onWrite: () => {
			input.cid = 3;
			input.desired.apn = "changed.invalid";
		},
	});
	expect(
		await ensureInternalContextEffects(input, f.control(), f.mutation, f.deps),
	).toEqual({ confirmed: true, value: true });
	expect(f.view().record).toMatchObject({
		cid: 1,
		desired: { apn: "first.invalid" },
	});
	expect(f.events).not.toContain("define-changed.invalid");
});

test("a foreign definition appearing during host preparation is preserved", async () => {
	const f = fixture();
	f.set({
		onPrepare: () =>
			f.set({ context: { ...baseline, apn: "foreign.invalid" } }),
	});
	expect(
		await ensureInternalContextEffects(
			request,
			f.control(),
			f.mutation,
			f.deps,
		),
	).toMatchObject({ confirmed: false, value: false });
	expect(f.events.some((event) => event.startsWith("define-"))).toBe(false);
	expect(f.view().context.apn).toBe("foreign.invalid");
});

test("same-SIM restore withdraws only the owned call and retains the original unit baseline", async () => {
	const f = fixture();
	await ensureInternalContextEffects(request, f.control(), f.mutation, f.deps);
	const before = f.view().executed;
	f.set({ policy: false });
	expect(
		await restoreInternalContextEffects(
			request,
			f.control(),
			f.mutation,
			f.deps,
		),
	).toEqual({ confirmed: true, value: true });
	expect(f.view()).toMatchObject({
		active: false,
		context: baseline,
		executed: before + 1,
		record: {
			phase: "parked",
			original: { context: baseline, subscription: simOne },
			desired: baseline,
		},
	});
	expect(f.events.indexOf("activate-false")).toBeLessThan(
		f.events.indexOf("define-baseline.invalid"),
	);
});

test("a borrowed active baseline call is released without a deactivate or definition", async () => {
	const f = fixture();
	f.set({
		context: { ...request.desired, settings: baseline.settings },
		active: true,
	});
	await ensureInternalContextEffects(request, f.control(), f.mutation, f.deps);
	const effects = f.events.filter(
		(event) => event.startsWith("define-") || event.startsWith("activate-"),
	);
	expect(
		await deactivateInternalContextEffects(
			request,
			f.control(),
			f.mutation,
			f.deps,
		),
	).toEqual({ confirmed: true, value: false });
	expect(
		await restoreInternalContextEffects(
			request,
			f.control(),
			f.mutation,
			f.deps,
		),
	).toEqual({ confirmed: true, value: true });
	expect(
		f.events.filter(
			(event) => event.startsWith("define-") || event.startsWith("activate-"),
		),
	).toEqual(effects);
	expect(f.view().record).toMatchObject({
		phase: "released",
		adoptedActive: true,
		activationOwned: false,
	});
	expect(f.view().active).toBe(true);
});

test("SIM transfer parks inactive state without setters, and never restores the old SIM APN", async () => {
	const f = fixture();
	await ensureInternalContextEffects(request, f.control(), f.mutation, f.deps);
	f.set({ active: false, subscription: simTwo });
	const count = f.events.length;
	expect(
		await parkChangedInternalContextEffects(request, f.control(), f.deps),
	).toBe(true);
	expect(f.events.slice(count)).toEqual(["persist-parked"]);
	const next = {
		...request,
		subscription: simTwo,
		desired: { apn: "second.invalid", family: "ipv4" as const },
	};
	expect(
		await ensureInternalContextEffects(next, f.control(), f.mutation, f.deps),
	).toEqual({ confirmed: true, value: true });
	expect(f.view().record?.original).toEqual({
		subscription: simOne,
		context: baseline,
		active: false,
	});
	const inverse = f.events.length;
	expect(
		await restoreInternalContextEffects(next, f.control(), f.mutation, f.deps),
	).toEqual({ confirmed: true, value: true });
	expect(
		f.events.slice(inverse).some((event) => event.startsWith("define-")),
	).toBe(false);
	expect(f.view().context.apn).toBe("second.invalid");
	expect(f.view().record?.phase).toBe("parked");
});

test("unknown or active changed-SIM observations cannot park, deactivate or restore", async () => {
	const f = fixture();
	await ensureInternalContextEffects(request, f.control(), f.mutation, f.deps);
	const start = f.events.length;
	f.set({ subscription: null });
	expect(
		await parkChangedInternalContextEffects(request, f.control(), f.deps),
	).toBe(false);
	f.set({ subscription: simTwo });
	expect(
		await parkChangedInternalContextEffects(request, f.control(), f.deps),
	).toBe(false);
	expect(
		await restoreInternalContextEffects(
			request,
			f.control(),
			f.mutation,
			f.deps,
		),
	).toEqual({ confirmed: true, value: false });
	expect(f.events.slice(start)).toEqual([]);
});

test("a changed SIM before definition can park only the still-recorded inactive baseline", async () => {
	const f = fixture();
	f.set({
		onWrite: (value) => {
			if (value?.phase === "defining") f.set({ subscription: simTwo });
		},
	});
	await ensureInternalContextEffects(request, f.control(), f.mutation, f.deps);
	f.set({ onWrite: () => {} });
	expect(
		await parkChangedInternalContextEffects(request, f.control(), f.deps),
	).toBe(true);
	expect(f.view().record).toMatchObject({
		phase: "parked",
		desired: baseline,
		original: { context: baseline },
	});
	expect(f.events.some((event) => event.startsWith("define-"))).toBe(false);
});

test("actual private storage commits the baseline before the first host or modem effect", async () => {
	const root = await mkdtemp(join(tmpdir(), "internal-context-effects-")),
		previous = process.env.CERALIVE_CELLULAR_INTERNAL_CONTEXT_STATE_DIR,
		f = fixture();
	process.env.CERALIVE_CELLULAR_INTERNAL_CONTEXT_STATE_DIR = root;
	const access = defaultInternalContextAccess(request),
		actual: InternalContextEffectsDeps = {
			...f.deps,
			access: (operation) =>
				access((value, write) =>
					operation(value, async (next) => {
						await write(next);
						await f.deps.access(async (_old, remember) => {
							await remember(next);
						});
					}),
				),
		};
	try {
		expect(
			await ensureInternalContextEffects(
				request,
				f.control(),
				f.mutation,
				actual,
			),
		).toEqual({ confirmed: true, value: true });
		const record = f.view().record;
		if (!record) throw new Error("Missing stored fixture");
		expect(await readPrivateJson({ dir: root }, record.key)).toEqual(record);
	} finally {
		if (previous === undefined)
			delete process.env.CERALIVE_CELLULAR_INTERNAL_CONTEXT_STATE_DIR;
		else process.env.CERALIVE_CELLULAR_INTERNAL_CONTEXT_STATE_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test("a failed inverse preserves its cursor, and a lost restore reply settles by read-back", async () => {
	const f = fixture();
	await ensureInternalContextEffects(request, f.control(), f.mutation, f.deps);
	f.set({ definition: "refuse" });
	expect(
		await restoreInternalContextEffects(
			request,
			f.control(),
			f.mutation,
			f.deps,
		),
	).toMatchObject({ confirmed: false, value: false });
	expect(f.view().record?.phase).toBe("restoring");
	expect(f.view().active).toBe(false);
	f.set({ definition: "lost" });
	expect(
		await restoreInternalContextEffects(
			request,
			f.control(),
			f.mutation,
			f.deps,
		),
	).toEqual({ confirmed: true, value: true });
	expect(f.view().record).toMatchObject({ phase: "parked", desired: baseline });
});

test("a SIM change at restore commit keeps an inactive baseline that can be parked without setters", async () => {
	const f = fixture();
	await ensureInternalContextEffects(request, f.control(), f.mutation, f.deps);
	f.set({
		onWrite: (value) => {
			if (value?.phase === "parked") f.set({ subscription: simTwo });
		},
	});
	expect(
		await restoreInternalContextEffects(
			request,
			f.control(),
			f.mutation,
			f.deps,
		),
	).toMatchObject({ confirmed: false, value: false });
	f.set({ onWrite: () => {} });
	const before = f.events.length;
	expect(
		await parkChangedInternalContextEffects(request, f.control(), f.deps),
	).toBe(true);
	expect(f.events.slice(before)).toEqual(["persist-parked"]);
});

test("the journal wrapper refuses a different physical key and unknown operations before any effect", async () => {
	const f = fixture();
	expect(
		await journalInternalContextEffects(
			"different-key",
			"activate",
			request,
			f.control(),
			f.deps,
		),
	).toBe(false);
	await expect(
		journalInternalContextEffects(
			"synthetic-key",
			"unknown" as "activate",
			request,
			f.control(),
			f.deps,
		),
	).rejects.toThrow();
	expect(f.events).toEqual([]);
});

test("the actual journal is executing before context effects and retains an uncertain activation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "internal-context-journal-")),
		key = "synthetic-key";
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	setMutationJournalDeps({ dir: directory });
	try {
		const f = fixture(),
			baseControl = f.control();
		const verify = async () => {
			const entry = await readMutationEntry(key);
			expect(entry?.state).toBe("executing");
			expect(entry?.preState).toMatchObject({
				format: "cellular-internal-context-v1",
				unit,
				subscription: simOne,
				cid: 1,
			});
			expect(tryAcquireLifecycle("streaming").admitted).toBe(false);
		};
		const control: CellularControl = {
			...baseControl,
			defineContext: async (...args) => {
				await verify();
				await baseControl.defineContext(...args);
			},
			activateContext: async (...args) => {
				await verify();
				await baseControl.activateContext(...args);
			},
		};
		const journal: typeof withJournaledModemMutation = (
			stableKey,
			kind,
			preState,
			run,
		) =>
			withJournaledModemMutation(stableKey, kind, preState, (mutation) =>
				run({
					...mutation,
					markExecuting: async () => {
						await mutation.markExecuting();
						await f.mutation.markExecuting();
					},
				}),
			);
		expect(
			await journalInternalContextEffects(
				key,
				"activate",
				request,
				control,
				f.deps,
				journal,
			),
		).toBe(true);
		expect(await readMutationEntry(key)).toBeUndefined();
		const held = tryAcquireModemMutation(key);
		expect(held.admitted).toBe(true);
		try {
			const refused = fixture();
			expect(
				await journalInternalContextEffects(
					key,
					"activate",
					request,
					refused.control(),
					refused.deps,
				),
			).toBe(false);
			expect(refused.events).toEqual([]);
		} finally {
			if (held.admitted) held.lease.release();
		}
		const uncertain = fixture();
		uncertain.set({ activation: "refuse" });
		const failingJournal: typeof withJournaledModemMutation = (
			stableKey,
			kind,
			preState,
			run,
		) =>
			withJournaledModemMutation(stableKey, kind, preState, (mutation) =>
				run({
					...mutation,
					markExecuting: async () => {
						await mutation.markExecuting();
						await uncertain.mutation.markExecuting();
					},
				}),
			);
		expect(
			await journalInternalContextEffects(
				key,
				"activate",
				request,
				uncertain.control(),
				uncertain.deps,
				failingJournal,
			),
		).toBe(false);
		expect((await readMutationEntry(key))?.state).toBe("failed");
		expect(getMutationBlocks().some((block) => block.stableKey === key)).toBe(
			true,
		);
		const count = uncertain.events.length;
		expect(
			await journalInternalContextEffects(
				key,
				"activate",
				request,
				uncertain.control(),
				uncertain.deps,
				failingJournal,
			),
		).toBe(false);
		expect(uncertain.events).toHaveLength(count);
	} finally {
		resetMutationJournalDeps();
		resetLifecycleInterlock();
		resetRecoveryBarrier();
		await rm(directory, { recursive: true, force: true });
	}
});

test("missing remembered authority cannot be recaptured or treated as a completed inverse", async () => {
	const f = fixture();
	await ensureInternalContextEffects(request, f.control(), f.mutation, f.deps);
	await f.deps.access(async (_value, write) => {
		await write(undefined);
	});
	const before = f.events.length;
	for (const effect of [
		ensureInternalContextEffects,
		deactivateInternalContextEffects,
		restoreInternalContextEffects,
	])
		expect(
			await effect(request, f.control(), f.mutation, f.deps),
		).toMatchObject({ confirmed: false, value: false });
	f.set({ subscription: simTwo, active: false });
	expect(
		await parkChangedInternalContextEffects(request, f.control(), f.deps),
	).toBe(false);
	expect(f.events.slice(before)).toEqual([]);
});

test("a foreign active edit and a missing consumer receipt preserve the owned cursor without setters", async () => {
	for (const next of [
		{ context: { ...baseline, apn: "foreign.invalid" } },
		{ withdrawn: false },
	]) {
		const f = fixture();
		await ensureInternalContextEffects(
			request,
			f.control(),
			f.mutation,
			f.deps,
		);
		f.set(next);
		const before = f.events.length;
		expect(
			await restoreInternalContextEffects(
				request,
				f.control(),
				f.mutation,
				f.deps,
			),
		).toEqual({ confirmed: true, value: false });
		expect(f.events.slice(before)).toEqual([]);
		expect(f.view().record?.activationOwned).toBe(true);
	}
});

test("a SIM arriving after a restore command can park only its positively observed inverse target", async () => {
	const f = fixture();
	await ensureInternalContextEffects(request, f.control(), f.mutation, f.deps);
	const base = f.control(),
		control: CellularControl = {
			...base,
			defineContext: async (...args) => {
				await base.defineContext(...args);
				f.set({ subscription: simTwo });
			},
		};
	expect(
		await restoreInternalContextEffects(request, control, f.mutation, f.deps),
	).toMatchObject({ confirmed: false, value: false });
	expect(f.view().record?.phase).toBe("restoring");
	const before = f.events.length;
	expect(
		await parkChangedInternalContextEffects(request, f.control(), f.deps),
	).toBe(true);
	expect(f.events.slice(before)).toEqual(["persist-parked"]);
	expect(f.view().record).toMatchObject({ desired: baseline, phase: "parked" });
});

test("loss of the dedicated control connection before dispatch never writes authority", async () => {
	const f = fixture();
	f.set({ controlValid: false });
	expect(
		await ensureInternalContextEffects(
			request,
			f.control(),
			f.mutation,
			f.deps,
		),
	).toEqual({ confirmed: true, value: false });
	expect(f.events).toEqual([]);
});
