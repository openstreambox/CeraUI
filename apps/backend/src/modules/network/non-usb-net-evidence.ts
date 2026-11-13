import { readlinkSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { isSafeIfname } from "./safe-ifname.ts";

/** Synchronous fresh evidence, independent of the delayed USB descriptor cache.
 * Walk the resolved device ancestry; a missing device or unreadable link is
 * unknown, not evidence that a newly enumerated interface is ordinary. */
export function examinedNonUsbNetDevice(
	iface: string,
	io: {
		realpath: (path: string) => string;
		readlink: (path: string) => string;
	} = {
		realpath: realpathSync,
		readlink: (path: string) => readlinkSync(path),
	},
): boolean {
	if (!isSafeIfname(iface)) return false;
	try {
		let path = io.realpath(`/sys/class/net/${iface}/device`);
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
		return examined;
	} catch {
		return false;
	}
}
