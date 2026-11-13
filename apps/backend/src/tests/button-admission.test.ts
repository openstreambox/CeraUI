import { expect, test } from "bun:test";
import {
	buttonAdmission,
	isButtonLocalPeer,
} from "../modules/system/button-admission.ts";

test("only direct wired or Wi-Fi peers are local; private addresses alone prove nothing", () => {
	const links = [
		{ name: "eth0", address: "192.168.2.1", netmask: "255.255.255.0" },
	];
	expect(isButtonLocalPeer("192.168.2.4", links)).toBe(true);
	for (const peer of ["127.0.0.1", "::1", "10.0.0.4", undefined])
		expect(isButtonLocalPeer(peer, links)).toBe(false);
	expect(
		isButtonLocalPeer("10.0.0.4", [
			{ name: "tailscale0", address: "10.0.0.1", netmask: "255.0.0.0" },
		]),
	).toBe(false);
});
test("disconnect refuses live, recording activity and unknown evidence; connect remains available", () => {
	for (const idle of [false, true]) {
		expect(buttonAdmission(false, false, "connect", idle)).toBe("local-only");
		expect(buttonAdmission(true, true, "connect", idle)).toBe("local-only");
	}
	expect(buttonAdmission(true, false, "disconnect", false)).toBe("stop-first");
	expect(buttonAdmission(true, false, "disconnect", true)).toBeNull();
	expect(buttonAdmission(true, false, "connect", false)).toBeNull();
});
