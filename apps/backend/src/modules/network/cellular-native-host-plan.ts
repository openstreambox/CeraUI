import { createHash } from "node:crypto";
import { z } from "zod";
import {
	type CellularRoutePlan,
	planCellularRoutes,
} from "./cellular-route-plan.ts";

const schema = z
	.object({
		input: z
			.object({
				owner: z.string().regex(/^[a-f0-9]{64}$/),
				epoch: z.string().min(1).max(256),
				slot: z.number().int().min(1).max(32),
				iface: z.string(),
				mtu: z.number().int(),
				ipv4: z.string(),
				ipv4Gateway: z.string().optional(),
			})
			.strict(),
		ifindex: z.number().int().min(1).max(0x7fffffff),
		bootId: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
		dns: z.array(z.string().ipv4()).max(4),
	})
	.strict();
type ParsedPlan = z.infer<typeof schema>;
export type CellularNativeHostPlan = Readonly<
	Omit<ParsedPlan, "input" | "dns">
> & {
	readonly input: Readonly<ParsedPlan["input"]>;
	readonly dns: readonly string[];
};
export function parseCellularNativeHostPlan(
	raw: unknown,
): CellularNativeHostPlan {
	const value = schema.parse(raw);
	nativeRoutes(value);
	Object.freeze(value.input);
	Object.freeze(value.dns);
	return Object.freeze(value);
}
export function cellularNativeHostSteps(
	plan: CellularNativeHostPlan,
): readonly string[] {
	return [
		"fence",
		...nativeRoutes(plan).effects.map((_effect, index) => `ip-${index}`),
	];
}
export function cellularUplinkSlotKey(slot: number): string {
	if (!Number.isInteger(slot) || slot < 1 || slot > 32)
		throw new Error("Invalid cellular host slot");
	return createHash("sha256")
		.update(`cellular-uplink-slot\0${slot}`)
		.digest("hex");
}
function nativeRoutes(value: CellularNativeHostPlan): CellularRoutePlan {
	const { ipv4Gateway, ...input } = value.input;
	const plan = planCellularRoutes({
		...input,
		...(ipv4Gateway !== undefined ? { ipv4Gateway } : {}),
	});
	if (!plan || plan.translated) throw new Error("Native grant required");
	return plan;
}
