export const STREAM_LAUNCH_ORIGINS = [
	"ui",
	"autostart",
	"set-profile",
	"remote-control",
	"restoration",
	// The device's own connection restart after a link kept an old address and
	// nothing else carried the stream (connection-restart.ts).
	"link-recovery",
] as const;
export type StreamLaunchOrigin = (typeof STREAM_LAUNCH_ORIGINS)[number];
// Internal origins wait for the modem replay barrier instead of being refused:
// nobody would retry them. A link-recovery Start follows its own Stop, so a
// refusal would leave the stream down.
export const INTERNAL_LAUNCH_ORIGINS: ReadonlySet<StreamLaunchOrigin> = new Set(
	["autostart", "restoration", "link-recovery"],
);
export const RECONFIGURE_STOP_TIMEOUT_REASON = "reconfigure_stop_timeout";
