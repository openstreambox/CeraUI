import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { run } from "../../helpers/run.ts";
import { isRecoveryPending } from "../streaming/recovery-barrier.ts";
import { parseOsStageSystemdProperties } from "../system/update-orchestrator/os-stage-systemd.ts";

const group = "/system.slice/ceralive.service";
const properties = [
	"LoadState",
	"ActiveState",
	"SubState",
	"MainPID",
	"ControlPID",
	"ControlGroup",
	"InvocationID",
	"KillMode",
	"SendSIGKILL",
	"Delegate",
];
async function boundedKernelText(path: string): Promise<string> {
	const handle = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const bytes = Buffer.alloc(8193);
		let used = 0;
		while (used < bytes.length) {
			const reply = await handle.read(bytes, used, bytes.length - used, null);
			if (!reply.bytesRead) break;
			used += reply.bytesRead;
		}
		if (used > 8192)
			throw new Error("Kernel consumer observation exceeds limit");
		return new TextDecoder("utf-8", { fatal: true }).decode(
			bytes.subarray(0, used),
		);
	} finally {
		await handle.close();
	}
}
export interface CellularConsumerCensusIO {
	readonly pid: number;
	/** Existing startup barrier also excludes managed probes and new senders. */
	readonly quiet: () => boolean;
	readonly service: () => Promise<string>;
	readonly read: (path: string) => Promise<string>;
	readonly noChildGroups: () => Promise<boolean>;
}
const host: CellularConsumerCensusIO = {
	pid: process.pid,
	quiet: isRecoveryPending,
	service: () =>
		run(
			"systemctl",
			[
				"show",
				"ceralive.service",
				"--no-pager",
				...properties.map((key) => `--property=${key}`),
			],
			{ timeout: 4000, maxBuffer: 8192 },
		),
	read: boundedKernelText,
	noChildGroups: async () => {
		const directory = await opendir(`/sys/fs/cgroup${group}`);
		let count = 0;
		for await (const entry of directory) {
			if (++count > 4096 || entry.isDirectory() || entry.isSymbolicLink())
				return false;
		}
		return true;
	},
};
function parseService(text: string, pid: number): string | undefined {
	const value = parseOsStageSystemdProperties(text);
	if (
		!value ||
		properties.some((key) => !value.has(key)) ||
		value.size !== properties.length ||
		value.get("LoadState") !== "loaded" ||
		value.get("MainPID") !== String(pid) ||
		value.get("ControlPID") !== "0" ||
		value.get("ControlGroup") !== group ||
		!["mixed", "control-group"].includes(value.get("KillMode") ?? "") ||
		value.get("SendSIGKILL") !== "yes" ||
		value.get("Delegate") !== "no" ||
		!(
			(value.get("ActiveState") === "active" &&
				value.get("SubState") === "running") ||
			(value.get("ActiveState") === "activating" &&
				value.get("SubState") === "start")
		)
	)
		return undefined;
	const invocation = value.get("InvocationID");
	return invocation && /^[a-f0-9]{32}$/.test(invocation)
		? invocation
		: undefined;
}
/** Positive absence only inside the qualified service lifetime. Sender children
 * inherit this nondelegated cgroup and mixed/control-group teardown kills the
 * previous invocation before restart. A second PID, subgroup, service change,
 * missing property or read error is unknown. No process is adopted or killed.
 * The separately owned translator service is settled by its own inverse.
 */
export async function cellularConsumersAbsent(
	io: CellularConsumerCensusIO = host,
): Promise<boolean> {
	try {
		if (!io.quiet() || !Number.isInteger(io.pid) || io.pid < 1) return false;
		const before = parseService(await io.service(), io.pid);
		if (!before) return false;
		for (let pass = 0; pass < 2; pass++) {
			if (
				!io.quiet() ||
				(await io.read("/proc/self/cgroup")).trim() !== `0::${group}` ||
				!(await io.noChildGroups())
			)
				return false;
			const text = (
				await io.read(`/sys/fs/cgroup${group}/cgroup.procs`)
			).trim();
			if (text !== String(io.pid)) return false;
		}
		return parseService(await io.service(), io.pid) === before && io.quiet();
	} catch {
		return false;
	}
}
