import { isButtonLocalPeer } from "./button-admission.ts";

type Link = { name: string; address: string; netmask: string };

/** Only call on the protected Unix listener, never on a TCP request. */
export function ingressAdmission(
	request: Request,
	links: () => readonly Link[],
): (() => boolean) | null {
	let evidence: unknown;
	try {
		evidence = JSON.parse(request.headers.get("X-Ceralive-Button-Path") ?? "");
	} catch {
		return null;
	}
	if (!evidence || typeof evidence !== "object") return null;
	const path = evidence as Record<string, unknown>;
	if (
		path.version !== 1 ||
		typeof path.peer !== "string" ||
		typeof path.interface !== "string" ||
		typeof path.local !== "string"
	)
		return null;
	const { peer, interface: name, local } = path;
	let denied = false;
	const check = () => {
		try {
			const current = links().filter(
				(link) => link.name === name && link.address === local,
			);
			denied ||= !isButtonLocalPeer(peer, current, request.headers, name);
		} catch {
			denied = true;
		}
		return !denied;
	};
	return check() ? check : null;
}
