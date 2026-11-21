/*
 * The sender's own invocation: which process it is, which unit holds it, and
 * which engine session it was started for. The lifetime record stores these at
 * launch; a restarted backend reads them again live and compares.
 *
 *   - Process: PID, start time and state come from one `/proc/<pid>/stat`
 *     read, bracketed by a pidfd where the system has one, with the boot id
 *     read in the same capture. A PID the kernel has since given to another
 *     process has another start time; a process that exits during the read is
 *     caught by the pidfd.
 *   - Unit: a sender that outlives the backend runs in its own systemd unit.
 *     The unit is found from the sender's cgroup and read with
 *     `systemctl show`: its InvocationID (assigned by PID 1 per start), main
 *     PID, state, control group and restart policy.
 *   - Engine session: the session id the engine reports for its running
 *     session, scoped by the engine unit's InvocationID and main PID, so the
 *     same id from a restarted engine never matches.
 */

import { readFile } from "node:fs/promises";
import { type ProcessPin, pinProcess } from "../../helpers/process-pin.ts";
import { run } from "../../helpers/run.ts";
import { ENGINE_UNIT } from "./engine-unit-state.ts";

export type ProcessInvocation = {
	readonly pid: number;
	readonly startTime: string;
	readonly state: string;
	readonly processGroup: number;
	readonly bootId: string;
	/** True when a pidfd bracketed the read; false when none was available. */
	readonly pidfd: boolean;
};

export type ProcessInvocationIo = {
	readonly procRoot: string;
	readonly readStat: (path: string) => Promise<string>;
	readonly bootId: () => Promise<string>;
	readonly pin: (pid: number) => Promise<ProcessPin | null>;
};

export const processInvocationIo: ProcessInvocationIo = {
	procRoot: "/proc",
	readStat: (path) => readFile(path, "utf8"),
	bootId: async () =>
		(await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
	pin: pinProcess,
};

export function statFields(stat: string): string[] {
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

/**
 * One process's invocation, or null when it is gone, exits during the read,
 * or the read is unusable. Never throws.
 */
export async function captureProcessInvocation(
	pid: number,
	io: ProcessInvocationIo = processInvocationIo,
): Promise<ProcessInvocation | null> {
	const pin = await io.pin(pid).catch(() => null);
	if (!pin) return null;
	try {
		const stat = await io.readStat(`${io.procRoot}/${pid}/stat`);
		const bootId = await io.bootId();
		// Alive now, so alive throughout the read: the stat is this process's.
		if (!pin.alive()) return null;
		const fields = statFields(stat);
		const startTime = fields[19] ?? "";
		const processGroup = Number(fields[2]);
		if (
			!/^\d+$/.test(startTime) ||
			!Number.isSafeInteger(processGroup) ||
			!bootId
		)
			return null;
		return {
			pid,
			startTime,
			state: fields[0] ?? "",
			processGroup,
			bootId,
			pidfd: pin.pidfd,
		};
	} catch {
		return null;
	} finally {
		pin.close();
	}
}

export type UnitManager = "system" | "user";

export type UnitFacts = {
	readonly unit: string;
	readonly invocation: string;
	readonly mainPid: number;
	readonly activeState: string;
	readonly subState: string;
	readonly controlGroup: string;
	readonly restart: string;
};

const INVOCATION_RE = /^[0-9a-f]{32}$/;
const UNIT_RE = /^[A-Za-z0-9:_.\\@-]+\.(service|scope)$/;
const UNIT_PROPERTIES =
	"Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup,Restart";

/** `systemctl show` key=value output for a loaded unit, or null. */
export function parseUnitShow(stdout: string): UnitFacts | null {
	const rows = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) rows.set(line.slice(0, at), line.slice(at + 1).trim());
	}
	const invocation = rows.get("InvocationID") ?? "";
	// Scopes have no main process and systemd prints no MainPID for them.
	const mainPid = Number(rows.get("MainPID") ?? "0");
	if (
		rows.get("LoadState") !== "loaded" ||
		!INVOCATION_RE.test(invocation) ||
		!Number.isSafeInteger(mainPid)
	)
		return null;
	return {
		unit: rows.get("Id") ?? "",
		invocation,
		mainPid,
		activeState: rows.get("ActiveState") ?? "",
		subState: rows.get("SubState") ?? "",
		controlGroup: rows.get("ControlGroup") ?? "",
		// Scopes have no restart policy; systemd prints none for them.
		restart: rows.get("Restart") ?? "no",
	};
}

