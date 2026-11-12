import { createHash } from "node:crypto";
import { changeLinkByIndex } from "../../helpers/netlink-link.ts";
import { run } from "../../helpers/run.ts";

export interface CellularTunIdentity {
	readonly name: string;
	readonly index: number;
	readonly alias: string;
	readonly persistent: boolean;
}
export interface CellularTunIO {
	readonly current: () => Promise<boolean>;
	readonly links: () => Promise<unknown>;
}
export function cellularTunIO(current: () => Promise<boolean>): CellularTunIO {
	return {
		current,
		links: async () =>
			JSON.parse(
				await run("ip", ["-d", "-j", "link", "show"], {
					timeout: 4000,
					maxBuffer: 256 * 1024,
				}),
			),
	};
}
function nameForSlot(slot: number): string {
	if (!Number.isInteger(slot) || slot < 1 || slot > 32)
		throw new Error("Invalid translator slot");
	return `cclat${slot}`;
}
export function cellularTunAlias(owner: string, epoch: string): string {
	if (!/^[a-f0-9]{64}$/.test(owner) || !epoch || epoch.length > 256)
		throw new Error("Invalid translator owner");
	return `cellular-${owner}-${createHash("sha256").update(epoch).digest("hex")}`;
}
function rowForName(
	raw: unknown,
	name: string,
): Record<string, unknown> | undefined {
	if (!Array.isArray(raw) || raw.length > 4096)
		throw new Error("Unknown translator link inventory");
	const found = raw.filter(
		(entry) => entry && typeof entry === "object" && entry.ifname === name,
	);
	if (found.length > 1) throw new Error("Ambiguous translator link name");
	return found[0];
}
/** Read only a fully identified, PI-framed single-queue TUN. Matching names alone
 * never grant adoption or deletion authority.
 */
export function inspectCellularTun(
	raw: unknown,
	slot: number,
	owner: string,
	epoch: string,
): CellularTunIdentity | "absent" | "foreign" {
	const name = nameForSlot(slot),
		alias = cellularTunAlias(owner, epoch),
		row = rowForName(raw, name);
	if (!row)
		return Array.isArray(raw) && raw.some((entry) => entry?.ifalias === alias)
			? "foreign"
			: "absent";
	const info = row.linkinfo;
	if (
		!Number.isInteger(row.ifindex) ||
		Number(row.ifindex) < 1 ||
		Number(row.ifindex) > 0x7fffffff ||
		row.ifalias !== alias ||
		!info ||
		typeof info !== "object" ||
		!("info_kind" in info) ||
		info.info_kind !== "tun" ||
		!("info_data" in info) ||
		!info.info_data ||
		typeof info.info_data !== "object"
	)
		return "foreign";
	const data = info.info_data;
	if (
		!("type" in data) ||
		data.type !== "tun" ||
		!("pi" in data) ||
		data.pi !== true ||
		!("persist" in data) ||
		typeof data.persist !== "boolean" ||
		!("multi_queue" in data) ||
		data.multi_queue !== false
	)
		return "foreign";
	return { name, index: Number(row.ifindex), alias, persistent: data.persist };
}
async function openTunLibrary() {
	if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
		throw new Error("Atomic translator creation unavailable");
	const ffi = await import("bun:ffi"),
		{ FFIType: t } = ffi;
	const library = ffi.dlopen("libc.so.6", {
		open: { args: [t.ptr, t.i32], returns: t.i32 },
		// Only LP64 pointer/integer arguments cross this narrow variadic ABI.
		ioctl: { args: [t.i32, t.u64, t.i64], returns: t.i32 },
		if_nametoindex: { args: [t.ptr], returns: t.u32 },
		close: { args: [t.i32], returns: t.i32 },
	});
	return { ffi, library };
}
let runtime: ReturnType<typeof openTunLibrary> | undefined;
/** Caller persists birth authority and holds the slot's kernel lease first.
 * IFF_TUN_EXCL prevents attaching another owner's interface. Keep it ephemeral
 * until its owner alias is acknowledged: a crash before persistence closes the
 * descriptor and the kernel removes the unidentified link automatically.
 */
export async function createCellularTun(
	slot: number,
	owner: string,
	epoch: string,
	io: CellularTunIO,
): Promise<CellularTunIdentity> {
	const name = nameForSlot(slot),
		alias = cellularTunAlias(owner, epoch);
	if (!(await io.current()) || rowForName(await io.links(), name))
		throw new Error("Translator birth slot occupied");
	runtime ??= openTunLibrary();
	const { ffi, library } = await runtime,
		c = library.symbols;
	const device = Buffer.from("/dev/net/tun\0"),
		fd = c.open(ffi.ptr(device), 2 | 0x800 | 0x80000);
	if (fd < 0) throw new Error("Translator kernel device unavailable");
	try {
		const request = new Uint8Array(40),
			view = new DataView(request.buffer),
			nameBytes = Buffer.from(`${name}\0`);
		request.set(nameBytes);
		view.setUint16(16, 0x0001 | 0x8000, true);
		if (
			!(await io.current()) ||
			c.ioctl(fd, 0x400454ca, BigInt(ffi.ptr(request))) !== 0
		)
			throw new Error("Exclusive translator creation failed");
		const index = c.if_nametoindex(ffi.ptr(nameBytes));
		if (
			!index ||
			!(await io.current()) ||
			!(await changeLinkByIndex(index, { kind: "alias", alias }))
		)
			throw new Error("Translator owner alias did not verify");
		const before = inspectCellularTun(await io.links(), slot, owner, epoch);
		if (
			typeof before === "string" ||
			before.index !== index ||
			before.persistent ||
			!(await io.current())
		)
			throw new Error("Translator birth identity changed");
		if (c.ioctl(fd, 0x400454cb, 1n) !== 0)
			throw new Error("Translator persistence acknowledgement failed");
		const after = inspectCellularTun(await io.links(), slot, owner, epoch);
		if (
			typeof after === "string" ||
			after.index !== index ||
			!after.persistent ||
			!(await io.current())
		)
			throw new Error("Translator persistent identity changed");
		return after;
	} finally {
		c.close(fd);
	}
}
