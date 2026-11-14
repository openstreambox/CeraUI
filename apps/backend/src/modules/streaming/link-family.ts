import { isIP } from "node:net";

export const FAMILY_LOSS_GRACE_MS = 10_000;
export const FAMILY_REFRESH_MS = 2_000;
export type LinkPath = {
	ip: string;
	iface: string;
	mode: "ipv4" | "ipv6" | "clat";
};
export type ReceiverFamilies = { ipv4: boolean; ipv6: boolean };

/** Session-owned selection: withdraw immediately, switch only after sustained loss. */
export class LinkFamilySelector {
	private choices = new Map<
		string,
		{ mode: LinkPath["mode"]; missingSince?: number }
	>();
	retainInterfaces(ifaces: Iterable<string>) {
		const present = new Set(ifaces);
		for (const name of this.choices.keys())
			if (!present.has(name)) this.choices.delete(name);
	}
	reset() {
		this.choices.clear();
	}
	choose(
		iface: string,
		source: { ip?: string; ipv6?: string },
		receiver: ReceiverFamilies,
		clat: LinkPath | undefined,
		now: number,
	): LinkPath | undefined {
		const candidates: LinkPath[] = [];
		if (receiver.ipv4 && source.ip)
			candidates.push({ ip: source.ip, iface, mode: "ipv4" });
		if (receiver.ipv6 && source.ipv6)
			candidates.push({ ip: source.ipv6, iface, mode: "ipv6" });
		if (receiver.ipv4 && source.ipv6 && clat) candidates.push(clat);
		const old = this.choices.get(iface);
		if (old) {
			const current = candidates.find((p) => p.mode === old.mode);
			if (current) {
				delete old.missingSince;
				return current;
			}
			old.missingSince ??= now;
			if (now - old.missingSince < FAMILY_LOSS_GRACE_MS) return undefined;
		}
		const next = candidates[0];
		if (next) this.choices.set(iface, { mode: next.mode });
		return next;
	}
}

/** Image-owned schema v1; a file alone never establishes translator liveness. */
export function validateClatSnapshot(
	value: unknown,
	iface: string,
	index: number,
	nowSeconds: number,
	serviceActive: boolean,
	tunExists: boolean,
): LinkPath | undefined {
	if (!value || typeof value !== "object" || !serviceActive || !tunExists)
		return undefined;
	const s = value as Record<string, unknown>;
	if (
		s.schema_version !== 1 ||
		s.interface !== iface ||
		s.tun !== `clat${index}` ||
		s.state !== "up" ||
		(s.last_error !== null && typeof s.last_error !== "string") ||
		typeof s.updated_at !== "number" ||
		!Number.isFinite(s.updated_at) ||
		!Number.isInteger(index) ||
		nowSeconds - s.updated_at > 30 ||
		s.updated_at > nowSeconds + 5 ||
		typeof s.prefix !== "string" ||
		!s.prefix.includes("/") ||
		isIP(s.prefix.split("/")[0] ?? "") !== 6 ||
		s.ipv4 !== `10.254.${Math.floor(index / 256)}.${index % 256}` ||
		index < 1 ||
		index > 8191
	)
		return undefined;
	return { ip: s.ipv4 as string, iface: s.tun as string, mode: "clat" };
}
