/**
 * Failed-attempt budget for the companion channel, per ingress key.
 *
 * The key is the arrival interface plus the peer address (an IPv6 peer counts
 * by its /64), so a neighbour on the hotspot cannot exhaust the budget of a
 * phone on Ethernet. After `free` failures in a row a key waits `baseMs`,
 * doubling with each further failure up to `maxMs`. A success clears the key. Memory is bounded: past `maxKeys`
 * the oldest key is forgotten, which can only make the budget more lenient for
 * that key, never lock anybody out. There is no global lockout.
 */
export interface AttemptBudgetOptions {
	free?: number;
	baseMs?: number;
	maxMs?: number;
	maxKeys?: number;
	now?: () => number;
}

interface Entry {
	failures: number;
	until: number;
}

export class AttemptBudget {
	readonly #entries = new Map<string, Entry>();
	readonly #free: number;
	readonly #baseMs: number;
	readonly #maxMs: number;
	readonly #maxKeys: number;
	readonly #now: () => number;

	constructor(options: AttemptBudgetOptions = {}) {
		this.#free = options.free ?? 5;
		this.#baseMs = options.baseMs ?? 30_000;
		this.#maxMs = options.maxMs ?? 15 * 60_000;
		this.#maxKeys = options.maxKeys ?? 256;
		this.#now = options.now ?? Date.now;
	}

	/** Milliseconds until this key may try again; 0 when it may try now. */
	retryAfter(key: string): number {
		const entry = this.#entries.get(key);
		return entry ? Math.max(0, entry.until - this.#now()) : 0;
	}

	fail(key: string): void {
		const entry = this.#entries.get(key) ?? { failures: 0, until: 0 };
		this.#entries.delete(key);
		entry.failures += 1;
		const over = entry.failures - this.#free + 1;
		entry.until =
			over > 0
				? this.#now() +
					Math.min(this.#maxMs, this.#baseMs * 2 ** Math.min(over - 1, 20))
				: 0;
		this.#entries.set(key, entry);
		while (this.#entries.size > this.#maxKeys) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) break;
			this.#entries.delete(oldest);
		}
	}

	succeed(key: string): void {
		this.#entries.delete(key);
	}

	get size(): number {
		return this.#entries.size;
	}
}

/** The budget key for a peer on an interface; IPv6 peers count by their /64. */
export function ingressBudgetKey(iface: string, peer: string): string {
	const address = peer.replace(/^::ffff:/, "").replace(/%.*$/, "");
	if (!address.includes(":")) return `${iface}|${address}`;
	const groups = expandIpv6(address);
	return `${iface}|${groups ? `${groups.slice(0, 4).join(":")}::/64` : address}`;
}

function expandIpv6(address: string): string[] | undefined {
	const [head = "", tail, extra] = address.split("::");
	if (extra !== undefined) return undefined;
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const fill = tail === undefined ? 0 : 8 - left.length - right.length;
	if (fill < 0) return undefined;
	const groups = [...left, ...Array(fill).fill("0"), ...right];
	return groups.length === 8 ? groups.map((g) => g.toLowerCase()) : undefined;
}
