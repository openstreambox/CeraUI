/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2026 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/* Remote access over Tailscale.
 *
 * Optional: images that do not ship tailscale/tailscaled report `unavailable`
 * and the UI hides the entry, so nothing changes for them.
 *
 * Reading is `tailscale status --json` (argv only, read-only).
 *
 * On a standard installation, joining sends the key only to tailscaled's
 * local API over its unix socket, the same API the CLI uses: read the current
 * prefs, send them back unchanged with the key (`start`), then ask for a login
 * (`login-interactive`, which uses the key; no URL is ever shown). Keeping the
 * prefs is the point: `tailscale up` with any flag refuses to run when the
 * device has non-default settings it does not repeat (`--ssh`, `--hostname`,
 * `--accept-dns=false`...), and `tailscale login` silently resets them.
 * A `tailscale logout` resets the prefs too, so "forget" first remembers the
 * few the owner chose (control server, name, SSH, DNS, routes, shields) in a
 * local file next to the config, and the next join restores them. A device
 * that never had any gets `accept-dns=false`: a streaming box should not have
 * its DNS taken over unasked.
 *
 * Images may bring their own enrolment (ENROLL_UNIT, e.g. a key file on the
 * boot drive). The card atomically drops /data/tailscale-enroll/incoming-authkey
 * with the key and an optional hostname on separate lines. The enrolment
 * service claims it, writes the retry status and applies the image's flags.
 * This can start tailscaled even on a box that never ran it.
 *
 * The off switch is `tailscale down`, then `systemctl disable --now
 * tailscaled`. On re-enables the unit and reconnects with a flag-less
 * `tailscale up`, which never starts a login. On images with the enrolment
 * unit, reconnect also reapplies the image's auto-update policy; a refused pin
 * is logged and does not fail the switch. While Tailscale SSH is on and the
 * tailnet does not allow it, tailscaled refuses every setting change; the
 * image's enrolment turns SSH off in that case, and logs name the cause.
 * "Forget" is `tailscale logout`. Interactive login would let whoever opens
 * the link first pick the network.
 */

import { randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
	TailscaleNotice,
	TailscaleState,
	TailscaleStatus,
} from "@ceraui/rpc/schemas";

import { execFileP } from "../../helpers/exec.ts";
import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { getConfigFilePath } from "../config.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import { describeCliError } from "./cli-parse.ts";
import { DisruptiveActionRefusal } from "./disruptive-action-reservation.ts";
import { withServiceReservation } from "./disruptive-service-reservation.ts";

const UNIT = "tailscaled.service";
const TAILSCALE = "tailscale";
const DEFAULT_SOCKET = "/var/run/tailscale/tailscaled.sock";
/** How long a join waits for the daemon's answer before reporting "joining". */
const JOIN_WAIT_MS = 50_000;
/** Bound for the flag-less reconnect; it returns as soon as WantRunning is set. */
const RECONNECT_TIMEOUT_MS = 30_000;
const SETTLE_POLL_MS = 2_000;
const SETTLE_POLL_COUNT = 15;
/** How long "on" waits for a just-started daemon to answer. */
const SETTLE_WAIT_MS = 10_000;
/** While waiting for approval or showing a notice, re-probe this often (bounded). */
const FOLLOW_UP_MS = 10_000;
const FOLLOW_UP_COUNT = 30;

/**
 * Image-side enrolment hand-off. The root-only inbox is separate from the
 * state directory owned by tailscaled.
 */
export const ENROLL_UNIT = "ceralive-tailscale-enroll.service";
const STATE_DIR = "/var/lib/tailscale";
const ENROLL_DIR = "/data/tailscale-enroll";
const ENROLL_INCOMING = "incoming-authkey";
const ENROLL_KEY_RE = /^tskey-auth-[A-Za-z0-9_-]{8,200}$/;
const ENROLL_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

/** The socket of the tailscaled this backend talks to (env override for tests). */
export function tailscaleSocket(): string {
	return process.env.CERALIVE_TAILSCALE_SOCKET || DEFAULT_SOCKET;
}

function stateDir(): string {
	return process.env.CERALIVE_TAILSCALE_STATE_DIR || STATE_DIR;
}

function enrollDir(): string {
	return process.env.CERALIVE_TAILSCALE_ENROLL_DIR || ENROLL_DIR;
}

/** The subset of `tailscale status --json` this module reads. */
type TailscaleStatusJson = {
	BackendState?: unknown;
	Self?: {
		HostName?: unknown;
		TailscaleIPs?: unknown;
		ID?: unknown;
	} | null;
};

