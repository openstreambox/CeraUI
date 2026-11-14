import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { type LinkPath, validateClatSnapshot } from "./link-family.ts";

/** Read-only consumer. Missing image support is normal, never a service mutation. */
export function readClatPath(iface: string): LinkPath | undefined {
	if (!/^[a-zA-Z0-9_.-]+$/.test(iface)) return undefined;
	try {
		const index = Number(
			readFileSync(`/sys/class/net/${iface}/ifindex`, "utf8").trim(),
		);
		const value: unknown = JSON.parse(
			readFileSync(`/run/ceralive/clat/${index}.json`, "utf8"),
		);
		const active =
			execFileSync("systemctl", ["is-active", "ceralive-clat.service"], {
				encoding: "utf8",
				timeout: 500,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() === "active";
		return validateClatSnapshot(
			value,
			iface,
			index,
			Date.now() / 1000,
			active,
			existsSync(`/sys/class/net/clat${index}/tun_flags`),
		);
	} catch {
		return undefined;
	}
}
