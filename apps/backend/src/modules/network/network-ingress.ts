/**
 * Trusted arrival-interface evidence for a new UI session.
 *
 * Bun.serve exposes the peer address and port, but not the interface a
 * connection arrived on, and it cannot adopt a socket bound with
 * SO_BINDTODEVICE. A destination address does not prove the interface either:
 * Linux accepts a packet for any local address on any interface. So the kernel
 * records it: an nftables input rule adds `peer address . peer port . iifname`
 * to a timed set when a new connection to the UI port arrives. The lookup
 * accepts exactly one matching interface; none or several (a reused or spoofed
 * source port) mean unknown, and unknown never confirms a change.
 *
 * The rule uses a set, not the conntrack mark: uplink steering owns all 32
 * bits of the mark. Installing the table is part of the wiring change.
 */

import { run } from "../../helpers/run.ts";

export const INGRESS_TABLE = "ceralive_ingress";

export function ingressRuleset(ports: readonly number[], timeout = "10m") {
	if (
		!ports.length ||
		ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535) ||
		!/^[0-9]{1,4}[smh]$/.test(timeout)
	)
		throw new Error("Invalid ingress ruleset");
	const list = ports.join(", ");
	return [
		`table inet ${INGRESS_TABLE} {`,
		`\tset v4 { type ipv4_addr . inet_service . ifname; flags dynamic, timeout; timeout ${timeout}; size 4096; }`,
		`\tset v6 { type ipv6_addr . inet_service . ifname; flags dynamic, timeout; timeout ${timeout}; size 4096; }`,
		"\tchain input {",
		"\t\ttype filter hook input priority filter - 5; policy accept;",
		`\t\tmeta nfproto ipv4 tcp dport { ${list} } ct state new add @v4 { ip saddr . tcp sport . iifname }`,
		`\t\tmeta nfproto ipv6 tcp dport { ${list} } ct state new add @v6 { ip6 saddr . tcp sport . iifname }`,
		"\t}",
		"}",
		"",
	].join("\n");
}

export type IngressRunner = (bin: string, args: string[]) => Promise<string>;

function normalize(address: string) {
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
	return mapped ? (mapped[1] as string) : address.toLowerCase();
}

/** Read the interface a connection from `address`:`port` arrived on. */
export function createIngressEvidence(runner: IngressRunner = run) {
	return {
		async lookup(address: string, port: number): Promise<string | undefined> {
			if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
			const peer = normalize(address);
			const family = peer.includes(":") ? "v6" : "v4";
			let parsed: unknown;
			try {
				parsed = JSON.parse(
					await runner("nft", [
						"-j",
						"list",
						"set",
						"inet",
						INGRESS_TABLE,
						family,
					]),
				);
			} catch {
				return undefined;
			}
			const found = new Set<string>();
			const items = (parsed as { nftables?: unknown[] })?.nftables;
			for (const item of Array.isArray(items) ? items : []) {
				const elems = (item as { set?: { elem?: unknown[] } })?.set?.elem;
				for (const entry of Array.isArray(elems) ? elems : []) {
					const wrapped = (entry as { elem?: { val?: unknown } })?.elem;
					const value = wrapped ? wrapped.val : entry;
					const concat = (value as { concat?: unknown[] })?.concat;
					if (!Array.isArray(concat) || concat.length !== 3) continue;
					const [addr, sport, ifname] = concat;
					if (
						typeof addr === "string" &&
						normalize(addr) === peer &&
						sport === port &&
						typeof ifname === "string"
					)
						found.add(ifname);
				}
			}
			return found.size === 1 ? [...found][0] : undefined;
		},
	};
}
