import fs from "node:fs";
import { dirname, join } from "node:path";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";

import { PowerSubmissionError } from "./disruptive-action-reservation.ts";

/**
 * The image's power admission broker (`ceralive-power`), when it is installed.
 *
 * A local power action this backend has admitted goes to the broker: it
 * identifies this service by its unit, lets the action pass this process's own
 * shutdown lock, waits for running writes and then asks logind directly. The
 * broker counts as installed when its files are on the image, whatever its
 * socket is doing: a broker image whose broker is down fails closed through
 * the client, never falls back. Images without it ask logind directly too
 * (lock-checked, no systemctl and so no fallback to starting a target).
 */
export const POWER_BROKER_SOCKET = "/run/ceralive-power/request.sock";
const POWER_BROKER = "/usr/libexec/ceralive/ceralive-power-broker";
const POWER_CLIENTS = {
	poweroff: "/usr/bin/ceralive-poweroff",
	reboot: "/usr/bin/ceralive-reboot",
} as const;

export function powerAdmissionArgv(
	command: "poweroff" | "reboot",
	exists: (path: string) => boolean = (path) => fs.existsSync(path),
): string[] | undefined {
	return exists(POWER_BROKER) || exists(POWER_CLIENTS.poweroff)
		? [POWER_CLIENTS[command], "--no-wait"]
		: undefined;
}

/** Images without the broker: logind's checked request, no manager fallback. */
export function logindPowerArgv(command: "poweroff" | "reboot"): string[] {
	return [
		"busctl",
		"--system",
		"--timeout=25",
		"call",
		"org.freedesktop.login1",
		"/org/freedesktop/login1",
		"org.freedesktop.login1.Manager",
		command === "reboot" ? "RebootWithFlags" : "PowerOffWithFlags",
		"t",
		"0",
	];
}

export type PowerRunnerOutcome = { readonly brokerRequestId?: string };

const UNCERTAIN =
	"The power request could not be confirmed. Please check the box before trying again.";

/** The client's answer: admitted (with the broker's request id), refused or
 * unavailable (definite: nothing was submitted), or no answer (uncertain). */
export function brokerOutcome(
	command: "poweroff" | "reboot",
	exitCode: number | null,
	stdout: string,
	stderr: string,
): PowerRunnerOutcome {
	const line = stdout.trim().split("\n")[0] ?? "";
	if (exitCode === 0) {
		const [, , id] = line.split(" ");
		return id ? { brokerRequestId: id } : {};
	}
	if (exitCode === 1 || exitCode === 75)
		throw new PowerSubmissionError(
			command,
			exitCode,
			"The box was not shut down.",
			`${stderr}${stdout}`,
		);
	throw new PowerSubmissionError(
		command,
		null,
		UNCERTAIN,
		`${stderr}${stdout}`,
	);
}

/** logind's answer on images without the broker. A lost or timed-out call may
 * have been accepted, so it is uncertain, never a definite refusal. */
export function logindOutcome(
	command: "poweroff" | "reboot",
	exitCode: number | null,
	stderr: string,
	message: string,
): PowerRunnerOutcome {
	if (exitCode === 0) return {};
	if (
		exitCode === null ||
		exitCode >= 128 ||
		/timed out|Connection reset|Broken pipe|NoReply|Disconnected/i.test(stderr)
	)
		throw new PowerSubmissionError(command, null, UNCERTAIN, stderr);
	throw new PowerSubmissionError(command, exitCode, message, stderr);
}

let outstanding:
	| { readonly id: string; readonly release: () => void }
	| undefined;

/** A broker request this backend admitted and is still answerable for: its
 * reservation is released only if the broker reports this request failed. */
export function trackBrokerRequest(id: string, release: () => void): void {
	outstanding = { id, release };
}

type BrokerState = {
	readonly state?: unknown;
	readonly time?: unknown;
	readonly id?: unknown;
};

type Read = (path: string) => string;
const readText: Read = (path) => fs.readFileSync(path, "utf8");

function readBrokerRecord(
	path: string,
	read: Read = readText,
): BrokerState | undefined {
	try {
		return JSON.parse(read(path)) as BrokerState;
	} catch {
		return undefined;
	}
}

const BROKER_REQUEST_ID = /^[0-9a-f]{12}$/;

/** The broker's record of one request: requests/<id>.json, so a newer request
 * can't hide this one's result. A broker that keeps no per-request records only
 * has its latest state. */
function brokerRequestRecord(
	id: string,
	read: Read = readText,
): BrokerState | undefined {
	if (!BROKER_REQUEST_ID.test(id)) return undefined;
	const statePath = powerAdmissionStatePath();
	return (
		readBrokerRecord(
			join(dirname(statePath), "requests", `${id}.json`),
			read,
		) ?? readBrokerRecord(statePath, read)
	);
}

export function powerAdmissionStatePath(): string {
	return process.env.CERALIVE_POWER_STATE ?? "/run/ceralive-power/state.json";
}

/** What the broker reports, or undefined when there's nothing to show. */
export function readPowerAdmissionState(
	read: (path: string) => string = (path) => fs.readFileSync(path, "utf8"),
	nowSeconds: number = Date.now() / 1000,
): "waiting" | "stuck" | "submitted" | "uncertain" | "failed" | undefined {
	const parsed = readBrokerRecord(powerAdmissionStatePath(), read);
	if (!parsed) return undefined;
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

/** A definite failure of the request this backend is answerable for releases
 * its reservation; anything else (waiting, uncertain, another id) keeps it. */
export function reconcileBrokerRequest(
	lookup: (id: string) => BrokerState | undefined = brokerRequestRecord,
): void {
	if (!outstanding) return;
	const record = lookup(outstanding.id);
	if (record?.state === "failed" && record.id === outstanding.id) {
		const { release } = outstanding;
		outstanding = undefined;
		release();
	}
}

/** Called on every heartbeat: show what the broker is doing, once per change. */
export function publishPowerAdmissionStatus(
	read: () => ReturnType<typeof readPowerAdmissionState> = () =>
		readPowerAdmissionState(),
): void {
	reconcileBrokerRequest();
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
	outstanding = undefined;
}
