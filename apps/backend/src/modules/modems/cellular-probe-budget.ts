import { createHash } from "node:crypto";
import { z } from "zod";
import {
	readPrivateJson,
	writePrivateJson,
} from "../../helpers/private-json-state.ts";
import { acquirePrivateStateLease } from "../../helpers/private-state-lease.ts";

const recordSchema = z
	.object({
		version: z.literal(1),
		owner: z.string().regex(/^[a-f0-9]{64}$/),
		day: z.number().int().min(0),
		used: z
			.number()
			.int()
			.min(0)
			.max(64 * 1024 * 1024),
		lastReset: z.number().int().min(0),
		lastReservation: z.number().int().min(0),
	})
	.strict();
export type CellularBudgetRecord = z.infer<typeof recordSchema>;
export interface CellularBudgetDeps {
	readonly now: () => number;
	readonly acquire: () => Promise<{ release(): void } | undefined>;
	readonly read: () => Promise<unknown>;
	readonly write: (record: CellularBudgetRecord) => Promise<void>;
}
/** Conservative reservations, never refunded after an ambiguous exit. The pair
 * key survives interface/SIM-slot renumbering, USB resets and process restarts.
 * These are probe allowances, not certified operator billing measurements.
 */
export class CellularProbeBudget {
	constructor(
		readonly owner: string,
		readonly dailyBytes: number,
		private readonly deps: CellularBudgetDeps,
	) {
		if (
			!/^[a-f0-9]{64}$/.test(owner) ||
			!Number.isInteger(dailyBytes) ||
			dailyBytes < 0 ||
			dailyBytes > 64 * 1024 * 1024
		)
			throw new Error("Invalid cellular probe allowance");
	}
	async reserve(bytes: number): Promise<{ remaining: number } | undefined> {
		if (!Number.isInteger(bytes) || bytes <= 0 || bytes > this.dailyBytes)
			return undefined;
		const lease = await this.deps.acquire();
		if (!lease) return undefined;
		try {
			const now = this.deps.now();
			if (!Number.isSafeInteger(now) || now < 0)
				throw new Error("Unknown budget clock");
			const day = Math.floor(now / 86_400_000),
				saved = await this.deps.read();
			let record =
				saved === undefined
					? {
							version: 1 as const,
							owner: this.owner,
							day,
							used: 0,
							lastReset: now,
							lastReservation: now,
						}
					: recordSchema.parse(saved);
			if (record.owner !== this.owner)
				throw new Error("Budget belongs to another subscription pair");
			// A backward clock cannot mint a new day; rapid forward/back adjustments
			// cannot repeatedly reset an allowance either.
			if (now < record.lastReservation || day < record.day) return undefined;
			if (day > record.day && now - record.lastReset >= 20 * 3_600_000)
				record = { ...record, day, used: 0, lastReset: now };
			if (record.used + bytes > this.dailyBytes) return undefined;
			record = { ...record, used: record.used + bytes, lastReservation: now };
			await this.deps.write(record);
			return { remaining: Math.max(0, this.dailyBytes - record.used) };
		} finally {
			lease.release();
		}
	}
}
export function privateCellularProbeBudget(
	owner: string,
	store: { readonly dir: string },
	dailyBytes = 8 * 1024 * 1024,
): CellularProbeBudget {
	const key = createHash("sha256")
		.update(`cellular-probe-budget\0${owner}`)
		.digest("hex");
	return new CellularProbeBudget(owner, dailyBytes, {
		now: Date.now,
		acquire: () => acquirePrivateStateLease(store, key),
		read: () => readPrivateJson(store, key),
		write: (record) => writePrivateJson(store, key, record),
	});
}
