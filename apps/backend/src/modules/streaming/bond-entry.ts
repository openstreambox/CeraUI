import { logger } from "../../helpers/logger.ts";
import type {
	PhysicalBondKeys,
	PhysicalDeviceRecord,
} from "../modems/physical-identity.ts";
import {
	describeModemBondKeys,
	resolveModemPhysicalIdentity,
} from "../modems/physical-identity-source.ts";
import {
	clatTranslationFor,
	clatTranslationForTun,
	isClatTunName,
} from "../network/clat-translation.ts";
import {
	type BondEntry,
	isMappableEntry,
	unmappableBondEntry,
} from "./bind-map.ts";

export type BondIdentityResolver = typeof resolveModemPhysicalIdentity;

let identityResolver: BondIdentityResolver = resolveModemPhysicalIdentity;

export function setBondIdentityResolverForTest(
	fn: BondIdentityResolver | null,
): void {
	identityResolver = fn ?? resolveModemPhysicalIdentity;
}

export function resolveBondPhysicalIdentity(
	ifname: string,
): PhysicalDeviceRecord | undefined {
	try {
		const translation = isClatTunName(ifname)
			? clatTranslationForTun(ifname)
			: undefined;
		if (isClatTunName(ifname) && !translation) return undefined;
		const record = identityResolver(translation?.parent ?? ifname);
		return translation && record.anchor === "ifname" ? undefined : record;
	} catch {
		return undefined;
	}
}

export function peekBondKeys(ifname: string): PhysicalBondKeys | undefined {
	try {
		return identityResolver === resolveModemPhysicalIdentity
			? describeModemBondKeys(ifname)
			: identityResolver(ifname);
	} catch {
		return undefined;
	}
}

export function describeBondEntry(
	ifname: string,
	ip: string,
	logFailure = true,
): BondEntry {
	try {
		const translation = isClatTunName(ifname)
			? clatTranslationFor(ifname, ip)
			: undefined;
		if (isClatTunName(ifname) && !translation)
			return unmappableBondEntry(ip, ifname);
		const record = identityResolver(translation?.parent ?? ifname);
		if (translation && record.anchor === "ifname")
			return unmappableBondEntry(ip, ifname);
		return {
			ip,
			iface: ifname,
			linkId: record.linkId,
			...(translation
				? {
						clatGeneration: translation.generation,
						parentIface: translation.parent,
					}
				: {}),
			...(record.idPath !== undefined ? { idPath: record.idPath } : {}),
		};
	} catch (error) {
		if (logFailure) {
			logger.warn("bind-map: identity resolution failed for a bonded link", {
				ifname,
				error,
			});
		}
		return unmappableBondEntry(ip, ifname);
	}
}

export function isBondLinkMappable(ifname: string, ip: string): boolean {
	return isMappableEntry(describeBondEntry(ifname, ip, false));
}
