/**
 * The name an operator already sees for a bonded link, so a backend notice
 * says the same words as the Bonded Links rows. Mirrors the HUD's precedence
 * (`apps/frontend/src/lib/stores/hud/link-status.ts`): a Wi-Fi link is its
 * active SSID, else "WiFi"; a modem is its name, else its network, else
 * "Modem"; anything else is its interface name.
 */

type WifiLike = {
	readonly ifname?: string;
	readonly available?: ReadonlyArray<{
		readonly active?: boolean;
		readonly ssid?: string;
	}>;
};
type ModemLike = {
	readonly ifname?: string;
	readonly name?: string;
	readonly status?: { readonly network?: string };
};

export function linkLabelFor(
	iface: string,
	wifi: Readonly<Record<string, WifiLike>>,
	modems: Readonly<Record<string, ModemLike>>,
): string {
	for (const [key, entry] of Object.entries(wifi)) {
		if ((entry.ifname || key) !== iface) continue;
		const active = entry.available?.find((network) => network.active);
		return active?.ssid || "WiFi";
	}
	for (const [key, modem] of Object.entries(modems)) {
		if ((modem.ifname || key) !== iface) continue;
		return modem.name || modem.status?.network || "Modem";
	}
	return iface;
}

/** Never throws: a label is enrichment, the interface name is the floor. */
export async function resolveLinkLabel(iface: string): Promise<string> {
	try {
		const [{ wifiBuildMsg }, { getCommittedModemsWireMessage }] =
			await Promise.all([
				import("../wifi/wifi.ts"),
				import("../modems/modem-status.ts"),
			]);
		return linkLabelFor(
			iface,
			wifiBuildMsg() as Record<string, WifiLike>,
			getCommittedModemsWireMessage() as Record<string, ModemLike>,
		);
	} catch {
		return iface;
	}
}
