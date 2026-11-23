import { expect, test } from "vitest";
import { ipv6OnlyWanNames } from "../main/network/sharing-section-view";

test("shows the IPv6-only limitation per WAN, preserving other IPv4 links", () => {
	expect(
		ipv6OnlyWanNames({
			wwan0: { ipv6: "fd51::1", enabled: true, tp: 0 },
			eth0: { ip: "192.0.2.1", enabled: true, tp: 0 },
			wlan0: { ip: "10.42.0.1", enabled: false, tp: 0, error: "hotspot" },
		}),
	).toEqual(["wwan0"]);
	expect(
		ipv6OnlyWanNames({
			wwan0: { ip: "192.0.2.3", ipv6: "fd51::1", enabled: true, tp: 0 },
		}),
	).toEqual([]);
});

test("bond opt-out does not hide a running WAN's sharing limitation", () => {
	expect(
		ipv6OnlyWanNames({ wwan0: { ipv6: "fd51::1", enabled: false, tp: 0 } }),
	).toEqual(["wwan0"]);
});
