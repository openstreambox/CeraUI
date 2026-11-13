import { z } from "zod";
import {
	DurableInverse,
	type DurableInverseRecord,
} from "../../helpers/durable-inverse.ts";
import { setLinkUpByIndex } from "../../helpers/link-up-by-index.ts";
import { run } from "../../helpers/run.ts";
import {
	type CellularPhysicalLink,
	cellularPhysicalResourceState,
	cellularPhysicalState,
	compareAndSetCellularSysctl,
	readCellularSysctl,
} from "./cellular-host-identity.ts";
import type {
	CellularNmControl,
	CellularNmDevice,
} from "./cellular-nm-control.ts";
import { cellularNmHandoffRestored } from "./cellular-nm-handoff-observation.ts";
import { isSafeIfname } from "./safe-ifname.ts";

const bootSchema = z
	.string()
	.regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const linkSchema = z
	.object({
		ifname: z.string().refine(isSafeIfname),
		ifindex: z.string().regex(/^[1-9]\d{0,9}$/),
		usbDevice: z.string().min(1).max(4096),
		netDevice: z.string().min(1).max(4096),
		generation: z.string().min(1).max(256),
	})
	.strict();
const deviceSchema = z
	.object({
		path: z
			.string()
			.regex(/^\/org\/freedesktop\/NetworkManager\/Devices\/\d+$/),
		udi: z.string().min(1).max(4096),
		iface: z.string().refine(isSafeIfname),
		ipIface: z.string().refine((value) => value === "" || isSafeIfname(value)),
		managed: z.boolean(),
	})
	.strict();
const planSchema = z
	.object({
		version: z.literal(1),
		bootId: bootSchema,
		link: linkSchema,
		nmOwner: z.string().regex(/^:\d+\.\d+$/),
		device: deviceSchema,
		raDefault: z.enum(["0", "1"]),
		up: z.boolean(),
	})
	.strict();
export type CellularHandoffPlan = z.infer<typeof planSchema>;
export function parseCellularHandoffPlan(raw: unknown): CellularHandoffPlan {
	const plan = planSchema.parse(raw);
	if (
		plan.device.iface !== plan.link.ifname ||
		!["", plan.link.ifname].includes(plan.device.ipIface) ||
		plan.device.udi.startsWith("/org/freedesktop/ModemManager1/")
	)
		throw new Error("Host handoff authority belongs to another device");
	return plan;
}
export function parseCellularHandoffPhysicalLink(
	raw: unknown,
): CellularPhysicalLink {
	return linkSchema.parse(raw);
}
type Record = DurableInverseRecord<CellularHandoffPlan>;
export interface CellularHandoffIO {
	readonly present: () => Promise<boolean>;
	readonly resourceState: (
		bootId: string,
	) => ReturnType<typeof cellularPhysicalResourceState>;
	readonly nmRestored: (device: CellularNmDevice) => Promise<boolean>;
	readonly readRaDefault: () => Promise<"0" | "1" | undefined>;
	readonly setRaDefault: (
		expected: "0" | "1",
		desired: "0" | "1",
	) => Promise<boolean>;
	readonly readUp: () => Promise<boolean | undefined>;
	readonly setUp: (expected: boolean, desired: boolean) => Promise<boolean>;
	readonly nm: CellularNmControl;
}
export function cellularHandoffIO(
	link: CellularPhysicalLink,
	nm: CellularNmControl,
	bootId: string,
): CellularHandoffIO {
	link = Object.freeze({ ...link });
	bootSchema.parse(bootId);
	const present = async () => (await cellularPhysicalState(link)) === "present";
	const readUp = async () => {
		if (!(await present())) return undefined;
		const rows: unknown = JSON.parse(
			await run("ip", ["-j", "link", "show", "dev", link.ifname], {
				timeout: 4000,
				maxBuffer: 16 * 1024,
			}),
		);
		if (
			!Array.isArray(rows) ||
			rows.length !== 1 ||
			rows[0]?.ifname !== link.ifname ||
			String(rows[0]?.ifindex) !== link.ifindex ||
			!Array.isArray(rows[0]?.flags) ||
			!rows[0].flags.every((flag: unknown) => typeof flag === "string") ||
			!(await present())
		)
			return undefined;
		return rows[0].flags.includes("UP");
	};
	return {
		present,
		resourceState: (originalBoot) =>
			cellularPhysicalResourceState(link, originalBoot === bootId),
		nmRestored: cellularNmHandoffRestored,
		nm,
		readUp,
		readRaDefault: async () => {
			const value = await readCellularSysctl(link, "accept_ra_defrtr");
			return value === "0" || value === "1" ? value : undefined;
		},
		setRaDefault: (expected, desired) =>
			compareAndSetCellularSysctl(link, "accept_ra_defrtr", expected, desired),
		setUp: async (expected, desired) => {
			const before = await readUp();
			if (before !== expected && before !== desired) return false;
			if (
				before !== desired &&
				!(await setLinkUpByIndex(Number(link.ifindex), desired))
			)
				return false;
			return (await readUp()) === desired;
		},
	};
}
export interface CellularHandoffHooks {
	readonly bootId: string;
	readonly read: () => Promise<unknown>;
	readonly write: (record: Record | undefined) => Promise<void>;
	readonly current: () => Promise<boolean>;
	readonly withdraw: () => void;
	readonly fence: () => Promise<void>;
	readonly consumersReleased: () => Promise<boolean>;
}
const sameDevice = (a: CellularNmDevice, b: CellularNmDevice) =>
	a.path === b.path &&
	a.udi === b.udi &&
	a.iface === b.iface &&
	["", a.iface].includes(a.ipIface) &&
	["", a.iface].includes(b.ipIface);
