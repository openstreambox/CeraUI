import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	type SpawnWithTimeoutResult,
	spawnWithTimeout,
} from "../../helpers/spawn-policy.ts";
import { parseOsStageSystemdProperties } from "../system/update-orchestrator/os-stage-systemd.ts";

export const CELLULAR_TRANSLATOR_BINARY = "/usr/lib/ceralive/clat/tayga";
export interface CellularTranslatorIdentity {
	readonly slot: number;
	readonly owner: string;
	readonly epoch: string;
	/** Preallocated and persisted before submission; never reused for another call. */
	readonly birth: string;
}
export function cellularTranslatorUnit(
	identity: CellularTranslatorIdentity,
): string {
	if (
		!Number.isInteger(identity.slot) ||
		identity.slot < 1 ||
		identity.slot > 32 ||
		!/^[a-f0-9]{64}$/.test(identity.owner) ||
		!identity.epoch ||
		identity.epoch.length > 256 ||
		!/^[a-f0-9]{32}$/.test(identity.birth)
	)
		throw new Error("Invalid translator service identity");
	return `ceralive-cellular-clat-${identity.slot}-${identity.birth}.service`;
}
export function cellularTranslatorConfigKey(
	identity: CellularTranslatorIdentity,
): string {
	cellularTranslatorUnit(identity);
	return createHash("sha256")
		.update(
			JSON.stringify([
				identity.slot,
				identity.owner,
				identity.epoch,
				identity.birth,
			]),
		)
		.digest("hex");
}
function description(identity: CellularTranslatorIdentity): string {
	return `Cellular translator ${identity.owner} ${createHash("sha256").update(identity.epoch).digest("hex")} ${identity.birth}`;
}
const PROPERTIES =
	"Id,LoadState,ActiveState,SubState,Transient,Type,User,Restart,KillMode,Description,InvocationID,MainPID,ControlPID,Job,ControlGroup,ExecStart";
export type CellularTranslatorState =
	| { readonly kind: "absent" }
	| { readonly kind: "foreign" }
	| {
			readonly kind: "owned";
			readonly running: boolean;
			readonly invocation: string;
			readonly pid: number;
	  };
export interface CellularTranslatorIO {
	readonly command: (
		argv: string[],
		timeoutMs: number,
	) => Promise<SpawnWithTimeoutResult>;
	readonly current: () => Promise<boolean>;
	/** The durable birth record and slot lease still belong to this callback. */
	readonly owned: () => Promise<boolean>;
	readonly configuration: () => Promise<string | undefined>;
}
export function cellularTranslatorIO(
	current: () => Promise<boolean>,
	owned: () => Promise<boolean>,
	configuration: () => Promise<string | undefined>,
): CellularTranslatorIO {
	return {
		current,
		owned,
		configuration,
		command: (argv, timeoutMs) =>
			spawnWithTimeout(argv, { timeoutMs, maxBuffer: 64 * 1024 }),
	};
}
function commandMatches(raw: string | undefined, config: string): boolean {
	if (!raw?.startsWith("{ ") || !raw.endsWith(" }")) return false;
	const fields = new Map<string, string>();
	for (const segment of raw.slice(2, -2).split(" ; ")) {
		const at = segment.indexOf("="),
			name = segment.slice(0, at);
		if (
			at < 1 ||
			fields.has(name) ||
			![
				"path",
				"argv[]",
				"ignore_errors",
				"start_time",
				"stop_time",
				"pid",
				"code",
				"status",
			].includes(name)
		)
			return false;
		fields.set(name, segment.slice(at + 1));
	}
	return (
		fields.get("path") === CELLULAR_TRANSLATOR_BINARY &&
		fields.get("argv[]") ===
			`${CELLULAR_TRANSLATOR_BINARY} --config ${config} --nodetach` &&
		fields.get("ignore_errors") === "no"
	);
}
export function parseCellularTranslatorState(
	identity: CellularTranslatorIdentity,
	config: string,
	result: SpawnWithTimeoutResult,
): CellularTranslatorState {
	if (result.exitCode !== 0 && result.exitCode !== 1)
		throw new Error("Translator service observation unavailable");
	const rows = parseOsStageSystemdProperties(result.stdout);
	if (!rows) throw new Error("Translator service properties contradictory");
	if (rows.get("LoadState") === "not-found") return { kind: "absent" };
	if (result.exitCode !== 0 || rows.get("LoadState") !== "loaded")
		throw new Error("Translator service state unavailable");
	const unit = cellularTranslatorUnit(identity);
	for (const [name, value] of Object.entries({
		Id: unit,
		Transient: "yes",
		Type: "exec",
		User: "root",
		Restart: "no",
		KillMode: "control-group",
		Description: description(identity),
	}))
		if (rows.get(name) !== value) return { kind: "foreign" };
	if (!commandMatches(rows.get("ExecStart"), config))
		return { kind: "foreign" };
	const pid = rows.get("MainPID"),
		invocation = rows.get("InvocationID");
	if (
		!pid ||
		!/^\d+$/.test(pid) ||
		Number(pid) > 0x7fffffff ||
		invocation === undefined ||
		(invocation !== "" && !/^[a-f0-9]{32}$/.test(invocation))
	)
		throw new Error("Translator process observation malformed");
	const active = rows.get("ActiveState"),
		sub = rows.get("SubState"),
		group = rows.get("ControlGroup");
	const running =
		active === "active" &&
		sub === "running" &&
		Number(pid) > 1 &&
		!!invocation &&
		rows.get("ControlPID") === "0" &&
		rows.get("Job") === "0" &&
		group === `/system.slice/${unit}`;
	if (
		!running &&
		!(
			["activating", "deactivating", "inactive", "failed"].includes(
				active ?? "",
			) &&
			sub !== undefined &&
			group !== undefined
		)
	)
		throw new Error("Translator service lifecycle unknown");
	return { kind: "owned", running, invocation, pid: Number(pid) };
}
/** One unique transient unit per durable birth. A reconnect gets a fresh birth
 * token, so a delayed Stop can never address its successor's unit name. PID 1
 * owns the child lifetime; this adapter has no automatic restart authority.
 */
