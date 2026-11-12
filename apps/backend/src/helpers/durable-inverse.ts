import { z } from "zod";
import { readPrivateJson, writePrivateJson } from "./private-json-state.ts";

const envelope = z
	.object({
		version: z.literal(1),
		owner: z.string().regex(/^[a-f0-9]{64}$/),
		epoch: z.string().min(1).max(256),
		plan: z.unknown(),
		steps: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/)).max(64),
		cursor: z.number().int().min(0).max(64),
		phase: z.enum(["applying", "active", "withdrawing"]),
	})
	.strict();
export interface DurableInverseRecord<T> {
	readonly version: 1;
	readonly owner: string;
	readonly epoch: string;
	readonly plan: T;
	readonly steps: readonly string[];
	readonly cursor: number;
	readonly phase: "applying" | "active" | "withdrawing";
}
/** Shared strict recovery boundary; inventory and live owners accept the same bytes. */
export function parseDurableInverseRecord<T>(
	raw: unknown,
	parsePlan: (raw: unknown) => T,
	planSteps: (plan: T) => readonly string[],
): DurableInverseRecord<T> {
	const parsed = envelope.parse(raw),
		plan = parsePlan(parsed.plan);
	const steps = planSteps(plan);
	if (
		parsed.cursor > steps.length ||
		(parsed.phase === "active" && parsed.cursor !== steps.length) ||
		JSON.stringify(parsed.steps) !== JSON.stringify(steps) ||
		new Set(steps).size !== steps.length
	)
		throw new Error("Unrecognized inverse authority");
	return { ...parsed, plan };
}
export interface DurableInverseDeps<T> {
	readonly read: () => Promise<unknown>;
	readonly write: (
		record: DurableInverseRecord<T> | undefined,
	) => Promise<void>;
	readonly parsePlan: (plan: unknown) => T;
	/** Must be deterministic for this persisted version; no live input or discovery. */
	readonly steps: (plan: T) => readonly string[];
	readonly current: (record: DurableInverseRecord<T>) => Promise<boolean>;
	readonly inspect: (
		record: DurableInverseRecord<T>,
		step: string,
	) => Promise<"absent" | "owned" | "foreign">;
	readonly apply: (
		record: DurableInverseRecord<T>,
		step: string,
	) => Promise<void>;
	readonly remove: (
		record: DurableInverseRecord<T>,
		step: string,
	) => Promise<void>;
	readonly withdraw: (record: DurableInverseRecord<T>) => void;
	/** Commit a data-plane deny fence before waiting for producer socket closure. */
	readonly fence: (record: DurableInverseRecord<T>) => Promise<void>;
	/** Actual consumer acknowledgement, never a timer standing in for closed FDs. */
	readonly consumersReleased: (
		record: DurableInverseRecord<T>,
	) => Promise<boolean>;
}
/** Caller holds the kernel state lease for each whole transaction. All authority
 * precedes effects. An uncertain reply remains in the inverse cursor. Cleanup
 * neither flushes resources nor treats a foreign replacement as ours.
 */
