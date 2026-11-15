import { createHmac } from "node:crypto";

import { strictParseFrame } from "@ceralive/control-protocol/parse";
import type { STATUS_TYPES } from "@ceralive/control-protocol/schemas";

import { logger } from "../../helpers/logger.ts";

const identityKey = crypto.getRandomValues(new Uint8Array(32));

/** Per-process session marker. Names, revisions, `seq` and the sent-set are all
 * process-scoped, so a consumer must reset its state when this changes (a
 * backend restart) instead of merging the new list into the old one. */
export const NOTIFICATION_EPOCH: string = crypto.randomUUID();

/** Wire `type` of the cloud status frame. The pinned control protocol closes
 * status types to a set that spells it in the plural; the local broadcast name
 * (`buildMsg("notification", …)`) is a separate, local-only event name. */
export const NOTIFICATIONS_STATUS_TYPE =
	"notifications" satisfies (typeof STATUS_TYPES)[number];

export const NOTIFICATION_SUMMARIES: Readonly<Record<string, string>> = {
	hdmi_error:
		"The HDMI input has a signal problem. Check the source and cable.",
	camlink_usb2:
		"The capture adapter is connected through USB 2. Use a USB 3 connection.",
	jetson_undervoltage: "The device power supply voltage is too low.",
	bootconfig:
		"The boot configuration needs attention. Check the local interface before restarting.",
	config_damaged_reset:
		"The settings file was damaged. Settings must be entered again locally.",
	stream_recovery_failed:
		"The stream could not be restored after the streaming engine restarted.",
	ceralive_update: "A software update is available.",
	ceralive_update_failed:
		"The software update failed. Check the local interface for details.",
	srtla_bind_map:
		"Some streaming links could not be bound. Check the local interface.",
	srtla: "The stream sender reported a problem. Check the local interface.",
	asrc_not_found: "The selected audio source is unavailable.",
	no_internet: "No usable internet connection was detected.",
	netif_dup_ip: "Network interfaces have conflicting addresses.",
	ssh_pass_provision: "The initial SSH password could not be provisioned.",
	ssh_pass_sync: "The SSH password could not be synchronized.",
	"encoder-mode-clamped":
		"The saved video mode was adjusted to the available encoder modes.",
	"bluetooth-source-dropped":
		"The Bluetooth audio connection dropped. Reconnecting.",
	"bluetooth-source-lost": "The Bluetooth audio source is unavailable.",
	"active-source-lost":
		"The active video source was lost. Reconnect it or select another source.",
	"active-audio-lost":
		"The active audio source was lost. Streaming continues in silence.",
	"all-links-down":
		"All bonded links are down. Streaming needs a working link.",
	"engine-crashed": "The streaming engine stopped unexpectedly. Recovering.",
	"capture-standby":
		"All cameras were lost. Streaming is on standby until a camera returns.",
	"capture-standby-long":
		"Streaming has been on camera standby for over ten minutes.",
	"capture-composition-suspended":
		"The main camera is unavailable. The backup camera is shown full screen.",
	"capture-passthrough-suspended":
		"The camera is unavailable. Streaming continues on standby.",
	"capture-rate-adapted": "Streaming quality is limited by the backup camera.",
};

export const NOTIFICATION_FALLBACKS = {
	roaming: "A cellular connection is roaming.",
	cameraLost: "A camera was lost. Streaming continues on another camera.",
	generic: "Device notification. Open the local interface for details.",
} as const;

export const overflowMessage = (omitted: number): string =>
	`${omitted} more device notifications are not shown here. Open the local interface for details.`;

/** Only structure crosses this boundary. Producer text, names, interpolation
 * params and actions can contain credentials, addresses or device identifiers.
 * Unknown/future producers receive the same conservative projection. */
