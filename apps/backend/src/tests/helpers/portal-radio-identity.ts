/*
  Published radio identity for the captive-portal capture tests.

  The portal binds a venue radio by the Verified identity row of its exact
  registry object and that row's published incarnation. These tests drive the
  real producer over a fake sysfs, so the identity they bind is the one
  discovery would publish, never a hand-written token.
*/

import type { BaseWifiInterface } from "../../modules/wifi/wifi-interfaces.ts";
import { wifiRadioIdentity } from "../../modules/wifi/wifi-radio-identity.ts";
import { projectWifiRadioIncarnation } from "../../modules/wifi/wifi-radio-publication.ts";
import type { RadioFixture } from "./wifi-radio-equivalence.ts";
import { fakeShadowSysfs } from "./wifi-radio-equivalence-shadow.ts";

type Sysfs = {
	ifindex: number;
	phy: number;
	permanent: string | undefined;
	devicePath?: string | null;
};

export function portalRadioIdentity() {
	let radios: RadioFixture[] = [];
	const rows = new Map<string, BaseWifiInterface>();
	let restore: (() => Promise<void>) | undefined;
	let published: Promise<void> = Promise.resolve();
	const discover = () => {
		published = wifiRadioIdentity.discover(
			[...rows].map(([ifname, row]) => ({ ifname, row })),
		);
		return published;
	};
	return {
		async install() {
			restore = await fakeShadowSysfs(() => radios);
		},
		async uninstall() {
			await published.catch(() => undefined);
			radios = [];
			rows.clear();
			await restore?.();
			restore = undefined;
		},
		/** Register `row` with its sysfs and re-publish every known row. */
		prove(row: BaseWifiInterface, sysfs: Sysfs): Promise<void> {
			radios = [
				...radios.filter((radio) => radio.ifname !== row.ifname),
				{
					ifname: row.ifname,
					operational: sysfs.permanent,
					permanent: sysfs.permanent,
					ifindex: sysfs.ifindex,
					phy: sysfs.phy,
					state: "connected",
				},
			];
			rows.set(row.ifname, row);
			return discover();
		},
		/** Change one row's sysfs, then re-publish the whole roster. */
		change(ifname: string, sysfs: Partial<Sysfs>): Promise<void> {
			radios = radios.map((radio) =>
				radio.ifname === ifname ? { ...radio, ...sysfs } : radio,
			);
			return discover();
		},
		published: () => published,
		token(row: BaseWifiInterface): string {
			return (
				projectWifiRadioIncarnation(
					row,
					wifiRadioIdentity.state.rows.get(row.ifname),
				) ?? "unpublished"
			);
		},
	};
}
