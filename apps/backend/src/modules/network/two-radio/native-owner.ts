import { readdir, readFile, realpath } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { type RunOpts, run } from "../../../helpers/run.ts";
import type { Holder, Identity, NetworkOwner } from "./effect-adapter.ts";
import { readNmEpoch } from "./nm-epoch.ts";
import { type Radio, sameEpoch } from "./reducer.ts";

const ipv4 = z.ipv4();
const positive = z.number().int().min(1).max(2_147_483_647);
export const liveConfigSchema = z.strictObject({
	target: ipv4,
	port: z.number().int().min(1).max(65535),
	mark: positive,
	table: positive.refine((n) => n > 255),
	priority: positive.refine((n) => n < 32766),
	radios: z.strictObject({
		a: z.strictObject({
			permanentMac: z.mac(),
			phy: z.string().min(1),
			usbPath: z.string().startsWith("/"),
			table: positive.refine((n) => n > 255),
			priority: positive.refine((n) => n < 32766),
		}),
		b: z.strictObject({
			permanentMac: z.mac(),
			phy: z.string().min(1),
			usbPath: z.string().startsWith("/"),
			table: positive.refine((n) => n > 255),
			priority: positive.refine((n) => n < 32766),
		}),
	}),
});
export type LiveConfig = z.infer<typeof liveConfigSchema>;
export type RadioState = {
	identity: Identity;
	ifname: string;
	subnet: string;
	gateway: string;
};
export type Runner = (
	bin: string,
	args: string[],
	opts: RunOpts,
) => Promise<string>;
export interface NativeDeps {
	runner: Runner;
	observe(radio: Radio, signal: AbortSignal): Promise<RadioState>;
	run<T>(work: () => Promise<T>): Promise<T>;
}
const radios = ["a", "b"] as const;
/** Route-only owner: no NM request is ever enqueued. All ip children are awaited
 * under the owner transaction. Thus drainage has no remote mutation to cancel. */