/** The unit that owns a cgroup path, and the manager that runs it. */
export function unitOfCgroup(
	cgroup: string,
): { unit: string; manager: UnitManager } | null {
	const parts = cgroup.split("/").filter((part) => part.length > 0);
	const unit = parts.at(-1);
	if (!unit || !UNIT_RE.test(unit)) return null;
	const manager = parts.some((part) => /^user@\d+\.service$/.test(part))
		? "user"
		: "system";
	if (manager === "user" && /^user@\d+\.service$/.test(unit)) return null;
	return { unit, manager };
}

export type UnitShow = (unit: string, manager: UnitManager) => Promise<string>;

export const systemctlShow: UnitShow = (unit, manager) =>
	run(
		"systemctl",
		[
			...(manager === "user" ? ["--user"] : []),
			"show",
			`--property=${UNIT_PROPERTIES}`,
			"--",
			unit,
		],
		{ timeout: 3_000, maxBuffer: 8192 },
	);

/** Live facts for `unit`; null when unknown, unloaded or unreadable. */
export async function readUnitFacts(
	unit: string,
	manager: UnitManager,
	show: UnitShow = systemctlShow,
): Promise<UnitFacts | null> {
	if (!UNIT_RE.test(unit)) return null;
	try {
		const facts = parseUnitShow(await show(unit, manager));
		return facts?.unit === unit ? facts : null;
	} catch {
		return null;
	}
}

/** The unified-hierarchy cgroup of a process, or null. */
export async function readProcessCgroup(
	procRoot: string,
	pid: number | "self",
): Promise<string | null> {
	try {
		const line = (await readFile(`${procRoot}/${pid}/cgroup`, "utf8"))
			.split("\n")
			.find((entry) => entry.startsWith("0::"));
		return line ? line.slice(3) : null;
	} catch {
		return null;
	}
}

export type SenderHost =
	| { readonly host: "backend-child" }
	| {
			readonly host: "systemd";
			readonly unit: string;
			readonly manager: UnitManager;
			readonly invocation: string;
			readonly cgroup: string;
	  };

/**
 * Who hosts a freshly started sender, from live facts only. A sender in the
 * backend's own cgroup dies with the backend. Only a sender that is the main
 * process of its own active unit, alone in that unit's control group, is
 * recorded as `systemd`; anything else is recorded as a backend child, which
 * adoption refuses.
 */
export async function senderHost(
	pid: number,
	io: {
		readonly procRoot: string;
		readonly show: UnitShow;
	} = { procRoot: "/proc", show: systemctlShow },
): Promise<SenderHost> {
	const child: SenderHost = { host: "backend-child" };
	const cgroup = await readProcessCgroup(io.procRoot, pid);
	const own = await readProcessCgroup(io.procRoot, "self");
	if (!cgroup || !own || cgroup === own) return child;
	const owner = unitOfCgroup(cgroup);
	if (!owner) return child;
	const facts = await readUnitFacts(owner.unit, owner.manager, io.show);
	if (
		!facts ||
		facts.mainPid !== pid ||
		facts.activeState !== "active" ||
		facts.controlGroup !== cgroup
	)
		return child;
	return {
		host: "systemd",
		unit: owner.unit,
		manager: owner.manager,
		invocation: facts.invocation,
		cgroup,
	};
}

export type EngineSessionIdentity = {
	/** InvocationID of the engine unit. */
	readonly invocation: string;
	/** The engine unit's main PID. */
	readonly mainPid: number;
	/** The engine's own id for its running session. */
	readonly sessionId: string;
};

/**
 * The engine's session, scoped by its unit's invocation. `sessionId` asks the
 * engine; null from it, or an engine unit that is not active with a main
 * process, means no identity.
 */
export async function readEngineSessionIdentity(
	sessionId: () => Promise<string | null>,
	show: UnitShow = systemctlShow,
): Promise<EngineSessionIdentity | null> {
	const before = await readUnitFacts(ENGINE_UNIT, "system", show);
	if (before?.activeState !== "active" || before.mainPid <= 0) return null;
	const id = await sessionId().catch(() => null);
	if (!id) return null;
	// The same engine process before and after the question.
	const after = await readUnitFacts(ENGINE_UNIT, "system", show);
	if (
		!after ||
		after.invocation !== before.invocation ||
		after.mainPid !== before.mainPid
	)
		return null;
	return {
		invocation: before.invocation,
		mainPid: before.mainPid,
		sessionId: id,
	};
}
