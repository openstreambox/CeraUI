import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, opendir, readlink } from "node:fs/promises";

async function read(path: string): Promise<string> {
	const file = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const bytes = Buffer.alloc(256 * 1024 + 1);
		let used = 0;
		while (used < bytes.length) {
			const result = await file.read(bytes, used, bytes.length - used, null);
			if (!result.bytesRead) break;
			used += result.bytesRead;
		}
		if (used === bytes.length)
			throw new Error("Observer evidence exceeds limit");
		return new TextDecoder("utf-8", { fatal: true }).decode(
			bytes.subarray(0, used),
		);
	} finally {
		await file.close();
	}
}
function inodes(text: string, family: "unix" | "netlink"): Set<string> {
	const lines = text.trim().split("\n");
	const header = lines.shift()?.trim().split(/\s+/).join(" ");
	if (
		header !==
		(family === "unix"
			? "Num RefCount Protocol Flags Type St Inode Path"
			: "sk Eth Pid Groups Rmem Wmem Dump Locks Drops Inode")
	)
		throw new Error("Unknown observer socket table");
	if (lines.length > 4096)
		throw new Error("Observer socket inventory exceeds limit");
	return new Set(
		lines.map((line) => {
			const fields = line.trim().split(/\s+/),
				inode = fields[family === "unix" ? 6 : 9];
			if (!inode || !/^(0|[1-9]\d*)$/.test(inode))
				throw new Error("Unknown observer socket identity");
			return inode;
		}),
	);
}
export interface CellularObserverCensusIO {
	readonly read: (path: string) => Promise<string>;
	readonly descriptors: (
		pid: number,
	) => Promise<readonly { readonly fd: string; readonly target: string }[]>;
}
const kernel: CellularObserverCensusIO = {
	read,
	descriptors: async (pid) => {
		const directory = await opendir(`/proc/${pid}/fd`),
			values: { fd: string; target: string }[] = [];
		for await (const entry of directory) {
			if (!/^\d+$/.test(entry.name) || values.length >= 256)
				throw new Error("Unknown observer descriptors");
			values.push({
				fd: entry.name,
				target: await readlink(`/proc/${pid}/fd/${entry.name}`),
			});
		}
		return values.sort((a, b) => Number(a.fd) - Number(b.fd));
	},
};
/** Only an actual owned fixed-command NM observer may be considered here. Its
 * parent/start identity, argv and descriptors are checked positively. Every
 * socket must appear as AF_UNIX or NETLINK; an INET/raw/unknown socket, TUN,
 * changed descriptor table or unreadable process refuses consumer absence.
 */
export async function inspectCellularNmcliObserver(
	pid: number,
	parent: number,
	io: CellularObserverCensusIO = kernel,
): Promise<string | undefined> {
	try {
		if (
			!Number.isSafeInteger(pid) ||
			pid < 1 ||
			!Number.isSafeInteger(parent) ||
			parent < 1 ||
			pid === parent
		)
			return undefined;
		const stat = await io.read(`/proc/${pid}/stat`),
			match = /^(\d+) \(nmcli\) ([A-Za-z]) (.*)$/.exec(stat.trim()),
			fields = match?.[3]?.split(" "),
			start = fields?.[18];
		if (
			match?.[1] !== String(pid) ||
			fields?.[0] !== String(parent) ||
			!start ||
			!/^[1-9]\d*$/.test(start) ||
			match[2] === "Z" ||
			match[2] === "X"
		)
			return undefined;
		if ((await io.read(`/proc/${pid}/cmdline`)) !== "nmcli\0monitor\0")
			return undefined;
		const allowed = new Set([
				...inodes(await io.read(`/proc/${pid}/net/unix`), "unix"),
				...inodes(await io.read(`/proc/${pid}/net/netlink`), "netlink"),
			]),
			before = await io.descriptors(pid);
		if (
			before.length > 256 ||
			new Set(before.map((row) => row.fd)).size !== before.length
		)
			return undefined;
		for (const row of before) {
			if (!/^\d+$/.test(row.fd)) return undefined;
			const socket = /^socket:\[([1-9]\d*)\]$/.exec(row.target);
			if (
				socket
					? !allowed.has(socket[1] ?? "")
					: row.target.includes("socket:") ||
						row.target === "/dev/net/tun" ||
						(row.target.startsWith("anon_inode:") &&
							!/^anon_inode:\[(?:eventfd|eventpoll|signalfd|timerfd)\]$/.test(
								row.target,
							))
			)
				return undefined;
		}
		if (
			JSON.stringify(before) !== JSON.stringify(await io.descriptors(pid)) ||
			stat !== (await io.read(`/proc/${pid}/stat`)) ||
			(await io.read(`/proc/${pid}/cmdline`)) !== "nmcli\0monitor\0"
		)
			return undefined;
		return createHash("sha256")
			.update(JSON.stringify([start, before]))
			.digest("hex");
	} catch {
		return undefined;
	}
}