export class NativeOwner implements NetworkOwner {
	private states = new Map<Radio, RadioState>();
	constructor(
		readonly config: LiveConfig,
		private readonly deps: NativeDeps,
	) {
		if (
			config.radios.a.permanentMac.toLowerCase() ===
				config.radios.b.permanentMac.toLowerCase() ||
			config.radios.a.phy === config.radios.b.phy ||
			config.radios.a.usbPath === config.radios.b.usbPath
		)
			throw new Error("Radio identities overlap");
		if (
			new Set([config.table, config.radios.a.table, config.radios.b.table])
				.size !== 3 ||
			new Set([
				config.priority,
				config.radios.a.priority,
				config.radios.b.priority,
			]).size !== 3
		)
			throw new Error("Overlapping policy resources");
	}
	run<T>(work: () => Promise<T>) {
		return this.deps.run(work);
	}
	private ip(args: string[], signal: AbortSignal) {
		return this.deps.runner("ip", ["-N", "-4", ...args], {
			signal,
			timeout: 1500,
			maxBuffer: 65536,
		});
	}
	async identity(radio: Radio, signal: AbortSignal) {
		const state = await this.deps.observe(radio, signal);
		this.states.set(radio, state);
		return state.identity;
	}
	private async stable(signal: AbortSignal) {
		for (;;) {
			signal.throwIfAborted();
			try {
				const before = [];
				for (const r of radios) before.push(await this.deps.observe(r, signal));
				for (const [i, r] of radios.entries()) {
					const after = await this.deps.observe(r, signal);
					if (JSON.stringify(before[i]) !== JSON.stringify(after))
						throw new Error("NM has not settled");
					this.states.set(r, after);
				}
				return;
			} catch {
				signal.throwIfAborted();
				await pause(50, undefined, { signal });
			}
		}
	}
	private routes(
		table: number,
		signal: AbortSignal,
	): Promise<Record<string, unknown>[]> {
		return this.ip(["-j", "route", "show", "table", String(table)], signal)
			.then(JSON.parse)
			.catch((error) => {
				if (String(error).includes("FIB table does not exist")) return [];
				throw error;
			});
	}
	private routeArgs(r: Radio, table: number, verb: string) {
		const s = this.states.get(r);
		if (!s) throw new Error("Radio not observed");
		return [
			"route",
			verb,
			"table",
			String(table),
			`${this.config.target}/32`,
			"via",
			s.gateway,
			"dev",
			s.ifname,
			"proto",
			"186",
		];
	}
	private ruleArgs(r?: Radio) {
		const c = r ? this.config.radios[r] : this.config;
		return [
			"priority",
			String(c.priority),
			...(r
				? ["oif", this.states.get(r)?.ifname ?? ""]
				: ["fwmark", String(this.config.mark)]),
			"lookup",
			String(c.table),
			"protocol",
			"186",
		];
	}
	/** Fresh acquisition refuses even an apparently identical pre-existing resource.
	 * A retained installation is admitted only by the durable owner claim. */
	async prepare(retained: boolean, signal: AbortSignal) {
		await this.stable(signal);
		if (this.states.get("a")?.subnet === this.states.get("b")?.subnet)
			throw new Error("Overlapping radio subnets");
		const rules: Record<string, unknown>[] = JSON.parse(
			await this.ip(["-j", "rule", "show"], signal),
		);
		for (const r of [undefined, ...radios]) {
			const c = r ? this.config.radios[r] : this.config;
			const existing = rules.filter((x) => x.priority === c.priority);
			if (
				existing.length &&
				(!retained ||
					existing.length !== 1 ||
					!this.ruleMatches(existing[0] ?? {}, r))
			)
				throw new Error("Foreign policy rule");
			const rows = await this.routes(c.table, signal);
			if (rows.length && !retained) throw new Error("Foreign routing table");
			for (const row of rows)
				if (!this.allowedRoute(row, r)) throw new Error("Foreign policy route");
		}
		for (const r of radios) {
			const s = this.states.get(r);
			if (!s) throw new Error("Missing radio");
			for (const table of [this.config.table, this.config.radios[r].table]) {
				const rows = await this.routes(table, signal);
				if (!rows.some((x) => x.dst === s.subnet && x.dev === s.ifname))
					await this.ip(
						[
							"route",
							"add",
							"table",
							String(table),
							s.subnet,
							"dev",
							s.ifname,
							"proto",
							"186",
						],
						signal,
					);
			}
			const rows = await this.routes(this.config.radios[r].table, signal);
			if (
				!rows.some(
					(x) =>
						x.dst === `${this.config.target}` ||
						x.dst === `${this.config.target}/32`,
				)
			)
				await this.ip(
					this.routeArgs(r, this.config.radios[r].table, "add"),
					signal,
				);
		}
		const carrying = await this.routes(this.config.table, signal);
		if (
			!carrying.some(
				(x) =>
					x.dst === this.config.target || x.dst === `${this.config.target}/32`,
			)
		)
			await this.ip(this.routeArgs("a", this.config.table, "add"), signal);
		for (const r of [undefined, ...radios]) {
			const c = r ? this.config.radios[r] : this.config;
			if (!rules.some((x) => x.priority === c.priority))
				await this.ip(["rule", "add", ...this.ruleArgs(r)], signal);
		}
		await this.verify(signal);
	}
	private ruleMatches(row: Record<string, unknown>, r?: Radio) {
		const c = r ? this.config.radios[r] : this.config;
		return (
			row.priority === c.priority &&
			String(row.table) === String(c.table) &&
			String(row.protocol) === "186" &&
			(r
				? row.oif === this.states.get(r)?.ifname
				: Number(row.fwmark) === this.config.mark) &&
			Object.keys(row).every((k) =>
				["priority", "src", "table", "protocol", r ? "oif" : "fwmark"].includes(
					k,
				),
			) &&
			row.src === "all"
		);
	}
	private allowedRoute(row: Record<string, unknown>, radio?: Radio) {
		return (
			String(row.protocol) === "186" &&
			Object.keys(row).every((k) =>
				["dst", "gateway", "dev", "protocol", "scope", "flags"].includes(k),
			) &&
			(!row.flags || JSON.stringify(row.flags) === "[]") &&
			radios
				.filter((r) => !radio || r === radio)
				.some((r) => {
					const s = this.states.get(r);
					return (
						s &&
						row.dev === s.ifname &&
						((row.dst === s.subnet &&
							!row.gateway &&
							["link", "253", 253].includes(row.scope as string | number)) ||
							((row.dst === this.config.target ||
								row.dst === `${this.config.target}/32`) &&
								row.gateway === s.gateway))
					);
				})
		);
	}
	async verify(signal: AbortSignal, holder?: Radio) {
		await this.stable(signal);
		const rules: Record<string, unknown>[] = JSON.parse(
			await this.ip(["-j", "rule", "show"], signal),
		);
		for (const r of [undefined, ...radios]) {
			const c = r ? this.config.radios[r] : this.config;
			const matching = rules.filter((x) => x.priority === c.priority);
			if (matching.length !== 1 || !this.ruleMatches(matching[0] ?? {}, r))
				throw new Error("Policy rule readback failed");
			const rows = await this.routes(c.table, signal);
			if (
				rows.length !== (r ? 2 : 3) ||
				rows.some((x) => !this.allowedRoute(x, r))
			)
				throw new Error("Policy route readback failed");
			if (
				!r &&
				holder &&
				!rows.some(
					(x) =>
						(x.dst === this.config.target ||
							x.dst === `${this.config.target}/32`) &&
						x.dev === this.states.get(holder)?.ifname,
				)
			)
				throw new Error("Holder readback failed");
		}
	}
	async apply(
		intent: Parameters<NetworkOwner["apply"]>[0],
		_scope: string,
		signal: AbortSignal,
	) {
		await this.verify(signal);
		const current = await this.identity(intent.effect.radio, signal);
		if (
			current.permanentMac !== intent.identity.permanentMac ||
			current.physical !== intent.identity.physical ||
			!sameEpoch(current.epoch, intent.identity.epoch)
		)
			return false;
		if (intent.effect.action === "promote")
			await this.ip(
				this.routeArgs(intent.effect.radio, this.config.table, "replace"),
				signal,
			);
		else if (!["demote", "disconnect"].includes(intent.effect.action))
			return false;
		// demote/release are logical only: both stations and oif rules survive.
		await this.verify(
			signal,
			intent.effect.action === "promote"
				? intent.effect.radio
				: intent.effect.radio === "a"
					? "b"
					: "a",
		);
		return true;
	}
	async cancelAndDrain(
		_record: Parameters<NetworkOwner["cancelAndDrain"]>[0],
		signal: AbortSignal,
	) {
		await this.verify(signal);
		return true;
	}
	async restore(holder: Holder, signal: AbortSignal) {
		const current = await this.identity(holder.radio, signal);
		if (
			current.permanentMac !== holder.identity.permanentMac ||
			current.physical !== holder.identity.physical ||
			!sameEpoch(current.epoch, holder.identity.epoch)
		)
			return false;
		await this.verify(signal);
		await this.ip(
			this.routeArgs(holder.radio, this.config.table, "replace"),
			signal,
		);
		await this.verify(signal, holder.radio);
		return true;
	}
	async readback(holder: Holder, signal: AbortSignal) {
		await this.verify(signal, holder.radio);
		const current = await this.identity(holder.radio, signal);
		return (
			current.physical === holder.identity.physical &&
			current.permanentMac === holder.identity.permanentMac &&
			sameEpoch(current.epoch, holder.identity.epoch)
		);
	}
	async removeOwned(_scope: string, signal: AbortSignal) {
		// Operations borrow installation-owned resources and create none. Never flush.
		await this.verify(signal);
		return true;
	}
}

