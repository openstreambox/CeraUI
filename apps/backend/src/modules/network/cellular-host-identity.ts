import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { usbGeneration } from "../../helpers/usb-serial.ts";
import { isSafeIfname } from "./safe-ifname.ts";

export interface CellularPhysicalLink {
	readonly ifname: string;
	readonly ifindex: string;
	readonly usbDevice: string;
	readonly netDevice: string;
	readonly generation: string;
}
export type CellularPhysicalState =
	| "present"
	| "usb-absent"
	| "link-absent"
	| "replaced"
	| "unknown";
export interface CellularPhysicalIO {
	readonly usbEpoch: (device: string) => Promise<string>;
	readonly device: (ifname: string) => Promise<string>;
	readonly index: (ifname: string) => Promise<string>;
}
const physicalIO: CellularPhysicalIO = {
	usbEpoch: usbGeneration,
	device: (name) => realpath(`/sys/class/net/${name}/device`),
	index: async (name) =>
		(await readFile(`/sys/class/net/${name}/ifindex`, "utf8")).trim(),
};
function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function validLink(link: CellularPhysicalLink): boolean {
	return (
		isSafeIfname(link.ifname) &&
		link.ifname !== "." &&
		link.ifname !== ".." &&
		/^[1-9]\d{0,9}$/.test(link.ifindex) &&
		!!link.usbDevice &&
		!!link.netDevice &&
		!!link.generation
	);
}
/** MM disappearance during our inhibition is irrelevant to this physical check.
 * Unknown reads never authorize touching an interface that reused an old name.
 */
export async function cellularPhysicalState(
	link: CellularPhysicalLink,
	io: CellularPhysicalIO = physicalIO,
): Promise<CellularPhysicalState> {
	if (!validLink(link)) return "unknown";
	let epoch: string;
	try {
		epoch = await io.usbEpoch(link.usbDevice);
	} catch (error) {
		return missing(error) ? "usb-absent" : "unknown";
	}
	if (epoch !== link.generation) return "replaced";
	try {
		if (
			(await io.device(link.ifname)) !== link.netDevice ||
			(await io.index(link.ifname)) !== link.ifindex
		)
			return "replaced";
	} catch (error) {
		return missing(error) ? "link-absent" : "unknown";
	}
	try {
		return (await io.usbEpoch(link.usbDevice)) === epoch &&
			(await io.index(link.ifname)) === link.ifindex
			? "present"
			: "replaced";
	} catch (error) {
		return missing(error) ? "link-absent" : "unknown";
	}
}

const sysctlKeys = [
	"accept_ra",
	"accept_ra_defrtr",
	"forwarding",
	"proxy_ndp",
] as const;
export type CellularSysctl = (typeof sysctlKeys)[number];
export type CellularSysctlValue = "0" | "1" | "2";
function validValue(
	key: CellularSysctl,
	value: string,
): value is CellularSysctlValue {
	return (
		value === "0" || value === "1" || (key === "accept_ra" && value === "2")
	);
}
interface SysctlHandle {
	readValue(): Promise<string>;
	writeValue(value: string): Promise<void>;
	close(): Promise<void>;
}
export interface CellularSysctlIO {
	readonly state: (
		link: CellularPhysicalLink,
	) => Promise<CellularPhysicalState>;
	readonly open: (path: string, writable: boolean) => Promise<SysctlHandle>;
}
const sysctlIO: CellularSysctlIO = {
	state: cellularPhysicalState,
	open: async (path, writable) => {
		const handle = await open(
			path,
			(writable ? constants.O_RDWR : constants.O_RDONLY) |
				constants.O_NOFOLLOW |
				constants.O_NONBLOCK,
		);
		try {
			if (!(await handle.stat()).isFile())
				throw new Error("Not a per-link sysctl");
		} catch (error) {
			await handle.close();
			throw error;
		}
		return {
			readValue: async () => {
				const buffer = Buffer.alloc(8);
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
				return buffer.subarray(0, bytesRead).toString("ascii").trim();
			},
			writeValue: async (value) => {
				const bytes = `${value}\n`;
				const { bytesWritten } = await handle.write(bytes, 0, "ascii");
				if (bytesWritten !== bytes.length)
					throw new Error("Incomplete per-link sysctl write");
			},
			close: () => handle.close(),
		};
	},
};
function sysctlPath(link: CellularPhysicalLink, key: CellularSysctl): string {
	if (
		!validLink(link) ||
		["all", "default", "lo"].includes(link.ifname) ||
		!sysctlKeys.includes(key)
	)
		throw new Error("Invalid per-link sysctl identity");
	return `/proc/sys/net/ipv6/conf/${link.ifname}/${key}`;
}
export async function readCellularSysctl(
	link: CellularPhysicalLink,
	key: CellularSysctl,
	io: CellularSysctlIO = sysctlIO,
): Promise<CellularSysctlValue | undefined> {
	const path = sysctlPath(link, key);
	if ((await io.state(link)) !== "present") return undefined;
	const handle = await io.open(path, false);
	try {
		const value = await handle.readValue();
		return (await io.state(link)) === "present" && validValue(key, value)
			? value
			: undefined;
	} finally {
		await handle.close();
	}
}
/** Caller records the original value durably before this CAS. The open proc
 * descriptor belongs to that device instance, even if a name is later reused.
 * No all/default sysctl, network restart or global forwarding change is allowed.
 */
export async function compareAndSetCellularSysctl(
	link: CellularPhysicalLink,
	key: CellularSysctl,
	expected: CellularSysctlValue,
	desired: CellularSysctlValue,
	io: CellularSysctlIO = sysctlIO,
): Promise<boolean> {
	const path = sysctlPath(link, key);
	if (!validValue(key, expected) || !validValue(key, desired))
		throw new Error("Invalid per-link sysctl value");
	if ((await io.state(link)) !== "present") return false;
	const handle = await io.open(path, true);
	try {
		const before = await handle.readValue();
		if (
			(before !== expected && before !== desired) ||
			(await io.state(link)) !== "present"
		)
			return false;
		if (before !== desired) await handle.writeValue(desired);
		return (
			(await io.state(link)) === "present" &&
			(await handle.readValue()) === desired
		);
	} finally {
		await handle.close();
	}
}
