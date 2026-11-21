/*
 * A scripted systemd manager for srtla-send.service, behind the SenderUnitIo
 * seam. Files are real (a private temp directory stands in for
 * /run/srtla-send); systemctl, /proc reads, the control probe, the update lock
 * and time are simulated, so no test starts a unit or waits in real time.
 */

import { readFileSync } from "node:fs";
import { lstat, rename, rm } from "node:fs/promises";
import {
	productionSenderUnitIo,
	type SenderUnitIo,
	senderUnitPaths,
} from "../../modules/streaming/streamloop/sender-unit.ts";

export type FakeUnitState = {
	load: string;
	active: string;
	sub: string;
	mainPid: number;
	invocation: string;
	cgroup: string;
	result: string;
	code: number;
	status: number;
	restarts: number;
	job: string;
};

/** What the next `systemctl start` (or automatic restart) produces. */
export type StartOutcome =
	/** The launcher runs `launcherTicks` sleeps, then the sender answers. */
	| { kind: "ready"; launcherTicks?: number }
	/** The launcher exits with `status` (78: refused; 2: sender usage). */
	| { kind: "exit"; status: number }
	/** The sender runs but never answers on its socket. */
	| { kind: "silent" }
	/** systemd refuses the start itself (start limit, ...). */
	| { kind: "refused" };

export class FakeSenderUnit {
	readonly calls: string[][] = [];
	readonly signals: Array<{ pid: number; signal: string }> = [];
	state: FakeUnitState = {
		load: "loaded",
		active: "inactive",
		sub: "dead",
		mainPid: 0,
		invocation: "",
		cgroup: "",
		result: "success",
		code: 0,
		status: 0,
		restarts: 0,
		job: "",
	};
	next: StartOutcome = { kind: "ready" };
	lockBusy = false;
	/** ExecMainCode after a stop; real systemd sometimes reports 0 (unknown). */
	stopExitCode = 1;
	/** `systemctl show` fails while set. */
	showFails = false;
	/** `systemctl stop` fails and leaves the unit as it is while set. */
	stopFails = false;
	/** `systemctl start` times out while its job still brings the unit up. */
	startTimesOut = false;
	/** Simulated time each systemctl call takes. */
	systemctlMs = 0;
	lockHeld = 0;
	lockReleased = 0;
	/** argv bytes the launcher saw at each start. */
	readonly published: Uint8Array[] = [];
	clock = 0;
	private nextPid = 4000;
	private nextInvocation = 1;
	private launcherLeft = 0;
	private answering = false;
	/** Monitor callbacks the handle has scheduled; tests call tick() instead. */
	readonly scheduled: Array<() => void> = [];
	/** Called after each simulated sleep, to script events between polls. */
	onSleep: (() => void) | null = null;

	constructor(readonly dir: string) {}

	private begin(outcome: StartOutcome): void {
		this.state.invocation = `inv-${this.nextInvocation++}`;
		this.state.cgroup = "/system.slice/srtla-send.service";
		if (outcome.kind === "exit") {
			this.state = {
				...this.state,
				active: "failed",
				sub: "failed",
				mainPid: 0,
				result: "exit-code",
				code: 1,
				status: outcome.status,
			};
			return;
		}
		this.state.active = "active";
		this.state.sub = "running";
		this.state.mainPid = this.nextPid++;
		this.state.result = "success";
		this.launcherLeft =
			outcome.kind === "ready" ? (outcome.launcherTicks ?? 0) : 0;
		this.answering = outcome.kind === "ready";
	}

	/** The running sender dies; systemd will restart it (auto-restart). */
	crash(signal = 11): void {
		this.state = {
			...this.state,
			active: "activating",
			sub: "auto-restart",
			mainPid: 0,
			result: "signal",
			code: 2,
			status: signal,
			restarts: this.state.restarts + 1,
		};
		this.answering = false;
	}

	/** systemd's restart after RestartSec. */
	restart(outcome: StartOutcome = { kind: "ready" }): void {
		this.capture();
		this.begin(outcome);
	}

	/** systemd gives up on the unit (start limit, exit 2/78 after a crash). */
	giveUp(result = "start-limit-hit"): void {
		this.state = {
			...this.state,
			active: "failed",
			sub: "failed",
			mainPid: 0,
			result,
		};
		this.answering = false;
	}

