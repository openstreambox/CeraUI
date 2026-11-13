import { expect, test } from "bun:test";
import {
	type CellularObserverCensusIO,
	inspectCellularNmcliObserver,
} from "./cellular-observer-census.ts";

function fixture() {
	let command = "nmcli\0monitor\0",
		parent = 17,
		start = 900,
		target = "socket:[123]",
		changed = false,
		reads = 0;
	const fields = Array(40).fill("0");
	const io: CellularObserverCensusIO = {
		read: async (path) => {
			if (path.endsWith("/stat")) {
				fields[0] = String(parent);
				fields[18] = String(start);
				return `18 (nmcli) S ${fields.join(" ")}\n`;
			}
			if (path.endsWith("/cmdline")) return command;
			if (path.endsWith("/unix"))
				return "Num RefCount Protocol Flags Type St Inode Path\n000000: 00000002 00000000 00010000 0001 01 123\n";
			if (path.endsWith("/netlink"))
				return "sk Eth Pid Groups Rmem Wmem Dump Locks Drops Inode\n000000 0 0 0 0 0 0 0 0 0\n";
			throw new Error("Unknown observer evidence");
		},
		descriptors: async () => {
			reads++;
			return [
				{ fd: "0", target: "/dev/null" },
				{ fd: "3", target: changed && reads > 1 ? "socket:[999]" : target },
			];
		},
	};
	return {
		io,
		set: (values: {
			command?: string;
			parent?: number;
			start?: number;
			target?: string;
			changed?: boolean;
		}) => {
			if (values.command !== undefined) command = values.command;
			if (values.parent !== undefined) parent = values.parent;
			if (values.start !== undefined) start = values.start;
			if (values.target !== undefined) target = values.target;
			if (values.changed !== undefined) changed = values.changed;
		},
	};
}
test("an owned exact NM observer needs a stable command/start identity and only positively non-INET sockets", async () => {
	const f = fixture();
	expect(await inspectCellularNmcliObserver(18, 17, f.io)).toMatch(
		/^[a-f0-9]{64}$/,
	);
	for (const values of [
		{ command: "nmcli\0connection\0up\0synthetic\0" },
		{ parent: 19 },
		{ start: 0 },
		{ target: "socket:[999]" },
		{ target: "/dev/net/tun" },
		{ target: "anon_inode:[io_uring]" },
		{ changed: true },
	]) {
		const f = fixture();
		f.set(values);
		expect(await inspectCellularNmcliObserver(18, 17, f.io)).toBeUndefined();
	}
});
test("unreadable or unknown observer socket tables and changed process identity cannot certify absence", async () => {
	const f = fixture();
	expect(
		await inspectCellularNmcliObserver(18, 17, {
			...f.io,
			read: async () => {
				throw new Error("unknown");
			},
		}),
	).toBeUndefined();
	expect(
		await inspectCellularNmcliObserver(18, 17, {
			...f.io,
			read: async (path) =>
				path.endsWith("/netlink") ? "unknown table" : f.io.read(path),
		}),
	).toBeUndefined();
	let statReads = 0;
	expect(
		await inspectCellularNmcliObserver(18, 17, {
			...f.io,
			read: async (path) => {
				if (path.endsWith("/stat") && ++statReads > 1) f.set({ start: 901 });
				return f.io.read(path);
			},
		}),
	).toBeUndefined();
});
