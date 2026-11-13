import { isIPv4 } from "node:net";
import { isSameSubnet } from "../../helpers/ip-addresses.ts";
import type { ButtonPurpose } from "./button-flow.ts";

export function isButtonLocalPeer(
	peer: string | undefined,
	links: readonly { name: string; address: string; netmask: string }[],
	headers: Headers = new Headers(),
	arrivalInterface?: string,
): boolean {
	for (const name of headers.keys()) {
		if (
			name === "forwarded" ||
			name === "via" ||
			name.startsWith("x-forwarded-")
		)
			return false;
	}
	// An address/subnet or reverse route does not establish the arrival path.
	if (!arrivalInterface) return false;
	const address = peer?.replace(/^::ffff:/, "");
	if (!address || !isIPv4(address) || address.startsWith("127.")) return false;
	return links.some(
		(link) =>
			link.name === arrivalInterface &&
			/^(eth\d|en\w|wl\w|ap\d)/.test(link.name) &&
			isIPv4(link.address) &&
			link.netmask !== "0.0.0.0" &&
			isSameSubnet(address, link.address, link.netmask),
	);
}
export function buttonAdmission(
	local: boolean,
	relayed: boolean,
	purpose: ButtonPurpose,
	confirmedIdle: boolean,
): "local-only" | "stop-first" | null {
	if (!local || relayed) return "local-only";
	return purpose === "disconnect" && !confirmedIdle ? "stop-first" : null;
}
