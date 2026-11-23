import { getConfig } from "../config.ts";
import {
	type ModemTransportIdentity,
	resolveTransportQuirk,
} from "./transport-policy.ts";

/** Device-local, exact physical-key opt-in. It selects a new call path, not
 * modem support: the existing ModemManager path remains the default.
 */
export function fm350InternalCallEnabled(
	stableKey: string | undefined,
	identity: ModemTransportIdentity,
	switches: Readonly<Record<string, boolean>> | undefined = getConfig()
		.fm350_internal_calls,
): boolean {
	return (
		!!stableKey &&
		Object.hasOwn(switches ?? {}, stableKey) &&
		switches?.[stableKey] === true &&
		resolveTransportQuirk(identity)?.owner === "internal-call"
	);
}
