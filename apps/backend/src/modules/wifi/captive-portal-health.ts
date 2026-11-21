/** A sign-in never promotes its venue link while the forwarding window is open. */
const held = new Map<string, object>();
export function holdPortalInterface(iface: string): () => void {
	const owner = {};
	held.set(iface, owner);
	return () => {
		if (held.get(iface) === owner) held.delete(iface);
	};
}
export async function portalHealthProbe<T>(
	iface: string,
	probe: () => Promise<T>,
): Promise<T | "captive_portal"> {
	if (held.has(iface)) return "captive_portal";
	const result = await probe();
	return held.has(iface) ? "captive_portal" : result;
}
