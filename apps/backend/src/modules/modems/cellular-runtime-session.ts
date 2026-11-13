import type { SourceBoundHttpsResult } from "../../helpers/source-bound-https.ts";
import type {
	CellularDnsResult,
	CellularProbePath,
} from "../network/cellular-path-probe.ts";
import {
	probeCellularDns,
	probeCellularHttps,
} from "../network/cellular-path-probe.ts";
import type { CellularDataGrant } from "./cellular-grant.ts";
import type { CellularPathSession } from "./cellular-path-owner.ts";

type Installable = CellularPathSession & { install(): Promise<void> };
export interface CellularRuntimeBootstrap {
	install(): Promise<void>;
	discover(): Promise<string | undefined>;
	cancelProbe(): void;
	cleanup(): Promise<boolean>;
}
export interface CellularRuntimeSessionDeps {
	readonly current: () => Promise<boolean>;
	readonly currentNow: () => boolean;
	readonly withdraw: () => void;
	/** Factories return retained owners before their first effect. */
	readonly bootstrap: (
		consumersReleased: () => Promise<boolean>,
	) => Promise<CellularRuntimeBootstrap | undefined>;
	readonly host: (
		prefix: string | undefined,
		consumersReleased: () => Promise<boolean>,
		cancelProbe: () => void,
	) => Promise<Installable | undefined>;
	readonly consumersReleased: () => Promise<boolean>;
	/** Read the actual born TUN index; never use a guessed or remembered index. */
	readonly httpsPath: (
		host: CellularPathSession,
	) => Promise<
		Pick<CellularProbePath, "device" | "source" | "ifindex"> | undefined
	>;
	readonly dns?: (
		path: CellularProbePath,
		signal: AbortSignal,
	) => Promise<CellularDnsResult>;
	readonly https?: (
		path: Pick<CellularProbePath, "device" | "source" | "ifindex">,
		signal: AbortSignal,
	) => Promise<SourceBoundHttpsResult>;
}
/** One observation's retained runtime owner. The caller stores this object
 * BEFORE install, including a failed/uncertain install. Discovery completely
 * withdraws its DNS-only stage before final host authority can claim the slot.
 * An aborted probe remains a consumer until its actual promise settles.
 */
