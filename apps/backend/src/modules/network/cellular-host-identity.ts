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
const scopedSysctlKeys = [
	...sysctlKeys,
	"autoconf",
	"accept_dad",
	"disable_ipv6",
] as const;
export type CellularSysctl = (typeof sysctlKeys)[number];
export type CellularScopedSysctl = (typeof scopedSysctlKeys)[number];
export type CellularSysctlValue = "0" | "1" | "2";
export type CellularScopedSysctlValue = CellularSysctlValue | "-1";
function validValue(
	key: CellularScopedSysctl,
	value: string,
): value is CellularScopedSysctlValue {
	return (
		value === "0" ||
		value === "1" ||
		(key === "accept_dad" && value === "-1") ||
		(["accept_ra", "accept_dad"].includes(key) && value === "2")
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
/** A TUN uses its owner alias and kernel index here; never fabricate USB
 * identity for a virtual link. The supplied predicate must fence that instance.
 */
export interface CellularScopedLink {
	readonly ifname: string;
	readonly current: () => Promise<boolean>;
}
function sysctlPath(ifname: string, key: CellularScopedSysctl): string {
	if (
		!isSafeIfname(ifname) ||
		["all", "default", "lo", ".", ".."].includes(ifname) ||
		!scopedSysctlKeys.includes(key)
	)
		throw new Error("Invalid per-link sysctl identity");
	return `/proc/sys/net/ipv6/conf/${ifname}/${key}`;
}
export async function readScopedCellularSysctl(
	link: CellularScopedLink,
	key: CellularScopedSysctl,
	io: Pick<CellularSysctlIO, "open"> = sysctlIO,
): Promise<CellularScopedSysctlValue | undefined> {
	const path = sysctlPath(link.ifname, key);
	if (!(await link.current())) return undefined;
	const handle = await io.open(path, false);
	try {
		const value = await handle.readValue();
		return (await link.current()) && validValue(key, value) ? value : undefined;
	} finally {
		await handle.close();
	}
}
/** Caller records the original value durably before this CAS. The open proc
 * descriptor belongs to that device instance, even if a name is later reused.
 * No all/default sysctl, network restart or global forwarding change is allowed.
 */
export async function compareAndSetScopedCellularSysctl(
	link: CellularScopedLink,
	key: CellularScopedSysctl,
	expected: CellularScopedSysctlValue,
	desired: CellularScopedSysctlValue,
	io: Pick<CellularSysctlIO, "open"> = sysctlIO,
): Promise<boolean> {
	const path = sysctlPath(link.ifname, key);
	if (!validValue(key, expected) || !validValue(key, desired))
		throw new Error("Invalid per-link sysctl value");
	if (!(await link.current())) return false;
	const handle = await io.open(path, true);
	try {
		const before = await handle.readValue();
		if ((before !== expected && before !== desired) || !(await link.current()))
			return false;
		if (before !== desired) await handle.writeValue(desired);
		return (await link.current()) && (await handle.readValue()) === desired;
	} finally {
		await handle.close();
	}
}
export async function readCellularSysctl(
	link: CellularPhysicalLink,
	key: CellularSysctl,
	io: CellularSysctlIO = sysctlIO,
): Promise<CellularSysctlValue | undefined> {
	if (!validLink(link) || !sysctlKeys.includes(key))
		return Promise.reject(new Error("Invalid per-link sysctl identity"));
	const value = await readScopedCellularSysctl(
		{
			ifname: link.ifname,
			current: async () => (await io.state(link)) === "present",
		},
		key,
		io,
	);
	return value === "-1" ? undefined : value;
}
export function compareAndSetCellularSysctl(
	link: CellularPhysicalLink,
	key: CellularSysctl,
	expected: CellularSysctlValue,
	desired: CellularSysctlValue,
	io: CellularSysctlIO = sysctlIO,
): Promise<boolean> {
	if (!validLink(link) || !sysctlKeys.includes(key))
		return Promise.reject(new Error("Invalid per-link sysctl identity"));
	return compareAndSetScopedCellularSysctl(
		{
			ifname: link.ifname,
			current: async () => (await io.state(link)) === "present",
		},
		key,
		expected,
		desired,
		io,
	);
}
