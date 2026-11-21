import { isIPv4 } from "node:net";
import { z } from "zod";

const ifname = z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,14}$/);
const mac = z
	.string()
	.regex(/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/)
	.refine((s) => s !== "00:00:00:00:00:00");
const ip = z
	.string()
	.refine((s) => isIPv4(s) && !s.startsWith("127.") && s !== "0.0.0.0");
const radioSchema = z
	.object({
		deviceId: z.number().int().nonnegative(),
		permanentMac: mac,
		ifname,
		profileUuid: z.uuid(),
		mode: z.literal("infrastructure"),
	})
	.readonly();
// D-Bus GetId + the unique NM bus owner, NOT a cached profile UUID or local counter.
const epochSchema = z
	.object({
		busId: z.string().regex(/^[0-9a-f]{32}$/),
		nmOwner: z.string().regex(/^:\d+\.\d+$/),
	})
	.readonly();
const activationSchema = z
	.object({
		ifname,
		profileUuid: z.uuid(),
		activationPath: z
			.string()
			.regex(/^\/org\/freedesktop\/NetworkManager\/ActiveConnection\/\d+$/),
		stationMac: mac,
		bssid: mac,
	})
	.readonly();
const linkSchema = z
	.object({
		ifname,
		ifindex: z.number().int().positive(),
		physicalPath: z
			.string()
			.max(1024)
			.regex(/^\/sys\/devices\/[a-zA-Z0-9_./:-]+$/)
			.refine((s) => !s.split("/").includes("..")),
		permanentMac: mac,
		stationMac: mac,
		address: ip,
		gateway: ip,
		dnsServers: z.array(ip).min(1).max(8).readonly(),
		prefixLength: z.number().int().min(1).max(32),
		routeTable: z.number().int().positive(),
		routeMetric: z.number().int().nonnegative(),
	})
	.readonly();
const bindingSchema = z
	.object({
		radio: radioSchema,
		epoch: epochSchema,
		activation: activationSchema,
		link: linkSchema,
	})
	.refine(
		({ radio, activation, link }) =>
			radio.ifname === activation.ifname &&
			radio.ifname === link.ifname &&
			radio.permanentMac === link.permanentMac &&
			radio.profileUuid === activation.profileUuid &&
			activation.stationMac === link.stationMac,
	)
	.readonly();

export type PortalBinding = z.infer<typeof bindingSchema>;
export type PortalCapture =
	| { readonly ok: true; readonly binding: PortalBinding }
	| {
			readonly ok: false;
			readonly reason: "identity_unavailable" | "binding_changed";
	  };
export interface PortalBindingReaders {
	/** Fresh authoritative bus ID and NM unique owner; absent means unavailable. */
	readEpoch(): Promise<unknown>;
	readActivation(ifname: string): Promise<unknown>;
	readLink(ifname: string): Promise<unknown>;
}
const same = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);

/** Read-only capture. Readers must bracket their own underlying authority; no native defaults. */
export async function capturePortalBinding(
	readRadio: () => unknown,
	readers: PortalBindingReaders,
): Promise<PortalCapture> {
	const changed = Symbol();
	try {
		const radio = radioSchema.parse(readRadio());
		const check = () => {
			if (!same(radio, radioSchema.parse(readRadio()))) throw changed;
		};
		const read = async (fn: () => Promise<unknown>) => {
			check();
			const value = await fn();
			check();
			return value;
		};
		const epoch = epochSchema.parse(await read(() => readers.readEpoch()));
		const activation = activationSchema.parse(
			await read(() => readers.readActivation(radio.ifname)),
		);
		const link = linkSchema.parse(
			await read(() => readers.readLink(radio.ifname)),
		);
		const epoch2 = epochSchema.parse(await read(() => readers.readEpoch()));
		const activation2 = activationSchema.parse(
			await read(() => readers.readActivation(radio.ifname)),
		);
		const link2 = linkSchema.parse(
			await read(() => readers.readLink(radio.ifname)),
		);
		const epoch3 = epochSchema.parse(await read(() => readers.readEpoch()));
		if (
			!same(epoch, epoch2) ||
			!same(epoch, epoch3) ||
			!same(activation, activation2) ||
			!same(link, link2)
		)
			throw changed;
		return {
			ok: true,
			binding: bindingSchema.parse({ radio, epoch, activation, link }),
		};
	} catch (error) {
		return {
			ok: false,
			reason: error === changed ? "binding_changed" : "identity_unavailable",
		};
	}
}

export type PortalPhase =
	| "unavailable"
	| "prepared"
	| "opening"
	| "unconfirmed"
	| "verification-required"
	| "closing"
	| "closed";
export type PortalReason =
	| "broker_unavailable"
	| "identity_unavailable"
	| "binding_changed"
	| "owner_mismatch"
	| "superseded"
	| "cancelled"
	| "expired"
	| "replaced"
	| "broker_failed"
	| "cleanup_unknown"
	| "interaction_incomplete"
	| "invalid_clock";
export type PortalStatus = Readonly<{
	phase: PortalPhase;
	reason?: PortalReason;
}>;
/** Opaque in-process resource identity, never a wire token. */
export type PortalHandle = Readonly<object>;
export interface PortalBroker {
	open(
		binding: PortalBinding,
		handle: PortalHandle,
	): Promise<"portal-completed" | "not-completed">;
	/** True explicitly acknowledges that this handle can no longer own resources. */
	stop(handle: PortalHandle): Promise<boolean>;
}
export interface PortalSessionDeps {
	capture(): Promise<PortalCapture>;
	now(): number;
	armExpiry(delayMs: number, expire: () => void): () => void;
	ttlMs: number;
	broker?: PortalBroker;
}
interface Lease {
	owner: object;
	handle: PortalHandle;
	binding: PortalBinding;
	expiresAt: number;
	phase: PortalPhase;
	reason?: PortalReason;
	stopping: boolean;
	disarm: () => void;
}
const status = (phase: PortalPhase, reason?: PortalReason): PortalStatus =>
	Object.freeze(reason ? { phase, reason } : { phase });