export function projectNotification(value: unknown) {
	if (!value || typeof value !== "object") return;
	const n = value as Record<string, unknown>;
	if (
		n.is_persistent !== true ||
		typeof n.name !== "string" ||
		!Number.isSafeInteger(n.revision) ||
		Number(n.revision) < 0 ||
		!["info", "warning", "error", "success"].includes(String(n.type))
	)
		return;
	return {
		name: createHmac("sha256", identityKey).update(n.name).digest("hex"),
		type: n.type as "info" | "warning" | "error" | "success",
		msg:
			(Object.hasOwn(NOTIFICATION_SUMMARIES, n.name)
				? NOTIFICATION_SUMMARIES[n.name]
				: undefined) ??
			(n.name.startsWith("modem_roaming:")
				? NOTIFICATION_FALLBACKS.roaming
				: n.name.startsWith("capture-input-lost:")
					? NOTIFICATION_FALLBACKS.cameraLost
					: NOTIFICATION_FALLBACKS.generic),
		revision: Number(n.revision),
		is_persistent: true,
		is_dismissable: false,
		duration: 0,
	};
}

type RemoteNotice = NonNullable<ReturnType<typeof projectNotification>>;
export type NotificationSnapshot = { show: unknown[]; revision: number };
export type NotificationPayload = {
	show: RemoteNotice[];
	remove: { id: string; revision: number }[];
};
/** What crosses the wire: `show` is always the complete current list, so every
 * frame is a full replace (`full: true`); `remove` additionally names entries
 * this process sent earlier and has since cleared. */
export type NotificationWirePayload = NotificationPayload & {
	epoch: string;
	full: true;
};

/** Only the projected content decides whether a notice changed. A producer
 * re-raising identical text bumps its revision locally (several times a
 * second for some producers); that alone must not re-send the list. */
function sameContent(a: RemoteNotice | undefined, b: RemoteNotice): boolean {
	return a !== undefined && a.type === b.type && a.msg === b.msg;
}

/** Lower is more severe. Truncation keeps the most severe notices. */
const SEVERITY_RANK: Readonly<Record<RemoteNotice["type"], number>> = {
	error: 0,
	warning: 1,
	info: 2,
	success: 3,
};

/** Fixed id of the summary that stands in for notices that did not fit. It is
 * not 64 hex characters, so it cannot collide with a projected (HMAC) name. */
export const OVERFLOW_NOTICE_NAME = "remote-overflow";

const MAX_BYTES = 65536;
/** Room left for the envelope around the payload (type, cid, seq, epoch …). */
const ENVELOPE_RESERVE_BYTES = 1024;
/** At most one frame per this interval, unless a frame carries a new problem. */
const MIN_FRAME_INTERVAL_MS = 1000;
/** A notice the remote side saw within this window is not "new" again: its
 * return is flapping and waits for the interval. */
const RECENT_MS = 10_000;

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function overflowNotice(
	omitted: number,
	type: RemoteNotice["type"],
	revision: number,
): RemoteNotice {
	return {
		name: OVERFLOW_NOTICE_NAME,
		type,
		msg: overflowMessage(omitted),
		revision,
		is_persistent: true,
		is_dismissable: false,
		duration: 0,
	};
}

/** Fit the list into one frame. When everything fits, the list is unchanged.
 * Otherwise the most severe notices are kept (in their original order) until
 * the budget is used, and one summary notice names how many are left out.
 * `remove` entries fill what room remains; every frame is a full replace, so a
 * removal that does not fit is still retracted by the list itself. */
