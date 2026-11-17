/**
 * The interface the kernel's ACTIVE default route egresses through, from the
 * output of `ip route show default`.
 *
 * `ip` prints default routes in metric order, so the FIRST `default` line is
 * the one the kernel actually uses — a route with no `metric` clause is metric
 * 0 and therefore outranks every explicit metric. Board-confirmed: a HiLink
 * dongle's DHCP lease installs `default via 192.168.8.1 dev enx0c5b8f279a64`
 * with no metric, ahead of `eth0`'s metric 101.
 *
 * Returns `undefined` for empty/garbled output or a line with no `dev` clause —
 * an unknown default interface must never be mistaken for an excluded one.
 */
export function parseDefaultRouteInterface(output: string): string | undefined {
	for (const line of output.split("\n")) {
		const tokens = line
			.trim()
			.split(/\s+/)
			.filter((token) => token.length > 0);
		if (tokens[0] !== "default") continue;

		const devIndex = tokens.indexOf("dev");
		if (devIndex === -1) continue;

		const ifname = tokens[devIndex + 1];
		if (!ifname) continue;

		return ifname;
	}
	return undefined;
}