export class DurableInverse<T> {
	constructor(private readonly deps: DurableInverseDeps<T>) {}
	async read(): Promise<DurableInverseRecord<T> | undefined> {
		const raw = await this.deps.read();
		if (raw === undefined) return undefined;
		return parseDurableInverseRecord(raw, this.deps.parsePlan, this.deps.steps);
	}
	async create(
		owner: string,
		epoch: string,
		plan: T,
		stopAfter?: number,
	): Promise<DurableInverseRecord<T>> {
		if (await this.read()) throw new Error("Inverse slot remains owned");
		const parsedPlan = this.deps.parsePlan(plan);
		const steps = this.deps.steps(parsedPlan);
		if (
			stopAfter !== undefined &&
			(!Number.isInteger(stopAfter) ||
				stopAfter < 0 ||
				stopAfter > steps.length)
		)
			throw new Error("Invalid inverse stage");
		envelope.parse({
			version: 1,
			owner,
			epoch,
			plan,
			steps,
			cursor: 0,
			phase: "applying",
		});
		if (new Set(steps).size !== steps.length)
			throw new Error("Ambiguous inverse steps");
		const record: DurableInverseRecord<T> = {
			version: 1,
			owner,
			epoch,
			plan: parsedPlan,
			steps: [...steps],
			cursor: 0,
			phase: "applying",
		};
		if (!(await this.deps.current(record)))
			throw new Error("Inverse identity changed");
		// A preexisting matching tuple is foreign until this transaction recorded an
		// absent baseline. Never adopt another owner's route/address/process.
		for (const step of steps)
			if ((await this.deps.inspect(record, step)) !== "absent")
				throw new Error("Inverse resource slot occupied");
		await this.deps.write(record);
		return this.advanceRecord(record, stopAfter ?? steps.length);
	}
	/** Continue an intentionally staged transaction only while its live owner is
	 * still current. Startup recovery cleans interrupted stages; it never resumes
	 * a hardware effect merely because a cursor was retained on disk.
	 */
	async advance(
		owner: string,
		epoch: string,
		stopAfter?: number,
	): Promise<DurableInverseRecord<T>> {
		const record = await this.read();
		if (
			!record ||
			record.owner !== owner ||
			record.epoch !== epoch ||
			record.phase === "withdrawing"
		)
			throw new Error("Staged inverse owner unavailable");
		return this.advanceRecord(record, stopAfter ?? record.steps.length);
	}
	private async advanceRecord(
		before: DurableInverseRecord<T>,
		stopAfter: number,
	): Promise<DurableInverseRecord<T>> {
		if (
			!Number.isInteger(stopAfter) ||
			stopAfter < 0 ||
			stopAfter > before.steps.length
		)
			throw new Error("Invalid inverse stage");
		let record = before;
		if (!(await this.deps.current(record)))
			throw new Error("Inverse identity changed");
		for (const step of record.steps.slice(0, record.cursor))
			if ((await this.deps.inspect(record, step)) !== "owned")
				throw new Error("Applied inverse stage changed");
		while (record.cursor < stopAfter) {
			const step = record.steps[record.cursor];
			if (
				!step ||
				!(await this.deps.current(record)) ||
				(await this.deps.inspect(record, step)) !== "absent"
			)
				throw new Error("Inverse resource changed before apply");
			record = { ...record, cursor: record.cursor + 1 };
			await this.deps.write(record);
			await this.deps.apply(record, step);
			if (
				!(await this.deps.current(record)) ||
				(await this.deps.inspect(record, step)) !== "owned"
			)
				throw new Error("Inverse effect did not verify");
		}
		if (record.cursor === record.steps.length && record.phase !== "active") {
			record = { ...record, phase: "active" };
			await this.deps.write(record);
		}
		return record;
	}

	async cleanup(owner: string, epoch: string): Promise<boolean> {
		let record = await this.read();
		if (!record) {
			await this.deps.write(undefined);
			return true;
		}
		if (record.owner !== owner || record.epoch !== epoch) return false;
		this.deps.withdraw(record);
		record = { ...record, phase: "withdrawing" };
		await this.deps.write(record);
		await this.deps.fence(record);
		if (!(await this.deps.consumersReleased(record))) return false;
		while (record.cursor > 0) {
			const step = record.steps[record.cursor - 1];
			if (!step) throw new Error("Missing inverse step");
			const state = await this.deps.inspect(record, step);
			if (state === "foreign") return false;
			if (state === "owned") {
				await this.deps.remove(record, step);
				if ((await this.deps.inspect(record, step)) !== "absent") return false;
			}
			record = { ...record, cursor: record.cursor - 1 };
			await this.deps.write(record);
		}
		await this.deps.write(undefined);
		return true;
	}
}
export function privateInverseStore(
	store: { readonly dir: string },
	key: string,
) {
	return {
		read: () => readPrivateJson(store, key),
		write: (record: unknown) => writePrivateJson(store, key, record),
	};
}
