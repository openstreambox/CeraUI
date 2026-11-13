import { expect, test } from "bun:test";
import { projectRemoteStatus } from "../modules/remote/remote-status.ts";

for (const array of [false, true]) {
	test(`remote projection strips row tokens and preserves legacy container array=${array}`, () => {
		const station = {
			ifname: "wlan0",
			incarnation: "station-token",
			saved: {},
		};
		const ap = {
			ifname: "wlan1",
			incarnation: "ap-token",
			hotspot: { name: "AP", password: "secret" },
		};
		const legacyStation = { ifname: "wlan0", saved: {} };
		const legacyAp = {
			ifname: "wlan1",
			hotspot: { name: "AP", password: "secret" },
		};
		const wifi = array
			? [station, null, ap]
			: { first: station, second: null, third: ap };
		const _expected = array
			? [legacyStation, null, legacyAp]
			: { first: legacyStation, second: null, third: legacyAp };
		const local = { first: "preserved", wifi, last: undefined };
		const original = structuredClone(local);
		const bytes = JSON.stringify(projectRemoteStatus(local));
		for (const value of [
			"station-token",
			"ap-token",
			"secret",
			"wlan0",
			"wlan1",
		])
			expect(bytes).not.toContain(value);
		expect(bytes).toMatch(/Wi-Fi \d+/);
		expect(local).toStrictEqual(original);
	});
}
