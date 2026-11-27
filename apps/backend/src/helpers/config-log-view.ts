import type { RuntimeConfig } from "./config-schemas.ts";
import { REDACTED } from "./logger.ts";

/**
 * Runtime config fields whose VALUES may appear in a log record.
 *
 * Default-deny: a field not listed here is logged as present but masked, so a
 * credential added to `runtimeConfigSchema` later stays out of the journal
 * until someone decides it is safe to show. The key-side rules in `logger.ts`
 * still run on everything listed here.
 *
 * Listed are settings whose values are scalars or closed enums and carry no
 * identifier. Deliberately absent: every credential (`password`,
 * `password_hash`, `ssh_pass`, `ssh_pass_hash`, `srt_passphrase`, `remote_key`,
 * `pairing_secret`), stream ids and the relay override, the relay server and
 * account, the receiver address, device and source identifiers (`device_id`,
 * `source`, `selected_video_input`, stable ids, `source_preference`,
 * `composition`, `audio_inputs`, `asrc`, `pipeline`), maps keyed by a MAC, an
 * interface or a physical link (`wifi_modes`, `eth_roles`, `bond_opt_out`,
 * `usb_serial_shared`, `fm350_internal_calls`), remembered SSIDs and devices, the custom provider host,
 * and add-on user config.
 */
export const LOGGABLE_CONFIG_FIELDS: ReadonlySet<keyof RuntimeConfig> = new Set<
	keyof RuntimeConfig
>([
	"ssh_persistent",
	"relay_protocol",
	"srt_pbkeylen",
	"srt_latency",
	"fec_enabled",
	"recovery_mode",
	"stream_profile",
	"profile_decided_by",
	"srtla_port",
	"acodec",
	"audio_backend",
	"bitrate_overlay",
	"max_br",
	"delay",
	"balancer",
	"resolution",
	"framerate",
	"video_codec",
	"video_passthrough",
	"failover_rate_policy",
	"input_mode",
	"previewEncode",
	"captive_portal_enabled",
	"autostart",
	"remote_provider",
	"detectionMethod",
	"kiosk_enabled",
	"kiosk_last_state",
	"kiosk_display",
	"kiosk_touch",
	"kiosk_motion",
	"kiosk_performance",
	"two_radio_enabled",
	"network_ingest",
	"country",
	"modem_provisioning",
	"modem_backend",
	"modem_shadow",
	"modem_capabilities",
]);

/** A log-safe projection of the runtime config: listed values, other keys masked. */
export function configLogView(config: RuntimeConfig): Record<string, unknown> {
	const view: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		if (value === undefined) continue;
		view[key] = LOGGABLE_CONFIG_FIELDS.has(key as keyof RuntimeConfig)
			? value
			: REDACTED;
	}
	return view;
}
