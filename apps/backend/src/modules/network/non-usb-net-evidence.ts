import { readlinkSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { isSafeIfname } from "./safe-ifname.ts";

type SysfsIo = {
	realpath: (path: string) => string;
	readlink: (path: string) => string;
};
const hostIo: SysfsIo = {
	realpath: realpathSync,
	readlink: (path: string) => readlinkSync(path),
};
let defaultIo = hostIo;
/** Test seam: examine a described sysfs tree instead of the host's. */
export function setNonUsbNetEvidenceIoForTest(io: SysfsIo | null): void {
	defaultIo = io ?? hostIo;
}
/** Synchronous fresh evidence, independent of the delayed USB descriptor cache.
 * Walk the resolved device ancestry; a missing device or unreadable link is
 * unknown, not evidence that a newly enumerated interface is ordinary. */
export function examinedNonUsbNetDevice(
	iface: string,
	io: SysfsIo = defaultIo,
): boolean {
	if (!isSafeIfname(iface)) return false;
	try {
		const device = `/sys/class/net/${iface}/device`,
			start = io.realpath(device);
		let path = start;
		if (!path.startsWith("/sys/devices/")) return false;
		let examined = false;
		while (path !== "/sys/devices") {
			try {
				if (basename(io.readlink(`${path}/subsystem`)) === "usb") return false;
				examined = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
			}
			path = dirname(path);
		}
		// A device that left or was replaced mid-walk proves nothing: its USB
		// ancestors may have gone before they were read.
		return examined && io.realpath(device) === start;
	} catch {
		return false;
	}
}
