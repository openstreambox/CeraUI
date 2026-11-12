import { createHash } from "node:crypto";
import { z } from "zod";
import {
	readPrivateJson,
	writePrivateJson,
} from "../../helpers/private-json-state.ts";
import type { CellularClatHostPlan } from "./cellular-clat-host-plan.ts";

const schema = z
	.object({
		version: z.literal(1),
		owner: z.string().regex(/^[a-f0-9]{64}$/),
		epoch: z.string().min(1).max(256),
		birth: z.string().regex(/^[a-f0-9]{32}$/),
		digest: z.string().regex(/^[a-f0-9]{64}$/),
		tunConfigurationStarted: z.boolean(),
		translatorSubmitted: z.boolean(),
		invocation: z
			.string()
			.regex(/^[a-f0-9]{32}$/)
			.optional(),
	})
	.strict()
	.refine(
		(value) => value.invocation === undefined || value.translatorSubmitted,
	);
export type CellularClatReceiptValue = z.infer<typeof schema>;
export function cellularClatReceiptKey(plan: CellularClatHostPlan): string {
	return createHash("sha256")
		.update(`cellular-clat-receipt\0${plan.input.slot}\0${plan.birth}`)
		.digest("hex");
}
export function parseCellularClatReceipt(
	raw: unknown,
	plan: CellularClatHostPlan,
): CellularClatReceiptValue {
	const value = schema.parse(raw),
		digest = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
	if (
		value.owner !== plan.input.owner ||
		value.epoch !== plan.input.epoch ||
		value.birth !== plan.birth ||
		value.digest !== digest
	)
		throw new Error("CLAT effect receipt authority changed");
	return value;
}
/** Auxiliary effect results stay bound to the immutable parent plan. A start
 * attempt is durable before submission, and cannot be spent twice for a birth.
 * The parent cursor owns creation/removal; this helper has no recovery loop.
 */
export class CellularClatReceipt {
	readonly key: string;
	private readonly digest: string;
	constructor(
		private readonly plan: CellularClatHostPlan,
		private readonly store: { readonly dir: string },
		private readonly writable: () => boolean,
	) {
		this.digest = createHash("sha256")
			.update(JSON.stringify(plan))
			.digest("hex");
		this.key = cellularClatReceiptKey(plan);
	}
	async read(): Promise<CellularClatReceiptValue | undefined> {
		const raw = await readPrivateJson(this.store, this.key);
		if (raw === undefined) return undefined;
		return parseCellularClatReceipt(raw, this.plan);
	}
	async create(): Promise<void> {
		if (
			!this.writable() ||
			(await this.read()) !== undefined ||
			!this.writable()
		)
			throw new Error("CLAT receipt birth unavailable");
		await writePrivateJson(this.store, this.key, {
			version: 1,
			owner: this.plan.input.owner,
			epoch: this.plan.input.epoch,
			birth: this.plan.birth,
			digest: this.digest,
			tunConfigurationStarted: false,
			translatorSubmitted: false,
		});
	}
	private async update(
		change: (before: CellularClatReceiptValue) => CellularClatReceiptValue,
	): Promise<void> {
		if (!this.writable()) throw new Error("CLAT receipt lease retired");
		const before = await this.read();
		if (!before || !this.writable())
			throw new Error("CLAT receipt unavailable");
		await writePrivateJson(this.store, this.key, schema.parse(change(before)));
	}
	markTunConfiguration(started: boolean): Promise<void> {
		return this.update((value) => ({
			...value,
			tunConfigurationStarted: started,
		}));
	}
	markTranslatorSubmission(): Promise<void> {
		return this.update((value) => {
			if (value.translatorSubmitted)
				throw new Error("Translator birth was already submitted");
			return { ...value, translatorSubmitted: true };
		});
	}
	rememberInvocation(invocation: string): Promise<void> {
		return this.update((value) => {
			if (
				!value.translatorSubmitted ||
				(value.invocation !== undefined && value.invocation !== invocation)
			)
				throw new Error("Translator invocation authority changed");
			return { ...value, invocation };
		});
	}
	async remove(): Promise<void> {
		if (!this.writable()) throw new Error("CLAT receipt lease retired");
		if ((await this.read()) === undefined) return;
		if (!this.writable()) throw new Error("CLAT receipt lease retired");
		await writePrivateJson(this.store, this.key, undefined);
	}
}
