import { isIPv4 } from "node:net";
import { run, runWithStdin } from "../../helpers/run.ts";

export const PAUSE_TABLE = "ceralive_heat_client";
export const PAUSE_MARKER = "ceralive-heat-client-v1";
export const PAUSE_LEASE_SECONDS = 5;
/** Internal selector from a trusted session owner, never a public request DTO.
 * IPv6 must be positively absent until dual-stack bindings are implemented. */
export interface PauseTarget {
	iface: string;
	address: string;
	phone: false;
	management: false;
	ipv6Absent: true;
}

export function pauseRules(target: PauseTarget | null): string {
	if (
		target &&
		(!/^[A-Za-z0-9_-]{1,15}$/.test(target.iface) ||
			!isIPv4(target.address) ||
			target.phone !== false ||
			target.management !== false ||
			target.ipv6Absent !== true)
	)
		throw new Error("Unsafe client pause selector");
	const element = target
		? `elements = { "${target.iface}" . ${target.address} timeout ${PAUSE_LEASE_SECONDS}s };`
		: "";
	return `add table inet ${PAUSE_TABLE}
delete table inet ${PAUSE_TABLE}
table inet ${PAUSE_TABLE} {
 comment "${PAUSE_MARKER}"
 set clients { type ifname . ipv4_addr; flags timeout; timeout ${PAUSE_LEASE_SECONDS}s; ${element} }
 chain forward { type filter hook forward priority -5; policy accept;
  iifname . ip saddr @clients drop
  oifname . ip daddr @clients drop
 }
}
`;
}

interface PauseDeps {
	/** True only for absent state or recognized owned state. Errors must reject. */
	owns(): Promise<boolean>;
	apply(rules: string): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Recognize our reserved table marker and object namespace before replacement. */
export function ownedPauseTable(value: unknown): boolean {
	if (!record(value) || !Array.isArray(value.nftables)) return false;
	const entries: Record<string, unknown>[] = [];
	for (const row of value.nftables) {
		if (!record(row) || Object.keys(row).length !== 1) return false;
		if (!("metainfo" in row)) entries.push(row);
	}
	const tables = entries.filter((e) => "table" in e);
	const table = tables[0]?.table;
	if (
		tables.length !== 1 ||
		!record(table) ||
		table.family !== "inet" ||
		table.name !== PAUSE_TABLE ||
		table.comment !== PAUSE_MARKER
	)
		return false;
	return entries.every((e) => {
		const key = Object.keys(e)[0];
		if (!key || !["table", "chain", "set", "rule"].includes(key)) return false;
		const item = e[key];
		return (
			record(item) &&
			item.family === "inet" &&
			(key === "table" ||
				(item.table === PAUSE_TABLE &&
					(key !== "chain" || item.name === "forward") &&
					(key !== "set" || item.name === "clients") &&
					(key !== "rule" || item.chain === "forward")))
		);
	});
}

const nativeDeps: PauseDeps = {
	async owns() {
		const listed = JSON.parse(
			await run("nft", ["-j", "list", "tables"], { timeout: 1000 }),
		);
		if (!Array.isArray(listed.nftables))
			throw new Error("Unreadable nft inventory");
		if (
			!listed.nftables.some(
				(e: { table?: { family: string; name: string } }) =>
					e.table?.family === "inet" && e.table.name === PAUSE_TABLE,
			)
		)
			return true;
		return ownedPauseTable(
			JSON.parse(
				await run("nft", ["-j", "list", "table", "inet", PAUSE_TABLE], {
					timeout: 1000,
				}),
			),
		);
	},
	async apply(rules) {
		await runWithStdin("nft", ["-f", "-"], rules, { timeout: 1000 });
	},
};

/** One backend owner, serialized writes; no timer survives loss of evidence.
 * The session owner calls update at most once a second with a fresh reader.
 * Stop/recovery/restart call clear; failed cleanup still expires in the kernel.
 * No runtime registers this primitive until trusted producer evidence exists. */
export class PauseLease {
	private tail: Promise<void> = Promise.resolve();
	private initialized = false;
	private stopped = false;
	constructor(private readonly deps: PauseDeps = nativeDeps) {}
	update(read: () => PauseTarget | null): Promise<void> {
		const next = this.tail.then(async () => {
			if (!this.initialized) {
				if (!(await this.deps.owns()))
					throw new Error("Foreign client pause table");
				await this.deps.apply(pauseRules(null));
				this.initialized = true;
			}
			if (!(await this.deps.owns()))
				throw new Error("Foreign client pause table");
			// Re-read after the asynchronous ownership probe, immediately before write.
			await this.deps.apply(pauseRules(this.stopped ? null : read()));
		});
		this.tail = next.catch(() => {
			// Keep the queue usable; return the original rejection to this caller.
		});
		return next;
	}
	clear(): Promise<void> {
		return this.update(() => null);
	}
	stop(): Promise<void> {
		this.stopped = true;
		return this.clear();
	}
}
