import { createHmac } from "node:crypto";

const identityKey = crypto.getRandomValues(new Uint8Array(32));

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
				? "A cellular connection is roaming."
				: n.name.startsWith("capture-input-lost:")
					? "A camera was lost. Streaming continues on another camera."
					: "Device notification. Open the local interface for details."),
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

/** No event queue: each tick reconciles the latest authoritative state. Failed
 * sends retain only the last accepted state; offline updates are coalesced.
 * The transport must refuse sends above its bounded socket high-water mark. */
export class NotificationRelay {
	private forcePending = false;
	private sent = new Map<string, RemoteNotice>();
	constructor(
		private readonly snapshot: () => NotificationSnapshot,
		private readonly send: (payload: NotificationPayload) => boolean,
	) {}
	flush(force = false): void {
		this.forcePending ||= force;
		try {
			const snapshot = this.snapshot();
			const current = new Map<string, RemoteNotice>();
			for (const value of snapshot.show) {
				const n = projectNotification(value);
				if (n) current.set(n.name, n);
			}
			const remove = [...this.sent.keys()]
				.filter((id) => !current.has(id))
				.map((id) => ({ id, revision: snapshot.revision }));
			const changed =
				remove.length > 0 ||
				current.size !== this.sent.size ||
				[...current].some(
					([id, n]) => this.sent.get(id)?.revision !== n.revision,
				);
			if (!this.forcePending && !changed) return;
			if (this.send({ show: [...current.values()], remove })) {
				this.sent = current;
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

/** Shared production adapter for both wire formats. No generic status/config
 * bridge is activated by installing this notification-only peer. */
export function createNotificationPeerRelay(
	path: "cloud" | "legacy",
	snapshot: () => NotificationSnapshot,
	peer: () => NotificationPeer | undefined,
) {
	let seq = 0;
	return new NotificationRelay(snapshot, (payload) => {
		const socket = peer();
		if (!socket || (socket.bufferedAmount ?? 0) > 65536) return false;
		const frame =
			path === "legacy"
				? { notification: payload }
				: {
						v: 1,
						kind: "status",
						type: "notification",
						cid: crypto.randomUUID(),
						seq: ++seq,
						payload,
					};
		const data = JSON.stringify(frame);
		if (Buffer.byteLength(data) > 65536) return false;
		socket.send(data);
		return true;
	});
}