function fitPayload(
	current: RemoteNotice[],
	removed: { id: string; revision: number }[],
	revision: number,
	budget: number,
): { payload: NotificationPayload; omitted: number } {
	const cost = (value: unknown) => jsonBytes(value) + 1;
	let used = jsonBytes({ show: [], remove: [] });
	let show = current;
	let omitted = 0;
	const total = current.reduce((sum, n) => sum + cost(n), used);
	if (total > budget) {
		const ordered = current
			.map((n, index) => ({ n, index }))
			.sort(
				(a, b) =>
					SEVERITY_RANK[a.n.type] - SEVERITY_RANK[b.n.type] ||
					a.index - b.index,
			);
		// Reserve the summary at its largest possible size before filling.
		used += cost(overflowNotice(current.length, "error", revision));
		const kept = new Set<number>();
		for (const { n, index } of ordered) {
			const c = cost(n);
			if (used + c > budget) break;
			kept.add(index);
			used += c;
		}
		const left = ordered.filter(({ index }) => !kept.has(index));
		omitted = left.length;
		const worst = left.reduce<RemoteNotice["type"]>(
			(w, { n }) => (SEVERITY_RANK[n.type] < SEVERITY_RANK[w] ? n.type : w),
			"success",
		);
		show = [
			...current.filter((_, index) => kept.has(index)),
			overflowNotice(omitted, worst, revision),
		];
	}
	const remove: { id: string; revision: number }[] = [];
	const shownNames = new Set(show.map((n) => n.name));
	for (const entry of removed) {
		if (shownNames.has(entry.id)) continue;
		const c = cost(entry);
		if (used + c > budget) break;
		remove.push(entry);
		used += c;
	}
	return { payload: { show, remove }, omitted };
}

export interface NotificationRelayOptions {
	/** Monotonic milliseconds; injectable for tests. */
	now?: () => number;
	/** Largest serialized payload (`show` + `remove`) the relay will build. */
	maxPayloadBytes?: number;
	/** One-time diagnostics (truncation). Defaults to the backend logger. */
	log?: (message: string) => void;
}

/** No event queue: each tick reconciles the latest authoritative state. Failed
 * sends retain only the last accepted state; offline updates are coalesced.
 * At most one frame per second goes out, except that a notice the remote side
 * has not seen recently (or a severity rise) is sent on the tick it appears.
 * The transport must refuse sends above its bounded socket high-water mark. */
export class NotificationRelay {
	private forcePending = false;
	private sent = new Map<string, RemoteNotice>();
	/** Per id: when the remote side last had it, and its worst severity then. */
	private recent = new Map<string, { at: number; rank: number }>();
	private lastSentAt = Number.NEGATIVE_INFINITY;
	private loggedTruncation = false;
	private readonly now: () => number;
	private readonly budget: number;
	private readonly log: (message: string) => void;
	constructor(
		private readonly snapshot: () => NotificationSnapshot,
		private readonly send: (payload: NotificationPayload) => boolean,
		options: NotificationRelayOptions = {},
	) {
		this.now = options.now ?? (() => performance.now());
		this.budget = options.maxPayloadBytes ?? MAX_BYTES - ENVELOPE_RESERVE_BYTES;
		this.log = options.log ?? ((m) => logger.warn(m));
	}

	/** Whether this list carries something the remote side should see now. */
	private isUrgent(show: RemoteNotice[], now: number): boolean {
		return show.some((n) => {
			const seen = this.recent.get(n.name);
			return (
				seen === undefined ||
				now - seen.at > RECENT_MS ||
				SEVERITY_RANK[n.type] < seen.rank
			);
		});
	}

	private remember(shown: Map<string, RemoteNotice>, now: number): void {
		for (const [id, seen] of this.recent) {
			if (now - seen.at > RECENT_MS) this.recent.delete(id);
		}
		// Notices removed by this frame were visible until now.
		for (const id of this.sent.keys()) {
			const seen = this.recent.get(id);
			if (seen) seen.at = now;
		}
		for (const [id, n] of shown) {
			const seen = this.recent.get(id);
			const rank = SEVERITY_RANK[n.type];
			this.recent.set(id, {
				at: now,
				rank: seen ? Math.min(seen.rank, rank) : rank,
			});
		}
	}

