import fs from "node:fs";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";

/**
 * The image's power admission broker (`ceralive-power`), when it is installed.
 *
 * A local power action this backend has admitted goes to the broker instead
 * of `systemctl`: the broker identifies this service by its unit, lets the
 * action pass this process's own shutdown lock, waits for a running update to
 * finish and then asks logind directly. `--no-wait` returns as soon as the
 * broker admitted the request. Images without the broker keep the plain
 * `systemctl` path, which honours every lock.
 */
export const POWER_BROKER_SOCKET = "/run/ceralive-power/request.sock";
const POWER_CLIENTS = {
	poweroff: "/usr/bin/ceralive-poweroff",
	reboot: "/usr/bin/ceralive-reboot",
} as const;

export function powerAdmissionArgv(
	command: "poweroff" | "reboot",
	exists: (path: string) => boolean = (path) => fs.existsSync(path),
): string[] | undefined {
	const client = POWER_CLIENTS[command];
	return exists(POWER_BROKER_SOCKET) && exists(client)
		? [client, "--no-wait"]
		: undefined;
}

export function powerAdmissionStatePath(): string {
	return process.env.CERALIVE_POWER_STATE ?? "/run/ceralive-power/state.json";
}

type BrokerState = {
	readonly state?: unknown;
	readonly time?: unknown;
};

/** What the broker reports, or undefined when there's nothing to show. */
export function readPowerAdmissionState(
	read: (path: string) => string = (path) => fs.readFileSync(path, "utf8"),
	nowSeconds: number = Date.now() / 1000,
): "waiting" | "stuck" | "submitted" | "uncertain" | "failed" | undefined {
	let parsed: BrokerState;
	try {
		parsed = JSON.parse(read(powerAdmissionStatePath())) as BrokerState;
	} catch {
		return undefined;
	}
	const state = parsed.state;
	if (state === "admitted" || state === "submitting") return "waiting";
	if (state === "waiting" || state === "stuck" || state === "submitted")
		return state;
	if (state === "uncertain") return "uncertain";
	// A refusal is news only for a while; the broker keeps its last state.
	if (
		state === "failed" &&
		typeof parsed.time === "number" &&
		nowSeconds - parsed.time < 600
	)
		return "failed";
	return undefined;
}

const NOTICES = {
	waiting: {
		type: "warning",
		key: "notifications.powerWaitingForUpdate",
		msg: "Shutting down once the running update has finished.",
	},
	stuck: {
		type: "error",
		key: "notifications.powerStuckOnUpdate",
		msg: "Still waiting for the running update after 15 minutes. The box shuts down when it finishes.",
	},
	submitted: {
		type: "info",
		key: "notifications.powerShuttingDown",
		msg: "Shutting down.",
	},
	uncertain: {
		type: "error",
		key: "notifications.powerUncertain",
		msg: "The shutdown request got no answer. Check the box before trying again.",
	},
	failed: {
		type: "error",
		key: "notifications.powerRefused",
		msg: "The shutdown request was refused.",
	},
} as const;

let shown: keyof typeof NOTICES | undefined;

/** Called on every heartbeat: show what the broker is doing, once per change. */
export function publishPowerAdmissionStatus(
	read: () => ReturnType<typeof readPowerAdmissionState> = () =>
		readPowerAdmissionState(),
): void {
	const state = read();
	if (state === shown) return;
	shown = state;
	if (state === undefined) {
		notificationRemove("power-admission");
		return;
	}
	const notice = NOTICES[state];
	notificationBroadcast(
		"power-admission",
		notice.type,
		notice.msg,
		0,
		true,
		state !== "waiting" && state !== "stuck",
		true,
		notice.key,
	);
}

export function resetPowerAdmissionStatusForTest(): void {
	shown = undefined;
}