/** Exact permanent MAC + PHY + physical USB path, re-resolved on every fence.
 * nmcli reads only; no activation/reapply request can outlive this owner. */
export function nativeObserver(
	config: LiveConfig,
	runner: Runner = run,
	sysfsRoot = "/sys/class/net",
	nmEpoch = readNmEpoch,
): NativeDeps["observe"] {
	return async (radio, signal) => {
		const expected = config.radios[radio];
		const matches: string[] = [];
		for (const name of await readdir(sysfsRoot)) {
			signal.throwIfAborted();
			try {
				const base = `${sysfsRoot}/${name}`;
				if (
					(await realpath(`${base}/phy80211`)).split("/").at(-1) !==
						expected.phy ||
					(await realpath(`${base}/device`)) !== expected.usbPath
				)
					continue;
				const data = await readFile(`${base}/phy80211/macaddress`, "utf8");
				if (data.trim().toLowerCase() === expected.permanentMac.toLowerCase())
					matches.push(name);
			} catch {
				signal.throwIfAborted();
			}
		}
		if (matches.length !== 1)
			throw new Error("Radio identity unavailable or ambiguous");
		const ifname = matches[0] as string;
		const query = () =>
			runner(
				"nmcli",
				[
					"-g",
					"GENERAL.STATE,GENERAL.CON-PATH,IP4.ADDRESS,IP4.GATEWAY",
					"device",
					"show",
					ifname,
				],
				{ signal, timeout: 1000 },
			);
		const incarnation = await nmEpoch(signal);
		const before = await query();
		const [state, activation, address, gateway] = before.trim().split("\n");
		if (
			!state?.startsWith("100 ") ||
			!activation?.startsWith("/org/") ||
			!address ||
			!gateway
		)
			throw new Error("NM not activated");
		const link = JSON.parse(
			await runner(
				"ip",
				["-j", "-4", "route", "show", "dev", ifname, "scope", "link"],
				{ signal, timeout: 1000 },
			),
		) as { dst: string }[];
		const subnet = link.find((x) => x.dst.includes("/"))?.dst;
		const iw = await runner("iw", ["dev", ifname, "link"], {
			signal,
			timeout: 1000,
		});
		const bssid = /Connected to ([0-9a-f:]+)/i.exec(iw)?.[1];
		if (
			!subnet ||
			!bssid ||
			before !== (await query()) ||
			incarnation !== (await nmEpoch(signal))
		)
			throw new Error("Unsettled NM identity");
		ipv4.parse(gateway);
		const base = `${sysfsRoot}/${ifname}`;
		if (
			(await realpath(`${base}/phy80211`)).split("/").at(-1) !== expected.phy ||
			(await realpath(`${base}/device`)) !== expected.usbPath ||
			(await readFile(`${base}/phy80211/macaddress`, "utf8"))
				.trim()
				.toLowerCase() !== expected.permanentMac.toLowerCase()
		)
			throw new Error("Physical radio changed during NM read");
		return {
			ifname,
			subnet,
			gateway,
			identity: {
				physical: JSON.stringify([
					expected.permanentMac.toLowerCase(),
					expected.phy,
					expected.usbPath,
				]),
				permanentMac: expected.permanentMac.toLowerCase(),
				epoch: {
					activation: `${incarnation}|${activation}`,
					bssid,
					lease: `${address}|${gateway}`,
					routeGeneration: Number(
						(await readFile(`${sysfsRoot}/${ifname}/ifindex`, "utf8")).trim(),
					),
				},
			},
		};
	};
}