/**
 * The daemon's stable node ID from `status --json` (`Self.ID`). It survives a
 * node key rotation; a new login gets a new one. Not secret, never broadcast.
 */
function nodeIdOf(stdout: string): string | undefined {
	try {
		const id = (JSON.parse(stdout) as TailscaleStatusJson).Self?.ID;
		return typeof id === "string" && id !== "" ? id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Map the daemon's BackendState onto the UI's states. Anything unrecognised is
 * `unknown`, never `connected`.
 */
export function parseTailscaleStatusJson(stdout: string): TailscaleStatus {
	let parsed: TailscaleStatusJson;
	try {
		parsed = JSON.parse(stdout) as TailscaleStatusJson;
	} catch {
		return { state: "unknown" };
	}
	if (typeof parsed !== "object" || parsed === null)
		return { state: "unknown" };

	const backend = parsed.BackendState;
	let state: TailscaleState;
	switch (backend) {
		case "Running":
			state = "connected";
			break;
		case "Starting":
			state = "joining";
			break;
		case "NeedsLogin":
		case "NoState":
			state = "needs_key";
			break;
		case "NeedsMachineAuth":
			state = "needs_approval";
			break;
		case "Stopped":
			state = "off";
			break;
		default:
			state = "unknown";
	}

	const status: TailscaleStatus = { state };
	if (state === "connected") {
		const self = parsed.Self;
		if (self && typeof self.HostName === "string" && self.HostName !== "") {
			status.hostname = self.HostName;
		}
		const ips = Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs : [];
		const v4 = ips.find(
			(ip): ip is string =>
				typeof ip === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(ip),
		);
		if (v4) status.address = v4;
	}
	return status;
}

/** Prefs that "forget" remembers so the next join restores them. Not secret. */
export type RestorePrefs = {
	ControlURL?: string;
	Hostname?: string;
	RunSSH?: boolean;
	CorpDNS?: boolean;
	RouteAll?: boolean;
	ShieldsUp?: boolean;
};
const RESTORE_KEYS = [
	"ControlURL",
	"Hostname",
	"RunSSH",
	"CorpDNS",
	"RouteAll",
	"ShieldsUp",
] as const;

/** Pick the remembered prefs out of a full prefs object, type-checked. */
export function pickRestorePrefs(prefs: unknown): RestorePrefs {
	const out: Record<string, unknown> = {};
	if (typeof prefs !== "object" || prefs === null) return {};
	for (const key of RESTORE_KEYS) {
		const value = (prefs as Record<string, unknown>)[key];
		const want =
			key === "ControlURL" || key === "Hostname" ? "string" : "boolean";
		if (typeof value === want) out[key] = value;
	}
	return out as RestorePrefs;
}

/** What a join reports back. */
export type JoinOutcome =
	| "joined"
	| "approval"
	| "refused"
	| "refused_tailnet_ssh"
	| "pending";

/** The Join RPC's error code when the enrolment gave up for that reason. */
export const TAILNET_SSH_NOT_ALLOWED = "tailnet_ssh_not_allowed";
/** The enrolment's gave-up reason for a login on a tailnet without Tailscale SSH. */
const ENROLL_NO_TAILNET_SSH_RE = /does not allow Tailscale SSH/i;

/** One IPN bus notification, the fields a join reads. */
type BusNotify = {
	State?: number;
	ErrMessage?: string | null;
	BrowseToURL?: string | null;
};
// ipn.State: NeedsMachineAuth = 3, Running = 6.
const IPN_NEEDS_MACHINE_AUTH = 3;
const IPN_RUNNING = 6;

/** Injectable OS surface; tests replace members. */
export type TailscaleDeps = {
	/** True when the tailscale CLI and the tailscaled unit both exist. */
	isInstalled: () => Promise<boolean>;
	/** `systemctl is-active tailscaled`, resolved to a boolean. */
	isDaemonActive: () => Promise<boolean>;
	/** `tailscale status --json` stdout; rejects when the daemon does not answer. */
	statusJson: () => Promise<string>;
	/** `systemctl enable|disable --now tailscaled`. */
	setUnit: (enabled: boolean) => Promise<void>;
	/** Flag-less `tailscale up` to reconnect without starting a login. */
	reconnect: () => Promise<void>;
	/** Reapply the image enrolment policy after `up`. */
	pinAutoUpdateOff: () => Promise<void>;
	/** `tailscale down`. */
	down: () => Promise<void>;
	/** `tailscale logout`. */
	logout: () => Promise<void>;
	/** Join through the local API with the given prefs patch. */
	apiJoin: (
		authKey: string,
		restore: RestorePrefs | undefined,
	) => Promise<JoinOutcome>;
	/** Current prefs from the local API (for "forget" to remember). */
	readPrefs: () => Promise<unknown>;
	/** The remembered prefs file. */
	readRestore: () => Promise<RestorePrefs | undefined>;
	writeRestore: (prefs: RestorePrefs) => Promise<void>;
	/** Image enrolment hand-off. */
	enrollPresent: () => Promise<boolean>;
	enrollHasState: () => Promise<boolean>;
	/** A drop that the unit has yet to adopt as its pending key. */
	enrollQueued: () => Promise<boolean>;
	enrollPending: () => Promise<boolean>;
	enrollLastStatus: () => Promise<string | undefined>;
	/** The stable node ID whose Tailscale SSH the enrolment turned off, if any. */
	enrollSshOffNode: () => Promise<string | undefined>;
	/** Run `fn` later (follow-up probes; tests capture it). */
	later: (fn: () => void, ms: number) => void;
	enrollSubmit: (authKey: string, hostname: string) => Promise<void>;
	/** Emit the status to clients. */
	broadcast: (status: TailscaleStatus) => void;
	/** Delay used while polling a hand-off (tests shorten it). */
	sleep: (ms: number) => Promise<void>;
};

function socketArg(): string {
	return `--socket=${tailscaleSocket()}`;
}

function isTailscaleOnPath(): boolean {
	return Bun.which(TAILSCALE) !== null;
}

async function unitLoaded(unit: string): Promise<boolean> {
	try {
		const { stdout } = await execFileP("systemctl", [
			"show",
			"--property=LoadState",
			"--value",
			unit,
		]);
		return stdout.trim() === "loaded";
	} catch {
		return false;
	}
}

/** A request to tailscaled's local API over its unix socket. */
async function localApi(
	method: "GET" | "POST",
	path: string,
	body?: unknown,
	signal?: AbortSignal,
): Promise<Response> {
	const response = await fetch(
		`http://local-tailscaled.sock/localapi/v0/${path}`,
		{
			method,
			unix: tailscaleSocket(),
			headers: {
				"Sec-Tailscale": "localapi",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			...(signal ? { signal } : {}),
		},
	);
	return response;
}

async function localApiOk(
	method: "GET" | "POST",
	path: string,
	body?: unknown,
) {
	const response = await localApi(method, path, body);
	if (!response.ok) {
		// The local API answers in plain text; it never repeats the request body.
		const text = (await response.text()).slice(0, 200);
		throw Object.assign(
			new Error(`tailscaled ${path}: ${response.status} ${text}`),
			{
				code: 1,
			},
		);
	}
	return response;
}

/** Read newline-delimited JSON notifications until `stop` returns a value. */
async function readBus<T>(
	response: Response,
	stop: (notify: BusNotify) => T | undefined,
): Promise<T | undefined> {
	const reader = response.body?.getReader();
	if (!reader) return undefined;
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return undefined;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line) continue;
				let notify: BusNotify;
				try {
					notify = JSON.parse(line) as BusNotify;
				} catch {
					continue;
				}
				const result = stop(notify);
				if (result !== undefined) return result;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Join through the local API, keeping the device's prefs. A device that was
 * logged out (fresh, or forgotten) gets the remembered prefs back, or
 * `CorpDNS=false` when there are none.
 */
async function defaultApiJoin(
	authKey: string,
	restore: RestorePrefs | undefined,
): Promise<JoinOutcome> {
	const prefs = (await (await localApiOk("GET", "prefs")).json()) as Record<
		string,
		unknown
	>;
	const patch: Record<string, unknown> =
		prefs.LoggedOut === true ? { CorpDNS: false, ...(restore ?? {}) } : {};
	const update = { ...prefs, ...patch, WantRunning: true, LoggedOut: false };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), JOIN_WAIT_MS);
	try {
		// Subscribe first so no answer is missed.
		const bus = await localApi(
			"GET",
			"watch-ipn-bus?mask=0",
			undefined,
			controller.signal,
		);
		await localApiOk("POST", "start", {
			UpdatePrefs: update,
			AuthKey: authKey,
		});
		await localApiOk("POST", "login-interactive");
		const outcome = await readBus<JoinOutcome>(bus, (notify) => {
			if (notify.ErrMessage) return "refused";
			// An interactive URL means the key did not log in; never show it.
			if (notify.BrowseToURL) return "refused";
			if (notify.State === IPN_RUNNING) return "joined";
			if (notify.State === IPN_NEEDS_MACHINE_AUTH) return "approval";
			return undefined;
		}).catch((err: unknown) => {
			if (controller.signal.aborted) return "pending" as const;
			throw err;
		});
		return outcome ?? "pending";
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

function restorePath(): string {
	return join(dirname(getConfigFilePath()), "tailscale-restore.json");
}

/** Write a file readable only by its owner, atomically. */
async function writePrivate(path: string, content: string): Promise<void> {
	const tmp = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(tmp, content, { flag: "wx", mode: 0o600 });
		await chmod(tmp, 0o600);
		await rename(tmp, path);
	} catch (err) {
		await rm(tmp, { force: true });
		throw err;
	}
}

async function exists(path: string): Promise<boolean> {
	return Bun.file(path).exists();
}

const defaultDeps: TailscaleDeps = {
	isInstalled: async () => isTailscaleOnPath() && (await unitLoaded(UNIT)),
	isDaemonActive: async () => {
		try {
			const { stdout } = await execFileP("systemctl", ["is-active", UNIT]);
			return stdout.trim() === "active";
		} catch {
			return false;
		}
	},
	statusJson: () =>
		run(TAILSCALE, [socketArg(), "status", "--json", "--peers=false"]),
	setUnit: async (enabled) => {
		await run("systemctl", [enabled ? "enable" : "disable", "--now", UNIT]);
	},
	reconnect: async () => {
		// No flags at all: the CLI's "bare up" only sets WantRunning. Any flag,
		// even --timeout, makes it demand every non-default pref again.
		await run(TAILSCALE, [socketArg(), "up"], {
			timeout: RECONNECT_TIMEOUT_MS,
		});
	},
	pinAutoUpdateOff: async () => {
		await run(TAILSCALE, [
			socketArg(),
			"set",
			"--auto-update=false",
			"--update-check=false",
		]);
	},
	down: async () => {
		await run(TAILSCALE, [socketArg(), "down"]);
	},
	logout: async () => {
		await run(TAILSCALE, [socketArg(), "logout"]);
	},
	apiJoin: defaultApiJoin,
	readPrefs: async () => (await localApiOk("GET", "prefs")).json(),
	readRestore: async () => {
		try {
			return pickRestorePrefs(
				JSON.parse(await readFile(restorePath(), "utf8")),
			);
		} catch {
			return undefined;
		}
	},
	writeRestore: async (prefs) => {
		await writePrivate(restorePath(), JSON.stringify(prefs));
	},
	enrollPresent: () => unitLoaded(ENROLL_UNIT),
	enrollHasState: () => exists(join(stateDir(), "tailscaled.state")),
	enrollQueued: async () => {
		const dir = enrollDir();
		// The unit renames incoming-authkey to .claimed before adopting it.
		return (
			(await exists(join(dir, ENROLL_INCOMING))) ||
			(await exists(join(dir, ".claimed")))
		);
	},
	enrollPending: () => exists(join(enrollDir(), "pending-authkey")),
	enrollLastStatus: async () => {
		try {
			return await readFile(join(enrollDir(), "enroll-status"), "utf8");
		} catch {
			return undefined;
		}
	},
	enrollSshOffNode: async () => {
		try {
			return (await readFile(join(enrollDir(), "ssh-off-node"), "utf8")).trim();
		} catch {
			return undefined;
		}
	},
	later: (fn, ms) => {
		setTimeout(fn, ms).unref?.();
	},
	enrollSubmit: async (authKey, hostname) => {
		const dir = enrollDir();
		const inbox = await lstat(dir);
		if (
			!inbox.isDirectory() ||
			inbox.uid !== process.geteuid?.() ||
			(inbox.mode & 0o777) !== 0o700
		) {
			throw new Error("Tailscale enrolment requires a private inbox");
		}
		const content = hostname ? `${authKey}\n${hostname}\n` : `${authKey}\n`;
		await writePrivate(join(dir, ENROLL_INCOMING), content);
		await run("systemctl", ["start", "--no-block", ENROLL_UNIT]);
	},
	broadcast: (status) => broadcastMsg("status", { tailscale: status }),
	sleep: (ms) => Bun.sleep(ms),
};

let deps: TailscaleDeps = defaultDeps;
let cached: TailscaleStatus | undefined;
let joining = false;
let followUpPending = false;
let followUps = 0;
/** What the follow-up budget counts for: the watched state and notice. */
let followUpKey = "";
/** The node the cached notice was computed for. */
let cachedNodeId: string | undefined;

/** Test seam: replace the OS surface. */
export function setTailscaleDepsForTest(next: Partial<TailscaleDeps>): void {
	deps = { ...defaultDeps, ...next };
}

/** Test seam: the real defaults, for tests that drive them against fakes. */
export function getDefaultTailscaleDepsForTest(): TailscaleDeps {
	return defaultDeps;
}

/** Test seam: restore the OS surface and clear cached state. */
export function resetTailscaleForTest(): void {
	deps = defaultDeps;
	cached = undefined;
	joining = false;
	followUpPending = false;
	followUps = 0;
	followUpKey = "";
	cachedNodeId = undefined;
	resetMockTailscaleState();
}

/** Remove a secret from free text before it reaches a log line. */
export function scrubSecret(text: string, secret: string | undefined): string {
	if (!secret) return text;
	return text.split(secret).join("***");
}

function publish(status: TailscaleStatus): TailscaleStatus {
	if (
		!cached ||
		cached.state !== status.state ||
		cached.hostname !== status.hostname ||
		cached.address !== status.address ||
		cached.notice !== status.notice
	) {
		cached = status;
		deps.broadcast(status);
	}
	return cached;
}

async function readDaemon(): Promise<{
	status: TailscaleStatus;
	nodeId?: string;
}> {
	let stdout: string;
	try {
		stdout = await deps.statusJson();
	} catch (err) {
		// `tailscale status` exits non-zero for some states but still prints JSON.
		const out = (err as { stdout?: unknown } | null)?.stdout;
		if (typeof out !== "string" || !out.trim().startsWith("{")) {
			return { status: { state: "unknown" } };
		}
		stdout = out;
	}
	const nodeId = nodeIdOf(stdout);
	return {
		status: parseTailscaleStatusJson(stdout),
		...(nodeId ? { nodeId } : {}),
	};
}

async function readDaemonStatus(): Promise<TailscaleStatus> {
	return (await readDaemon()).status;
}

/**
 * Right after the unit starts, tailscaled answers NoState (or not at all) for
 * a moment. Wait for a settled state before deciding what "on" should do.
 */
async function readSettledBackend(): Promise<string | undefined> {
	const deadline = Date.now() + SETTLE_WAIT_MS;
	for (;;) {
		let backend: unknown;
		try {
			backend = (
				JSON.parse(await deps.statusJson()) as { BackendState?: unknown }
			).BackendState;
		} catch (err) {
			const stdout = (err as { stdout?: unknown } | null)?.stdout;
			try {
				backend =
					typeof stdout === "string"
						? (JSON.parse(stdout) as { BackendState?: unknown }).BackendState
						: undefined;
			} catch {
				backend = undefined;
			}
		}
		if (typeof backend === "string" && backend !== "NoState") return backend;
		if (Date.now() >= deadline) return undefined;
		await deps.sleep(250);
	}
}

/**
 * What the owner should know about a join done by the image's enrolment, from
 * the daemon's live prefs, so a notice goes away once its cause does. The SSH
 * note belongs to the node the enrolment turned SSH off for (its stable node
 * ID), not to the latest attempt, so a later failed key does not erase it.
 * `"unknown"` means the prefs could not be read: keep what was known.
 */
async function readEnrolNotice(
	nodeId: string | undefined,
): Promise<TailscaleNotice | undefined | "unknown"> {
	let prefs: Record<string, unknown>;
	try {
		const value = await deps.readPrefs();
		if (typeof value !== "object" || value === null) return "unknown";
		prefs = value as Record<string, unknown>;
	} catch {
		return "unknown";
	}
	if (prefs.RunSSH === false && nodeId !== undefined) {
		const sshOffNode = await deps.enrollSshOffNode();
		if (sshOffNode === nodeId) return "ssh_off_by_tailnet";
	}
	const update = prefs.AutoUpdate as
		| { Apply?: unknown; Check?: unknown }
		| undefined;
	if (update?.Apply !== false || update?.Check !== false) {
		return "updates_not_pinned";
	}
	return undefined;
}

async function probe(): Promise<TailscaleStatus> {
	if (!(await deps.isInstalled())) return { state: "unavailable" };
	const hook = await deps.enrollPresent();
	const pending =
		hook && ((await deps.enrollQueued()) || (await deps.enrollPending()));
	if (!(await deps.isDaemonActive())) {
		if (pending) return { state: "joining" };
		// An image whose enrolment starts tailscaled: a box that never joined
		// has nothing to switch on, only a key to give.
		if (hook && !(await deps.enrollHasState())) return { state: "needs_key" };
		return { state: "off" };
	}
	const { status, nodeId } = await readDaemon();
	if (hook && status.state === "connected") {
		const notice = await readEnrolNotice(nodeId);
		if (notice === "unknown") {
			// A failed read is not a repair: keep the note we had for this node.
			if (
				cached?.state === "connected" &&
				cached.notice &&
				nodeId !== undefined &&
				nodeId === cachedNodeId
			) {
				status.notice = cached.notice;
			}
		} else if (notice) {
			status.notice = notice;
		}
		cachedNodeId = nodeId;
	}
	if (
		pending &&
		status.state !== "connected" &&
		status.state !== "needs_approval"
	) {
		return { state: "joining" };
	}
	return status;
}

/** Re-probe the daemon and broadcast when the status changed. */
export async function getTailscaleStatus(): Promise<TailscaleStatus> {
	if (shouldUseMocks()) return publish(mockStatus());
	const status = await probe();
	// While our own join runs, an intermediate "needs_key" is not news.
	if (joining && (status.state === "needs_key" || status.state === "off")) {
		return publish({ state: "joining" });
	}
	const published = publish(status);
	followUp(published);
	return published;
}

/**
 * An open card should follow an approval or a repair made elsewhere (a local
 * admin turning SSH back on, the pin landing) without a click: while the
 * device waits for approval or shows a notice, probe again, bounded.
 */
function followUp(status: TailscaleStatus): void {
	// A daemon that briefly fails to answer keeps an ongoing watch alive.
	const transient = status.state === "unknown" && followUpKey !== "";
	const watch =
		status.state === "needs_approval" ||
		status.notice !== undefined ||
		transient;
	if (!watch) {
		followUpKey = "";
		followUps = 0;
		return;
	}
	// The budget is per watched state and notice: a changing name or address,
	// or a passing failure, does not renew it.
	if (!transient) {
		const key = `${status.state}|${status.notice ?? ""}`;
		if (key !== followUpKey) {
			followUpKey = key;
			followUps = 0;
		}
	}
	if (followUpPending || followUps >= FOLLOW_UP_COUNT) return;
	followUpPending = true;
	deps.later(() => {
		followUpPending = false;
		followUps += 1;
		void getTailscaleStatus();
	}, FOLLOW_UP_MS);
}

/** The last known status, for status snapshots built synchronously. */
export function getCachedTailscaleStatus(): TailscaleStatus | undefined {
	return cached;
}

/** Poll for a while after an action so `joining` settles without a reload. */
function pollUntilSettled(): void {
	let left = SETTLE_POLL_COUNT;
	const tick = () => {
		left -= 1;
		void getTailscaleStatus().then((status) => {
			if (left > 0 && status.state === "joining") {
				setTimeout(tick, SETTLE_POLL_MS);
			}
		});
	};
	setTimeout(tick, SETTLE_POLL_MS);
}

async function reserved<T>(effect: () => Promise<T>): Promise<T> {
	const { getDisruptiveActionDecision } = await import(
		"./disruptive-action-runtime.ts"
	);
	return withServiceReservation(effect, {
		unit: UNIT,
		decision: getDisruptiveActionDecision,
	});
}

/**
 * The enrolment's status line: `<pending|joined|gave-up> <attempts>
 * <next-epoch> <reason>`. The reason is free text and may contain spaces.
 */
function parseEnrollStatus(line: string): {
	state: string;
	attempts: number;
	reason: string;
} {
	const [state = "", attempts = "", , ...reason] = line.trim().split(/\s+/);
	const count = Number(attempts);
	return {
		state,
		attempts: Number.isInteger(count) ? count : 0,
		reason: reason.join(" "),
	};
}

/** Hand the key to the image's enrolment and wait for its answer. */
async function enrollJoin(authKey: string): Promise<JoinOutcome> {
	if (!ENROLL_KEY_RE.test(authKey)) return "refused";
	const remembered = (await deps.readRestore())?.Hostname?.toLowerCase() ?? "";
	await deps.enrollSubmit(
		authKey,
		ENROLL_NAME_RE.test(remembered) ? remembered : "",
	);
	const deadline = Date.now() + JOIN_WAIT_MS;
	while (Date.now() < deadline) {
		await deps.sleep(1_000);
		// Status still belongs to the previous key until the unit adopts ours.
		if (await deps.enrollQueued()) continue;
		const pending = await deps.enrollPending();
		const last = parseEnrollStatus((await deps.enrollLastStatus()) ?? "");
		// The enrolment's own line is the answer: it is written after the
		// image's post-join step (which may turn SSH off or fail to pin), so a
		// daemon that already reports connected is not the end of the join.
		if (!pending) {
			if (last.state === "joined") return "joined";
			if (last.state === "gave-up") {
				return ENROLL_NO_TAILNET_SSH_RE.test(last.reason)
					? "refused_tailnet_ssh"
					: "refused";
			}
		}
		if (
			(await deps.isDaemonActive()) &&
			(await readDaemonStatus()).state === "needs_approval"
		) {
			return "approval";
		}
		if (
			pending &&
			last.state === "pending" &&
			last.attempts > 0 &&
			last.reason === "retry"
		) {
			// The first attempt failed without a final answer (no network yet,
			// or a refusal the enrolment does not recognise). It keeps the key
			// and retries on its own schedule; report that now, not in 50 s.
			return "pending";
		}
	}
	// Out of time: a connected daemon still counts as joined.
	if (
		(await deps.isDaemonActive()) &&
		(await readDaemonStatus()).state === "connected"
	) {
		return "joined";
	}
	return "pending";
}

/**
 * Join with a pasted auth key. The key goes to tailscaled's local API in a
 * request body (or, on images with their own enrolment, to its private
 * inbox, which that unit consumes). It is never logged, saved in config or
 * echoed. Returns whether the device joined, waits for approval, or
 * is still joining.
 */
export async function joinTailscale(authKey: string): Promise<boolean> {
	return (await joinTailscaleResult(authKey)).success;
}

/**
 * The same join, with the reason when it failed for a cause the owner can act
 * on: `tailnet_ssh_not_allowed` (the device is still logged in to a tailnet
 * that does not allow Tailscale SSH; forget it there first).
 */
export async function joinTailscaleResult(
	authKey: string,
): Promise<{ success: boolean; error?: string }> {
	if (shouldUseMocks()) return { success: mockJoin(authKey) };
	// Claimed before the first await, so a second click cannot start a second join.
	if (joining) return { success: false };
	joining = true;
	if (!(await deps.isInstalled())) {
		joining = false;
		return { success: false };
	}
	publish({ state: "joining" });
	let outcome: JoinOutcome = "refused";
	try {
		outcome = await reserved(async () => {
			if (await deps.enrollPresent()) return enrollJoin(authKey);
			if (!(await deps.isDaemonActive())) await deps.setUnit(true);
			return deps.apiJoin(authKey, await deps.readRestore());
		});
	} catch (err) {
		if (err instanceof DisruptiveActionRefusal) {
			joining = false;
			await getTailscaleStatus();
			throw err;
		}
		logger.error(
			`Tailscale join failed: ${scrubSecret(describeCliError(err), authKey)}`,
		);
	} finally {
		joining = false;
	}
	if (outcome === "refused") logger.warn("Tailscale refused the auth key");
	if (outcome === "refused_tailnet_ssh") {
		logger.warn(
			"Tailscale join refused: this device is still logged in to a tailnet that does not allow Tailscale SSH",
		);
	}
	const status = await getTailscaleStatus();
	if (status.state === "joining") pollUntilSettled();
	if (outcome === "refused_tailnet_ssh") {
		return { success: false, error: TAILNET_SSH_NOT_ALLOWED };
	}
	return { success: outcome !== "refused" };
}

/**
 * tailscaled's answer to any pref change (`set`, `down`, `logout`) while
 * Tailscale SSH is on and the tailnet's policy does not grant this device SSH.
 */
const NO_TAILNET_SSH_RE = /not enabled on tailnet/i;

/** A CLI failure for the log, naming that cause when it is the one. */
function explainCliError(err: unknown): string {
	const text = describeCliError(err);
	return NO_TAILNET_SSH_RE.test(text)
		? `${text} (this tailnet does not allow Tailscale SSH, and tailscaled refuses setting changes while SSH is on)`
		: text;
}

async function reconnectTailscale(): Promise<void> {
	const imageEnrolment = await deps.enrollPresent();
	let failure: { err: unknown } | undefined;
	try {
		await deps.reconnect();
	} catch (err) {
		failure = { err };
	}
	// An `up` can change prefs before the CLI finishes, even if it times out.
	// The pin is the image's policy, not the switch's result: a refusal is
	// logged, and tailscaled re-applies the pin at its next start.
	if (imageEnrolment) {
		try {
			await deps.pinAutoUpdateOff();
		} catch (err) {
			logger.warn(
				`Could not pin Tailscale auto-update off: ${explainCliError(err)}`,
			);
		}
	}
	if (failure) throw failure.err;
}

/**
 * The owner's off switch. Off: `tailscale down`, then stop and disable the unit
 * so nothing runs or listens. On: enable and start the unit, then reconnect
 * with a flag-less `up` if this device is still logged in. Never asks for a
 * login.
 */
export async function setTailscaleEnabled(enabled: boolean): Promise<boolean> {
	if (shouldUseMocks()) return mockSetEnabled(enabled);
	if (!(await deps.isInstalled())) return false;
	try {
		await reserved(async () => {
			if (enabled) {
				await deps.setUnit(true);
				if (!(await deps.isDaemonActive())) return;
				// Stopped = logged in with WantRunning off: reconnect. Anything else
				// (no login, already running) needs nothing from "on".
				if ((await readSettledBackend()) === "Stopped")
					await reconnectTailscale();
			} else {
				if (await deps.isDaemonActive()) {
					try {
						await deps.down();
					} catch (err) {
						// Stopping the unit below still turns it off.
						logger.warn(`tailscale down failed: ${explainCliError(err)}`);
					}
				}
				await deps.setUnit(false);
			}
		});
	} catch (err) {
		if (err instanceof DisruptiveActionRefusal) {
			await getTailscaleStatus();
			throw err;
		}
		logger.error(
			`Turning Tailscale ${enabled ? "on" : "off"} failed: ${explainCliError(err)}`,
		);
	}
	const status = await getTailscaleStatus();
	if (status.state === "joining") pollUntilSettled();
	return enabled
		? status.state !== "off" && status.state !== "unknown"
		: status.state === "off";
}

/**
 * Forget this device: log out of the tailnet. The daemon keeps running. The
 * owner's few chosen prefs are remembered first, because logout resets them.
 */
export async function logoutTailscale(): Promise<boolean> {
	if (shouldUseMocks()) return mockLogout();
	if (!(await deps.isInstalled())) return false;
	if (!(await deps.isDaemonActive())) return false;
	try {
		await reserved(async () => {
			try {
				const keep = pickRestorePrefs(await deps.readPrefs());
				if (Object.keys(keep).length > 0) await deps.writeRestore(keep);
			} catch (err) {
				logger.warn(
					`Could not remember Tailscale settings: ${describeCliError(err)}`,
				);
			}
			await deps.logout();
		});
	} catch (err) {
		if (err instanceof DisruptiveActionRefusal) {
			await getTailscaleStatus();
			throw err;
		}
		logger.error(`Tailscale logout failed: ${explainCliError(err)}`);
	}
	const status = await getTailscaleStatus();
	return status.state === "needs_key";
}

/** Test seam: drop the remembered prefs file. */
export async function removeRestoreFileForTest(): Promise<void> {
	await rm(restorePath(), { force: true });
}

// ── Dev mock ────────────────────────────────────────────────────────────────
// A small state machine so the card can be used and screenshotted on a dev box
// without tailscaled. Keys containing "expired" are refused, like a used key.

type MockState = { daemon: boolean; loggedIn: boolean };
let mock: MockState = { daemon: false, loggedIn: false };

function resetMockTailscaleState(): void {
	mock = { daemon: false, loggedIn: false };
}

function mockStatus(): TailscaleStatus {
	if (!mock.daemon) return { state: "off" };
	if (!mock.loggedIn) return { state: "needs_key" };
	return { state: "connected", hostname: "ceralive", address: "100.64.0.7" };
}

function mockJoin(authKey: string): boolean {
	if (authKey.includes("expired")) {
		mock.daemon = true;
		publish(mockStatus());
		return false;
	}
	mock = { daemon: true, loggedIn: true };
	publish(mockStatus());
	return true;
}

function mockSetEnabled(enabled: boolean): boolean {
	mock.daemon = enabled;
	publish(mockStatus());
	return true;
}

function mockLogout(): boolean {
	if (!mock.daemon) return false;
	mock.loggedIn = false;
	publish(mockStatus());
	return true;
}
