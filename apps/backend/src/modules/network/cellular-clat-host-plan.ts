import { z } from "zod";
import type {
	CellularSysctl,
	CellularSysctlValue,
} from "./cellular-host-identity.ts";
import { planCellularRoutes } from "./cellular-route-plan.ts";
import { cellularTunAlias } from "./cellular-tun.ts";

const bit = z.enum(["0", "1"]),
	text = z
		.string()
		.min(1)
		.max(4096)
		.refine((value) =>
			Array.from(value).every(
				(char) =>
					(char.codePointAt(0) ?? 0) >= 32 && char.codePointAt(0) !== 127,
			),
		);
export const cellularClatHostPlanSchema = z
	.object({
		input: z
			.object({
				owner: z.string().regex(/^[a-f0-9]{64}$/),
				epoch: z.string().min(1).max(256),
				slot: z.number().int().min(1).max(32),
				iface: z.string(),
				mtu: z.number().int().min(1280).max(9000),
				ipv6: z.string(),
				ipv6PrefixLength: z.literal(64),
				ipv6Gateway: z.string(),
				nat64: z.string(),
			})
			.strict(),
		physical: z
			.object({
				ifname: z.string(),
				ifindex: z.string().regex(/^[1-9]\d{0,9}$/),
				usbDevice: text,
				netDevice: text,
				generation: z.string().min(1).max(256),
			})
			.strict(),
		tun: z
			.object({
				name: z.string(),
				index: z.number().int().min(1).max(0x7fffffff),
				alias: z.string(),
				persistent: z.literal(true),
			})
			.strict(),
		tunEpoch: z.string().regex(/^[a-f0-9]{64}$/),
		birth: z.string().regex(/^[a-f0-9]{32}$/),
		bootId: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
		globalForwarding: bit,
		physicalBefore: z
			.object({
				accept_ra: z.enum(["0", "1", "2"]),
				accept_ra_defrtr: bit,
				forwarding: bit,
				proxy_ndp: bit,
				force_forwarding: bit,
			})
			.strict(),
		dns: z
			.array(
				z
					.string()
					.ipv6()
					.refine((value) => !value.includes("%")),
			)
			.max(4),
	})
	.strict();
type ParsedPlan = z.infer<typeof cellularClatHostPlanSchema>;
export type CellularClatHostPlan = Readonly<
	Omit<ParsedPlan, "input" | "physical" | "tun" | "physicalBefore" | "dns">
> & {
	readonly input: Readonly<ParsedPlan["input"]>;
	readonly physical: Readonly<ParsedPlan["physical"]>;
	readonly tun: Readonly<ParsedPlan["tun"]>;
	readonly physicalBefore: Readonly<ParsedPlan["physicalBefore"]>;
	readonly dns: readonly string[];
};
export function parseCellularClatHostPlan(raw: unknown): CellularClatHostPlan {
	const value = cellularClatHostPlanSchema.parse(raw),
		route = planCellularRoutes(value.input),
		index = Number(value.physical.ifindex);
	if (
		!route?.translated ||
		value.tun.name !== route.device ||
		value.physical.ifname !== value.input.iface ||
		index > 0x7fffffff ||
		index === value.tun.index ||
		value.tun.alias !== cellularTunAlias(value.input.owner, value.tunEpoch)
	)
		throw new Error("Contradictory CLAT host authority");
	Object.freeze(value.input);
	Object.freeze(value.physical);
	Object.freeze(value.tun);
	Object.freeze(value.physicalBefore);
	Object.freeze(value.dns);
	return Object.freeze(value);
}
export function cellularClatPhysicalSettings(
	plan: CellularClatHostPlan,
): readonly {
	readonly key: CellularSysctl;
	readonly before: CellularSysctlValue;
	readonly desired: CellularSysctlValue;
}[] {
	const original = plan.physicalBefore;
	// Preserve RA reception before setting the physical link's router flag. The
	// default-route RA setting belongs to the existing NM/internal-call owner.
	const settings: {
		key: CellularSysctl;
		before: CellularSysctlValue;
		desired: CellularSysctlValue;
	}[] = [
		{
			key: "accept_ra",
			before: original.accept_ra,
			desired: original.accept_ra === "1" ? "2" : original.accept_ra,
		},
		{ key: "forwarding", before: original.forwarding, desired: "1" },
		{ key: "proxy_ndp", before: original.proxy_ndp, desired: "1" },
		{
			key: "force_forwarding",
			before: original.force_forwarding,
			desired: "1",
		},
	];
	return settings.filter((row) => row.before !== row.desired);
}
export function cellularClatIsolatesPhysical(
	plan: CellularClatHostPlan,
): boolean {
	return (
		plan.globalForwarding === "0" &&
		plan.physicalBefore.force_forwarding === "0"
	);
}

export function cellularClatHostSteps(
	plan: CellularClatHostPlan,
): readonly string[] {
	const routes = planCellularRoutes(plan.input);
	if (!routes?.translated) throw new Error("Translated host required");
	return [
		"receipt",
		"output",
		"forward",
		...cellularClatPhysicalSettings(plan).map(
			(row) => `physical-${row.key.replaceAll("_", "-")}`,
		),
		"tun-configuration",
		"address",
		"proxy",
		"configuration-file",
		...routes.effects.flatMap((row, i) => (row.terminal ? [`ip-${i}`] : [])),
		"translator",
		...routes.effects.flatMap((row, i) => (!row.terminal ? [`ip-${i}`] : [])),
		"forward-active",
	];
}
