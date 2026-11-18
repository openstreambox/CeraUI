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
 * Reading is `tailscale status --json` (argv only, read-only). Joining feeds the
 * pasted auth key to `tailscale up --auth-key=file:/dev/stdin` on stdin, so the
 * key never appears on argv, in a file, in config, in a log line or in any
 * status frame. The off switch stops and disables tailscaled (the login stays);
 * "forget" is `tailscale logout`. There is deliberately no interactive login:
 * a login link would let whoever opens it first choose the network.
 */

import type { TailscaleState, TailscaleStatus } from "@ceraui/rpc/schemas";

import { execFileP } from "../../helpers/exec.ts";
import { logger } from "../../helpers/logger.ts";
import { run, runWithStdin } from "../../helpers/run.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import { describeCliError } from "./cli-parse.ts";
import { DisruptiveActionRefusal } from "./disruptive-action-reservation.ts";
import { withServiceReservation } from "./disruptive-service-reservation.ts";

const UNIT = "tailscaled.service";
const JOIN_TIMEOUT_S = 45;
const SETTLE_POLL_MS = 2_000;
const SETTLE_POLL_COUNT = 15;

/** The subset of `tailscale status --json` this module reads. */
type TailscaleStatusJson = {
	BackendState?: unknown;
	Self?: { HostName?: unknown; TailscaleIPs?: unknown } | null;
};

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

/** Injectable OS surface; tests replace every member. */
export type TailscaleDeps = {
	/** True when the tailscale CLI and the tailscaled unit both exist. */
	isInstalled: () => Promise<boolean>;
	/** `systemctl is-active tailscaled`, resolved to a boolean. */
	isDaemonActive: () => Promise<boolean>;
	/** `tailscale status --json` stdout; rejects when the daemon does not answer. */
	statusJson: () => Promise<string>;
	/** `systemctl enable|disable --now tailscaled`. */
	setUnit: (enabled: boolean) => Promise<void>;
	/** `tailscale up` with the key on stdin, or a plain reconnect without one. */
	up: (authKey?: string) => Promise<void>;
	/** `tailscale down`. */
	down: () => Promise<void>;
	/** `tailscale logout`. */
	logout: () => Promise<void>;
	/** Emit the status to clients. */
	broadcast: (status: TailscaleStatus) => void;
};

const TAILSCALE = "tailscale";

function isTailscaleOnPath(): boolean {
	return Bun.which(TAILSCALE) !== null;
}

const defaultDeps: TailscaleDeps = {
	isInstalled: async () => {
		if (!isTailscaleOnPath()) return false;
		try {
			const { stdout } = await execFileP("systemctl", [
				"show",
				"--property=LoadState",
				"--value",
				UNIT,
			]);
			return stdout.trim() === "loaded";
		} catch {
			return false;
		}
	},
	isDaemonActive: async () => {
		try {
			const { stdout } = await execFileP("systemctl", ["is-active", UNIT]);
			return stdout.trim() === "active";
		} catch {
			return false;
		}
	},
	statusJson: () => run(TAILSCALE, ["status", "--json", "--peers=false"]),
	setUnit: async (enabled) => {
		await run("systemctl", [enabled ? "enable" : "disable", "--now", UNIT]);
	},
	up: async (authKey) => {
		const args = ["up", `--timeout=${JOIN_TIMEOUT_S}s`];
		const timeout = (JOIN_TIMEOUT_S + 15) * 1000;
		if (authKey === undefined) {
			await run(TAILSCALE, args, { timeout });
			return;
		}
		// The key reaches tailscale on stdin only. `file:` makes the CLI read the
		// key from a path, and /dev/stdin is that path.
		try {
			await runWithStdin(
				TAILSCALE,
				[...args, "--auth-key=file:/dev/stdin"],
				authKey,
				{ timeout },
			);
		} catch (err) {
			// runWithStdin folds stderr into the message. Rebuild the error without
			// the key, keeping the exit code so the reservation sees a plain failure.
			const message = err instanceof Error ? err.message : String(err);
			const code = Number(message.match(/exited with code (\d+)/)?.[1]);
			throw Object.assign(new Error(scrubSecret(message, authKey)), {
				...(Number.isInteger(code) ? { code } : {}),
			});
		}
	},
	down: async () => {
		await run(TAILSCALE, ["down"]);
	},
	logout: async () => {
		await run(TAILSCALE, ["logout"]);
	},
	broadcast: (status) => broadcastMsg("status", { tailscale: status }),
};

let deps: TailscaleDeps = defaultDeps;
let cached: TailscaleStatus | undefined;
let joining = false;