	private capture(): void {
		this.published.push(readFileSync(`${this.dir}/argv`));
	}

	show(): string {
		const s = this.state;
		return [
			`LoadState=${s.load}`,
			`ActiveState=${s.active}`,
			`SubState=${s.sub}`,
			`MainPID=${s.mainPid}`,
			`InvocationID=${s.invocation}`,
			`ControlGroup=${s.cgroup}`,
			`Result=${s.result}`,
			`ExecMainCode=${s.code}`,
			`ExecMainStatus=${s.status}`,
			`NRestarts=${s.restarts}`,
			`Job=${s.job}`,
		].join("\n");
	}

	io(overrides: Partial<SenderUnitIo> = {}): SenderUnitIo {
		const real = productionSenderUnitIo();
		return {
			unit: "srtla-send.service",
			paths: senderUnitPaths(this.dir),
			ownerUid: process.getuid?.() ?? 0,
			systemctl: async (args) => {
				this.calls.push([...args]);
				this.clock += this.systemctlMs;
				const [verb] = args;
				if (verb === "show") {
					if (this.showFails) throw new Error("Failed to connect to bus");
					return this.show();
				}
				if (verb === "start") {
					if (this.startTimesOut) {
						this.capture();
						this.begin(this.next);
						throw new Error("Connection timed out");
					}
					if (this.next.kind === "refused")
						throw new Error(
							"Job for srtla-send.service failed (start-limit-hit)",
						);
					this.capture();
					this.begin(this.next);
					return "";
				}
				if (verb === "stop") {
					if (this.stopFails)
						throw new Error("Job for srtla-send.service canceled");
					if (
						this.state.active !== "inactive" &&
						this.state.active !== "failed"
					)
						this.state = {
							...this.state,
							active: "inactive",
							sub: "dead",
							mainPid: 0,
							result: "success",
							code: this.stopExitCode,
							status: 0,
						};
					// A stop job replaces a queued start job.
					this.state.job = "";
					this.answering = false;
					return "";
				}
				if (verb === "kill") return "";
				throw new Error(`unexpected systemctl ${args.join(" ")}`);
			},
			lstat: (path) => lstat(path),
			readComm: (pid) =>
				pid === this.state.mainPid && pid > 0
					? this.launcherLeft > 0
						? "srtla-send-laun"
						: "srtla_send"
					: null,
			// The census passes its own process table; follow it when given.
			readCgroup: (pid, procRoot) =>
				procRoot !== undefined
					? real.readCgroup(pid, procRoot)
					: pid === this.state.mainPid && pid > 0
						? this.state.cgroup
						: null,
			writeExclusive: real.writeExclusive,
			rename: (from, to) => rename(from, to),
			remove: (path) => rm(path, { force: true }),
			probeControl: async (_socket, accept, _timeoutMs) =>
				this.answering &&
				this.launcherLeft === 0 &&
				accept({ pid: this.state.mainPid, uid: process.getuid?.() ?? 0 }),
			tryUpdateLock: async () => {
				if (this.lockBusy) return null;
				this.lockHeld++;
				return {
					release: () => {
						this.lockReleased++;
					},
				};
			},
			signal: (pid, signal) => {
				this.signals.push({ pid, signal });
			},
			// The fake pidfd is the PID; it reaches only the process that is
			// still the unit's main process.
			pidfdOpen: (pid) => (pid === this.state.mainPid && pid > 0 ? pid : null),
			pidfdSignal: (fd, signal) => {
				if (fd !== this.state.mainPid) return false;
				this.signals.push({ pid: fd, signal });
				return true;
			},
			pidfdAlive: (fd) => fd === this.state.mainPid && fd > 0,
			pidfdClose: () => undefined,
			now: () => this.clock,
			sleep: async (ms) => {
				// Yield to the event loop like a real sleep, without real time.
				await new Promise((resolve) => setImmediate(resolve));
				this.clock += ms;
				if (this.launcherLeft > 0) this.launcherLeft--;
				this.onSleep?.();
			},
			schedule: (fn) => {
				this.scheduled.push(fn);
				return () => {
					const at = this.scheduled.indexOf(fn);
					if (at >= 0) this.scheduled.splice(at, 1);
				};
			},
			...overrides,
		};
	}
}
