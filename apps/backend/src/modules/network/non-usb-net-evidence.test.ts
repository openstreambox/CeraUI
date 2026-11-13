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

test("a device that leaves or is replaced during the walk is not proved ordinary", () => {
	const missing = () => {
		throw Object.assign(new Error("missing"), { code: "ENOENT" });
	};
	// A host-controller unbind: every USB ancestor vanishes before it is read,
	// so the walk only meets the platform node.
	let reads = 0;
	const vanishing = {
		realpath: () => {
			if (reads++ > 0) return missing();
			return "/sys/devices/platform/fc800000.usb/usb1/1-1/1-1:1.4";
		},
		readlink: (path: string) =>
			path === "/sys/devices/platform/fc800000.usb/subsystem"
				? "../../bus/platform"
				: missing(),
	};
	expect(examinedNonUsbNetDevice("wwan0", vanishing)).toBe(false);
	let turn = 0;
	expect(
		examinedNonUsbNetDevice("eth0", {
			realpath: () =>
				turn++ === 0
					? "/sys/devices/platform/nic"
					: "/sys/devices/platform/other",
			readlink: () => "../../bus/platform",
		}),
	).toBe(false);
	expect(
		examinedNonUsbNetDevice("eth0", {
			realpath: () => "/sys/devices/platform/nic",
			readlink: () => "../../bus/platform",
		}),
	).toBe(true);
});
