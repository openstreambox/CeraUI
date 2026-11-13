import { expect, test } from "bun:test";
import { examinedNonUsbNetDevice } from "./non-usb-net-evidence.ts";

test("ordinary interfaces require examined ancestry and a USB ancestor vetoes incomplete descriptors", () => {
	const missing = () => {
		throw Object.assign(new Error("missing"), { code: "ENOENT" });
	};
	expect(
		examinedNonUsbNetDevice("new0", { realpath: missing, readlink: missing }),
	).toBe(false);
	expect(
		examinedNonUsbNetDevice("eth0", {
			realpath: () => "/sys/devices/platform/nic",
			readlink: () => "/sys/bus/platform",
		}),
	).toBe(true);
	expect(
		examinedNonUsbNetDevice("eth1", {
			realpath: () => "/sys/devices/platform/usb1/1-1/net",
			readlink: (path) =>
				path.includes("1-1/subsystem") ? "/sys/bus/usb" : missing(),
		}),
	).toBe(false);
	expect(
		examinedNonUsbNetDevice("unknown0", {
			realpath: () => "/sys/devices/platform/nic",
			readlink: missing,
		}),
	).toBe(false);
});