/** Test seam: replace the OS surface. */
export function setTailscaleDepsForTest(next: Partial<TailscaleDeps>): void {
	deps = { ...defaultDeps, ...next };
}

/** Test seam: restore the OS surface and clear cached state. */
export function resetTailscaleForTest(): void {
	deps = defaultDeps;
	cached = undefined;
	joining = false;
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
		cached.address !== status.address
	) {
		cached = status;
		deps.broadcast(status);
	}
	return cached;
}

async function probe(): Promise<TailscaleStatus> {
	if (!(await deps.isInstalled())) return { state: "unavailable" };
	if (!(await deps.isDaemonActive())) return { state: "off" };
	try {
		return parseTailscaleStatusJson(await deps.statusJson());
	} catch (err) {
		// `tailscale status` exits non-zero for some states but still prints JSON.
		const stdout = (err as { stdout?: unknown } | null)?.stdout;
		if (typeof stdout === "string" && stdout.trim().startsWith("{")) {
			return parseTailscaleStatusJson(stdout);
		}
		return { state: "unknown" };
	}
}

/** Re-probe the daemon and broadcast when the status changed. */
export async function getTailscaleStatus(): Promise<TailscaleStatus> {
	if (shouldUseMocks()) return publish(mockStatus());
	const status = await probe();
	// While our own join runs, an intermediate "needs_key" is not news.
	if (joining && (status.state === "needs_key" || status.state === "off")) {
		return publish({ state: "joining" });
	}
	return publish(status);
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
 * Join with a pasted auth key. Starts tailscaled first if the owner had it off.
 * The key is never stored: it goes to stdin and the reference is dropped when
 * this returns. Returns whether the device reports itself on the tailnet (or
 * waiting for approval) afterwards.
 */
export async function joinTailscale(authKey: string): Promise<boolean> {
	if (shouldUseMocks()) return mockJoin(authKey);
	// Claimed before the first await, so a second click cannot start a second join.
	if (joining) return false;
	joining = true;
	if (!(await deps.isInstalled())) {
		joining = false;
		return false;
	}
	publish({ state: "joining" });
	try {
		await reserved(async () => {
			if (!(await deps.isDaemonActive())) await deps.setUnit(true);
			await deps.up(authKey);
		});
	} catch (err) {
		if (err instanceof DisruptiveActionRefusal) throw err;
		logger.error(
			`Tailscale join failed: ${scrubSecret(describeCliError(err), authKey)}`,
		);
	} finally {
		joining = false;
	}
	const status = await getTailscaleStatus();
	if (status.state === "joining") pollUntilSettled();
	return (
		status.state === "connected" ||
		status.state === "needs_approval" ||
		status.state === "joining"
	);
}

/**
 * The owner's off switch. Off: `tailscale down`, then stop and disable the unit
 * so nothing runs or listens. On: enable and start the unit, then reconnect if
 * this device is still logged in. Never asks for a login.
 */
export async function setTailscaleEnabled(enabled: boolean): Promise<boolean> {
	if (shouldUseMocks()) return mockSetEnabled(enabled);
	if (!(await deps.isInstalled())) return false;
	try {
		await reserved(async () => {
			if (enabled) {
				await deps.setUnit(true);
				const now = await probe();
				if (now.state === "off") await deps.up();
			} else {
				if (await deps.isDaemonActive()) {
					try {
						await deps.down();
					} catch (err) {
						// Stopping the unit below still turns it off.
						logger.warn(`tailscale down failed: ${describeCliError(err)}`);
					}
				}
				await deps.setUnit(false);
			}
		});
	} catch (err) {
		if (err instanceof DisruptiveActionRefusal) throw err;
		logger.error(
			`Turning Tailscale ${enabled ? "on" : "off"} failed: ${describeCliError(err)}`,
		);
	}
	const status = await getTailscaleStatus();
	if (status.state === "joining") pollUntilSettled();
	return enabled
		? status.state !== "off" && status.state !== "unknown"
		: status.state === "off";
}

/** Forget this device: log out of the tailnet. The daemon keeps running. */
export async function logoutTailscale(): Promise<boolean> {
	if (shouldUseMocks()) return mockLogout();
	if (!(await deps.isInstalled())) return false;
	if (!(await deps.isDaemonActive())) return false;
	try {
		await reserved(() => deps.logout());
	} catch (err) {
		if (err instanceof DisruptiveActionRefusal) throw err;
		logger.error(`Tailscale logout failed: ${describeCliError(err)}`);
	}
	const status = await getTailscaleStatus();
	return status.state === "needs_key";
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