export class CellularRuntimeSession implements CellularPathSession {
	readonly binding;
	readonly dns: CellularProbePath;
	private bootstrap: CellularRuntimeBootstrap | undefined;
	private host: Installable | undefined;
	private prefix: string | undefined;
	private attempted = false;
	private closing = false;
	private retired = false;
	private prefixChanged = false;
	private pending: Promise<"ok" | "failed" | "unavailable"> | undefined;
	private abort: AbortController | undefined;
	private tail: Promise<void> = Promise.resolve();
	constructor(
		readonly grant: CellularDataGrant,
		readonly slot: number,
		epoch: string,
		private readonly deps: CellularRuntimeSessionDeps,
	) {
		if (!Number.isInteger(slot) || slot < 1 || slot > 32 || !epoch)
			throw new Error("Invalid runtime cellular session identity");
		this.binding = Object.freeze({
			source: grant.family === "ipv4" ? grant.source : `198.18.255.${slot}`,
			device: grant.family === "ipv4" ? grant.physical.ifname : `cclat${slot}`,
			translated: grant.family === "ipv6",
			generation: epoch,
		});
		this.dns = Object.freeze({
			source: grant.source,
			device: grant.physical.ifname,
			ifindex: Number(grant.physical.ifindex),
			dns: grant.dns,
		});
	}
	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const job = this.tail.then(operation);
		this.tail = job.then(
			() => undefined,
			() => undefined,
		);
		return job;
	}
	private async current(): Promise<boolean> {
		const permitted = () =>
			!this.closing &&
			!this.retired &&
			!this.prefixChanged &&
			this.deps.currentNow();
		return permitted() && (await this.deps.current()) && permitted();
	}
	private consumersReleased = async (): Promise<boolean> =>
		!this.pending && (await this.deps.consumersReleased()) && !this.pending;
	install(): Promise<void> {
		return this.serial(async () => {
			if (this.attempted || !(await this.current()))
				throw new Error("Runtime cellular session unavailable");
			this.attempted = true;
			if (this.grant.family === "ipv6") {
				this.bootstrap = await this.deps.bootstrap(this.consumersReleased);
				if (!this.bootstrap)
					throw new Error("Runtime discovery slot unavailable");
				await this.bootstrap.install();
				this.prefix = await this.bootstrap.discover();
				if (!(await this.bootstrap.cleanup()))
					throw new Error("Runtime discovery withdrawal incomplete");
				this.bootstrap = undefined;
				if (!this.prefix) throw new Error("Runtime NAT64 prefix unavailable");
			}
			if (!(await this.current()))
				throw new Error("Runtime cellular grant retired");
			this.host = await this.deps.host(
				this.prefix,
				this.consumersReleased,
				this.cancelProbe,
			);
			if (!this.host) throw new Error("Runtime host slot unavailable");
			// The object is retained even when the first durable write or a kernel
			// acknowledgement fails. Cleanup is the only next operation.
			await this.host.install();
		});
	}
	async valid(): Promise<boolean> {
		return (
			!!this.host &&
			!this.bootstrap &&
			(await this.current()) &&
			(await this.host.valid()) &&
			(await this.current())
		);
	}
	async prepareProbe(): Promise<boolean> {
		return (
			(await this.valid()) &&
			!!this.host &&
			(await this.host.prepareProbe()) &&
			(await this.current())
		);
	}
	async setReady(ready: boolean): Promise<boolean> {
		if (!this.host || this.closing || this.retired) return false;
		if (ready && !(await this.valid())) return false;
		return (
			(await this.host.setReady(ready)) && (!ready || (await this.current()))
		);
	}
	cancelProbe = (): void => {
		this.abort?.abort();
		this.bootstrap?.cancelProbe();
	};
	/** The path owner reserves the whole finite DNS+HTTPS allowance first. */
	probe(): Promise<"ok" | "failed" | "unavailable"> {
		if (this.pending) return Promise.resolve("unavailable");
		const host = this.host;
		if (!host) return Promise.resolve("unavailable");
		const abort = new AbortController();
		this.abort = abort;
		const pending = Promise.resolve()
			.then(async (): Promise<"ok" | "failed" | "unavailable"> => {
				if (abort.signal.aborted || !(await this.valid())) return "unavailable";
				const dns = await (
					this.deps.dns ??
					((path, signal) => probeCellularDns(path, undefined, signal))
				)(this.dns, abort.signal);
				if (abort.signal.aborted || !(await this.valid())) return "unavailable";
				if (!dns.ok) return dns.unavailable ? "unavailable" : "failed";
				if (this.grant.family === "ipv6" && dns.nat64 !== this.prefix) {
					// Prefix lifetime is independent of address lifetime. This is a new
					// grant/discovery requirement, never evidence to reset the modem.
					this.prefixChanged = true;
					this.deps.withdraw();
					await host.setReady(false);
					return "unavailable";
				}
				const path = await this.deps.httpsPath(host);
				if (!path || abort.signal.aborted || !(await this.valid()))
					return "unavailable";
				const result = await (
					this.deps.https ??
					((path, signal) => probeCellularHttps(path, undefined, signal))
				)(path, abort.signal);
				return abort.signal.aborted || !(await this.valid())
					? "unavailable"
					: result === "ok"
						? "ok"
						: result === "unavailable"
							? "unavailable"
							: "failed";
			})
			.catch(() => "unavailable" as const)
			.finally(() => {
				if (this.pending === pending) {
					this.pending = undefined;
					this.abort = undefined;
				}
			});
		this.pending = pending;
		return pending;
	}
	cleanup(): Promise<boolean> {
		this.closing = true;
		this.cancelProbe();
		this.deps.withdraw();
		return this.serial(async () => {
			if (this.retired) return true;
			// Host cleanup denies traffic before checking these consumers. Never
			// block that fence behind a probe that ignores cancellation.
			if (this.host && !(await this.host.cleanup())) return false;
			if (this.bootstrap && !(await this.bootstrap.cleanup())) return false;
			if (this.pending || !(await this.consumersReleased())) return false;
			this.host = undefined;
			this.bootstrap = undefined;
			this.retired = true;
			return true;
		});
	}
}