export function cellularHandoffSteps(plan: CellularHandoffPlan): string[] {
	return [
		...(plan.raDefault === "1" ? ["ra-default"] : []),
		...(plan.device.managed ? ["nm-unmanaged"] : []),
		...(!plan.up ? ["link-up"] : []),
	];
}
/** Host part of the retained RNDIS handoff. The caller holds the existing modem
 * lifecycle admission for mutations and a kernel state lease for this slot.
 * Capture first, suppress RA defaults, disarm the physical NM device, then allow
 * inhibition. Link-up is a separate stage before the internal data call.
 */
export class CellularHostHandoff {
	private readonly inverse: DurableInverse<CellularHandoffPlan>;
	private readonly bootId: string;
	constructor(
		readonly owner: string,
		readonly epoch: string,
		readonly link: CellularPhysicalLink,
		private readonly io: CellularHandoffIO,
		private readonly hooks: CellularHandoffHooks,
	) {
		link = Object.freeze({ ...link });
		this.link = link;
		this.bootId = bootSchema.parse(hooks.bootId);
		this.inverse = new DurableInverse({
			read: hooks.read,
			write: hooks.write,
			parsePlan: (raw) => {
				const plan = parseCellularHandoffPlan(raw);
				if (
					["ifname", "ifindex", "usbDevice", "netDevice", "generation"].some(
						(key) =>
							plan.link[key as keyof CellularPhysicalLink] !==
							link[key as keyof CellularPhysicalLink],
					)
				)
					throw new Error("Host handoff authority belongs to another device");
				return plan;
			},
			steps: cellularHandoffSteps,
			current: async (record) =>
				record.owner === owner &&
				record.epoch === epoch &&
				record.plan.bootId === this.bootId &&
				(await hooks.current()) &&
				(await io.present()) &&
				io.nm.valid(),
			inspect: (record, step) => this.inspect(record.plan, step),
			apply: async (record, step) => {
				if (!(await this.effect(record.plan, step, false)))
					throw new Error("Host handoff did not verify");
			},
			remove: async (record, step) => {
				if (!(await this.effect(record.plan, step, true)))
					throw new Error("Host handoff inverse did not verify");
			},
			withdraw: hooks.withdraw,
			fence: hooks.fence,
			consumersReleased: hooks.consumersReleased,
		});
	}
	private async inspect(
		plan: CellularHandoffPlan,
		step: string,
	): Promise<"absent" | "owned" | "foreign"> {
		// A complete old-index absence retires kernel effects without touching a
		// reused name. NM has a separate observation and never inherits this proof.
		if (step !== "nm-unmanaged") {
			const resource = await this.io.resourceState(plan.bootId);
			if (resource === "absent") return "absent";
			if (resource !== "present" || !(await this.io.present()))
				return "foreign";
		}
		if (step === "ra-default") {
			const value = await this.io.readRaDefault();
			return value === "0"
				? "owned"
				: value === plan.raDefault
					? "absent"
					: "foreign";
		}
		if (step === "link-up") {
			const value = await this.io.readUp();
			return value === true
				? "owned"
				: value === plan.up
					? "absent"
					: "foreign";
		}
		if (
			step === "nm-unmanaged" &&
			plan.bootId === this.bootId &&
			this.io.nm.owner === plan.nmOwner &&
			this.io.nm.valid() &&
			(await this.io.present())
		) {
			try {
				const value = await this.io.nm.read(plan.device);
				if (value && sameDevice(value, plan.device))
					return !value.managed
						? "owned"
						: value.managed === plan.device.managed
							? "absent"
							: "foreign";
			} catch {
				/* Independent read-only census below must prove restoration. */
			}
		}
		if (step === "nm-unmanaged" && (await this.io.nmRestored(plan.device)))
			return "absent";
		return "foreign";
	}
	private async effect(
		plan: CellularHandoffPlan,
		step: string,
		restore: boolean,
	): Promise<boolean> {
		if (plan.bootId !== this.bootId || !(await this.io.present())) return false;
		if (step === "ra-default")
			return this.io.setRaDefault(
				restore ? "0" : plan.raDefault,
				restore ? plan.raDefault : "0",
			);
		if (step === "link-up")
			return this.io.setUp(restore ? true : plan.up, restore ? plan.up : true);
		if (step === "nm-unmanaged" && this.io.nm.owner === plan.nmOwner)
			return this.io.nm.setManaged(
				plan.device,
				restore ? false : plan.device.managed,
				restore ? plan.device.managed : false,
			);
		return false;
	}
	async prepare(): Promise<void> {
		const existing = await this.inverse.read();
		if (existing) {
			if (
				existing.owner !== this.owner ||
				existing.epoch !== this.epoch ||
				existing.phase === "withdrawing"
			)
				throw new Error("Host handoff slot remains owned");
			await this.inverse.advance(
				this.owner,
				this.epoch,
				cellularHandoffSteps(existing.plan).filter((step) => step !== "link-up")
					.length,
			);
			return;
		}
		if (
			!(await this.hooks.current()) ||
			!(await this.io.present()) ||
			this.io.nm.devices.length !== 1
		)
			throw new Error("Host handoff unavailable");
		const selected = this.io.nm.devices[0];
		if (!selected) throw new Error("Host NM baseline unavailable");
		const device = await this.io.nm.read(selected);
		const raDefault = await this.io.readRaDefault(),
			up = await this.io.readUp();
		if (!device || raDefault === undefined || up === undefined)
			throw new Error("Host baseline unreadable");
		const plan: CellularHandoffPlan = {
			version: 1,
			bootId: this.bootId,
			link: this.link,
			nmOwner: this.io.nm.owner,
			device,
			raDefault,
			up,
		};
		await this.inverse.create(
			this.owner,
			this.epoch,
			plan,
			cellularHandoffSteps(plan).filter((step) => step !== "link-up").length,
		);
	}
	async prepareCall(): Promise<void> {
		await this.inverse.advance(this.owner, this.epoch);
		if (
			!(await this.io.present()) ||
			(await this.io.readUp()) !== true ||
			(await this.io.readRaDefault()) !== "0"
		)
			throw new Error("Internal call host guard lost");
	}
	cleanup(): Promise<boolean> {
		return this.inverse.cleanup(this.owner, this.epoch);
	}
}