export class CellularTranslator {
	private submitted = false;
	readonly unit: string;
	readonly config: string;
	constructor(
		readonly identity: CellularTranslatorIdentity,
		configDirectory: string,
		private readonly expectedConfiguration: string,
		private readonly io: CellularTranslatorIO,
	) {
		this.unit = cellularTranslatorUnit(identity);
		if (
			!/^\/[a-zA-Z0-9_./-]+$/.test(configDirectory) ||
			configDirectory.split("/").some((part) => part === "." || part === "..")
		)
			throw new Error("Invalid translator configuration directory");
		this.config = join(
			configDirectory,
			`${cellularTranslatorConfigKey(identity)}.conf`,
		);
	}
	async inspect(invocation?: string): Promise<CellularTranslatorState> {
		const result = await this.io.command(
			[
				"systemctl",
				"show",
				this.unit,
				`--property=${PROPERTIES}`,
				"--no-pager",
			],
			4000,
		);
		const state = parseCellularTranslatorState(
			this.identity,
			this.config,
			result,
		);
		return state.kind === "owned" &&
			invocation !== undefined &&
			state.invocation !== invocation
			? { kind: "foreign" }
			: state;
	}
	async start(): Promise<string | undefined> {
		if (this.submitted)
			throw new Error("Translator birth was already submitted");
		if (
			!(await this.io.owned()) ||
			!(await this.io.current()) ||
			(await this.io.configuration()) !== this.expectedConfiguration ||
			(await this.inspect()).kind !== "absent" ||
			!(await this.io.owned()) ||
			!(await this.io.current())
		)
			throw new Error("Translator service birth unavailable");
		if (this.submitted)
			throw new Error("Translator birth was already submitted");
		this.submitted = true;
		const result = await this.io.command(
			[
				"systemd-run",
				`--unit=${this.unit}`,
				"--service-type=exec",
				"--collect",
				"--property=User=root",
				"--property=Restart=no",
				"--property=KillMode=control-group",
				"--property=TimeoutStopSec=3s",
				`--property=Description=${description(this.identity)}`,
				"--",
				CELLULAR_TRANSLATOR_BINARY,
				"--config",
				this.config,
				"--nodetach",
			],
			8000,
		);
		if (result.exitCode !== 0)
			throw new Error("Translator service start unconfirmed");
		const state = await this.inspect();
		return (await this.io.owned()) &&
			(await this.io.current()) &&
			state.kind === "owned" &&
			state.running
			? state.invocation
			: undefined;
	}
	async stop(invocation: string): Promise<boolean> {
		if (!/^[a-f0-9]{32}$/.test(invocation) || !(await this.io.owned()))
			return false;
		const state = await this.inspect(invocation);
		if (state.kind === "absent") return true;
		if (state.kind !== "owned" || !(await this.io.owned())) return false;
		const result = await this.io.command(
			["systemctl", "stop", this.unit],
			6000,
		);
		if (result.exitCode !== 0) return false;
		return (await this.inspect(invocation)).kind === "absent";
	}
}
