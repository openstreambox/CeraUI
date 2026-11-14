import { readdir, readFile, readlink } from "node:fs/promises";

/**
 * Linux procfs addresses are hex words in host byte order. Decoded as
 * little-endian, which every supported device (arm64, amd64) is.
 */
export function decodeProcAddress(hex: string): string | undefined {
	if (!/^[0-9A-F]+$/i.test(hex)) return undefined;
	const bytes: number[] = [];
	for (let i = 0; i < hex.length; i += 8) {
		const word = hex.slice(i, i + 8);
		for (let j = 6; j >= 0; j -= 2)
			bytes.push(Number.parseInt(word.slice(j, j + 2), 16));
	}
	if (bytes.length === 4) return bytes.join(".");
	if (bytes.length !== 16) return undefined;
	// The standalone sender can use IPv4-mapped IPv6 sockets.
	if (
		bytes.slice(0, 10).every((b) => b === 0) &&
		bytes[10] === 255 &&
		bytes[11] === 255
	)
		return bytes.slice(12).join(".");
	const groups = Array.from({ length: 8 }, (_, i) =>
		(((bytes[i * 2] ?? 0) << 8) | (bytes[i * 2 + 1] ?? 0)).toString(16),
	);
	return new URL(`http://[${groups.join(":")}]`).hostname.slice(1, -1);
}

/** Read only this PID's socket inodes, never another process's matching address. */
export async function senderSocketSources(pid: number): Promise<string[]> {
	const dir = `/proc/${pid}/fd`;
	const inodes = new Set<string>();
	for (const fd of await readdir(dir)) {
		try {
			const match = /^socket:\[(\d+)\]$/.exec(await readlink(`${dir}/${fd}`));
			if (match?.[1]) inodes.add(match[1]);
		} catch {
			/* A descriptor can close while it is being inspected. */
		}
	}
	const sources = new Set<string>();
	for (const family of ["udp", "udp6"]) {
		const table = await readFile(`/proc/${pid}/net/${family}`, "utf8");
		for (const line of table.trim().split("\n").slice(1)) {
			const fields = line.trim().split(/\s+/);
			if (!inodes.has(fields[9] ?? "")) continue;
			const ip = decodeProcAddress(fields[1]?.split(":")[0] ?? "");
			if (
				ip &&
				ip !== "0.0.0.0" &&
				ip !== "::" &&
				ip !== "127.0.0.1" &&
				ip !== "::1"
			)
				sources.add(ip);
		}
	}
	return [...sources];
}
