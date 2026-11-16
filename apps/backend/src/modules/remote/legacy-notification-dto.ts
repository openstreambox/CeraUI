import { z } from "zod";
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

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const opaque = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.union([opaque, z.literal("remote-overflow")]);
const summaries = new Set([
	...Object.values(NOTIFICATION_SUMMARIES),
	"A cellular connection is roaming.",
	"A camera was lost. Streaming continues on another camera.",
	"Device notification. Open the local interface for details.",
]);
const notice = z
	.object({
		name,
		type: z.enum(["info", "warning", "error", "success"]),
		msg: z.string(),
		revision,
		is_persistent: z.literal(true),
		is_dismissable: z.literal(false),
		duration: z.literal(0),
	})
	.strict()
	.refine((n) =>
		n.name === "remote-overflow"
			? /^[1-9]\d* more device notifications are not shown here\. Open the local interface for details\.$/.test(
					n.msg,
				)
			: summaries.has(n.msg),
	);
const wire = z
	.object({
		show: z.array(notice),
		remove: z.array(z.object({ id: name, revision }).strict()),
		epoch: z.uuid(),
		full: z.literal(true),
	})
	.strict();
export function projectLegacyNotification(v: unknown): unknown {
	const parsed = wire.safeParse(v);
	return parsed.success &&
		Buffer.byteLength(JSON.stringify(parsed.data)) <= 65536
		? parsed.data
		: undefined;
}