	flush(force = false): void {
		this.forcePending ||= force;
		try {
			const snapshot = this.snapshot();
			const current = new Map<string, RemoteNotice>();
			for (const value of snapshot.show) {
				const n = projectNotification(value);
				if (n) current.set(n.name, n);
			}
			const removed = [...this.sent.keys()]
				.filter((id) => !current.has(id))
				.map((id) => ({ id, revision: snapshot.revision }));
			const { payload, omitted } = fitPayload(
				[...current.values()],
				removed,
				snapshot.revision,
				this.budget,
			);
			const shown = new Map(payload.show.map((n) => [n.name, n]));
			const changed =
				[...this.sent.keys()].some((id) => !shown.has(id)) ||
				shown.size !== this.sent.size ||
				[...shown].some(([id, n]) => !sameContent(this.sent.get(id), n));
			if (!this.forcePending && !changed) return;
			const now = this.now();
			if (
				!this.forcePending &&
				now - this.lastSentAt < MIN_FRAME_INTERVAL_MS &&
				!this.isUrgent(payload.show, now)
			)
				return; // held: a later tick sends the then-latest state
			if (omitted > 0 && !this.loggedTruncation) {
				this.loggedTruncation = true;
				this.log(
					`remote notifications: ${omitted} of ${current.size} notices do not fit in one frame; sending the most severe with a summary (logged once)`,
				);
			}
			if (this.send(payload)) {
				this.remember(shown, now);
				this.sent = shown;
				this.lastSentAt = now;
				this.forcePending = false;
			}
		} catch {
			// An advisory transport must never interrupt local delivery or streaming.
		}
	}
}

export interface NotificationPeer {
	readonly bufferedAmount?: number;
	send(data: string): void;
}

export interface NotificationPeerOptions extends NotificationRelayOptions {
	/** Defaults to this process's {@link NOTIFICATION_EPOCH}. */
	epoch?: string;
	/** Cloud path: emit through the control channel's `sendFrame` instead of
	 * writing to the socket directly. The peer is still read for back-pressure. */
	sendFrame?: (frame: Record<string, unknown>) => boolean;
	/** Cloud path: contract check before each send. Defaults to
	 * {@link isProtocolValidCloudFrame}. */
	validate?: (frame: Record<string, unknown>) => boolean;
}

/** The pinned protocol's own strict parser. It checks the envelope (version,
 * kind, the closed status-type set, cid, seq); the status payload is an open
 * record, so the projection above is what bounds the payload. About 10 µs per
 * frame on the workstation, and frames go out at most about once a second. */
export function isProtocolValidCloudFrame(frame: unknown): boolean {
	try {
		strictParseFrame(frame);
		return true;
	} catch {
		return false;
	}
}

/** Shared production adapter for both wire formats. No generic status/config
 * bridge is activated by installing this notification-only peer. */
export function createNotificationPeerRelay(
	path: "cloud" | "legacy",
	snapshot: () => NotificationSnapshot,
	peer: () => NotificationPeer | undefined,
	options: NotificationPeerOptions = {},
) {
	const epoch = options.epoch ?? NOTIFICATION_EPOCH;
	const validate = options.validate ?? isProtocolValidCloudFrame;
	const log = options.log ?? ((m: string) => logger.warn(m));
	let loggedInvalid = false;
	let seq = 0;
	return new NotificationRelay(
		snapshot,
		(payload) => {
			const socket = peer();
			if (!socket || (socket.bufferedAmount ?? 0) > MAX_BYTES) return false;
			const body: NotificationWirePayload = { ...payload, epoch, full: true };
			const frame =
				path === "legacy"
					? { notification: body }
					: {
							v: 1,
							kind: "status",
							type: NOTIFICATIONS_STATUS_TYPE,
							cid: crypto.randomUUID(),
							seq: seq + 1,
							payload: body,
						};
			if (path === "cloud" && !validate(frame)) {
				// A hub drops a frame its strict parser rejects; refuse it here
				// instead, where it can be seen, and keep retrying the latest state.
				if (!loggedInvalid) {
					loggedInvalid = true;
					log(
						"remote notifications: frame rejected by the control protocol's strict parser; not sent (logged once)",
					);
				}
				return false;
			}
			const data = JSON.stringify(frame);
			if (Buffer.byteLength(data) > MAX_BYTES) return false;
			if (path === "cloud" && options.sendFrame) {
				if (!options.sendFrame(frame)) return false;
			} else {
				socket.send(data);
			}
			seq += 1;
			return true;
		},
		options,
	);
}