/** Private portal consumer only: no radio control, traffic policy, logging or health setter. */
export function createCaptivePortalSession(deps: PortalSessionDeps) {
	const broker = deps.broker;
	let lease: Lease | undefined;
	let preparing: { owner: object; ticket: object } | undefined;
	const clock = () => {
		const now = deps.now();
		if (!Number.isFinite(now) || now < 0) throw new Error();
		return now;
	};
	const close = (current: Lease, reason: PortalReason) => {
		if (lease !== current || current.phase === "closed") return;
		if (current.phase !== "closing") {
			current.phase = "closing";
			current.reason = reason;
			try {
				current.disarm();
			} catch {
				current.reason = "cleanup_unknown";
			}
		}
		if (current.stopping) return;
		current.stopping = true;
		void (async () => {
			try {
				const acknowledged = await broker?.stop(current.handle);
				if (lease !== current) return;
				current.phase = acknowledged === true ? "closed" : "closing";
				current.reason = acknowledged === true ? reason : "cleanup_unknown";
			} catch {
				if (lease === current) current.reason = "cleanup_unknown";
			} finally {
				current.stopping = false;
			}
		})();
	};
	const view = (current: Lease) => status(current.phase, current.reason);
	const expired = (current: Lease) => {
		try {
			if (clock() >= current.expiresAt) close(current, "expired");
		} catch {
			close(current, "invalid_clock");
		}
		return current.phase === "closing" || current.phase === "closed";
	};
	const currentBinding = async (current: Lease) => {
		if (lease !== current || current.phase !== "opening") return false;
		try {
			const captured = await deps.capture();
			if (lease !== current || current.phase !== "opening") return false;
			if (
				!captured.ok ||
				!same(current.binding, bindingSchema.parse(captured.binding))
			) {
				close(current, "binding_changed");
				return false;
			}
			return !expired(current);
		} catch {
			close(current, "identity_unavailable");
			return false;
		}
	};
	return {
		async prepare(owner: object): Promise<PortalStatus> {
			if (!broker) return status("unavailable", "broker_unavailable");
			if (
				(lease && lease.phase !== "closed" && lease.owner !== owner) ||
				(preparing && preparing.owner !== owner)
			)
				return status("unavailable", "owner_mismatch");
			if (lease && lease.phase !== "closed") {
				close(lease, "replaced");
				return view(lease);
			}
			const ticket = {};
			preparing = { owner, ticket };
			try {
				const captured = await deps.capture();
				if (preparing?.ticket !== ticket)
					return status("unavailable", "superseded");
				if (!captured.ok)
					return status(
						"unavailable",
						captured.reason === "binding_changed"
							? "binding_changed"
							: "identity_unavailable",
					);
				if (
					!Number.isFinite(deps.ttlMs) ||
					deps.ttlMs <= 0 ||
					deps.ttlMs > 300_000
				)
					return status("unavailable", "invalid_clock");
				const current: Lease = {
					owner,
					handle: Object.freeze({}),
					binding: bindingSchema.parse(captured.binding),
					expiresAt: clock() + deps.ttlMs,
					phase: "prepared",
					stopping: false,
					disarm: () => undefined,
				};
				lease = current;
				try {
					current.disarm = deps.armExpiry(deps.ttlMs, () =>
						close(current, "expired"),
					);
				} catch {
					close(current, "invalid_clock");
				}
				return view(current);
			} catch {
				return status("unavailable", "identity_unavailable");
			} finally {
				if (preparing?.ticket === ticket) preparing = undefined;
			}
		},
		async dispatch(owner: object): Promise<PortalStatus> {
			const current = lease;
			if (!current || current.owner !== owner)
				return status("unavailable", "owner_mismatch");
			if (expired(current) || current.phase !== "prepared")
				return view(current);
			current.phase = "opening";
			if (!(await currentBinding(current)))
				return lease === current
					? view(current)
					: status("unavailable", "superseded");
			try {
				const result = await broker?.open(current.binding, current.handle);
				if (!(await currentBinding(current)))
					return lease === current
						? view(current)
						: status("unavailable", "superseded");
				current.phase =
					result === "portal-completed"
						? "verification-required"
						: "unconfirmed";
				if (result === "portal-completed") delete current.reason;
				else current.reason = "interaction_incomplete";
				return view(current);
			} catch {
				close(current, "broker_failed");
				return lease === current
					? view(current)
					: status("unavailable", "superseded");
			}
		},
		cancel(owner: object): PortalStatus {
			if (preparing?.owner === owner && (!lease || lease.phase === "closed")) {
				preparing = undefined;
				return status("closed", "cancelled");
			}
			if (!lease || lease.owner !== owner)
				return status("unavailable", "owner_mismatch");
			if (preparing?.owner === owner) preparing = undefined;
			close(lease, "cancelled");
			return view(lease);
		},
		status(owner: object): PortalStatus {
			if (!lease || lease.owner !== owner)
				return status("unavailable", "owner_mismatch");
			expired(lease);
			return view(lease);
		},
	};
}
