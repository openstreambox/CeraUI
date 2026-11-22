/**
 * What may wait for the reconnect re-auth, and what may not.
 *
 * The device authenticates each socket, so a signed-in tab's new socket is
 * signed out until the re-auth answers. Only calls that just read device state
 * may wait for that and go out afterwards: a read sent late is merely late.
 * Reads with an effect beyond reporting state (a network probe, a log
 * download, the idle-activity heartbeat) and contract placeholders without a
 * handler are not among them.
 *
 * Every other call (anything that writes, deletes, installs, scans, pairs or
 * changes credentials, network, power or configuration) fails at once on that
 * socket with "Reconnected to the device. Please try again." and is never sent
 * by the client. The operator may have moved on, retried or changed their mind
 * by the time the session is back, so replaying a call after a drop is never
 * safe by default. The one exception, Stop Stream, is not replayed by the
 * client either: its owner keeps a fenced intent (`INTENTS_AFTER_REAUTH`).
 *
 * This is an allowlist. A procedure on no list is refused;
 * `session-gate-policy.test.ts` fails until every procedure of the contract
 * and of the typed `rpc` proxy is on exactly one list, and until every held
 * read is one the device answers.
 */

/** Goes out on a signed-out socket: it is the re-auth itself. */
export const SIGN_IN_PROCEDURE = "auth.login";

/** Reads of device state: may wait for the re-auth, then go out. */
export const HELD_DURING_REAUTH: ReadonlySet<string> = new Set([
	"addons.getStatus",
	"addons.list",
	"bluetooth.getStatus",
	"moblink.getStatus",
	"modems.getAll",
	"modems.getBands",
	"modems.getCapabilities",
	"modems.getFccUnlock",
	"modems.getGps",
	"modems.getRadioHealth",
	"modems.getSms",
	"modems.getUsbModeOptions",
	"modems.getUssd",
	"modems.listMutationBlocks",
	"network.getInterfaces",
	"network.getSharingPolicy",
	"notifications.getPersistent",
	"status.getRelays",
	"status.getStatus",
	"streaming.getAudioCodecs",
	"streaming.getConfig",
	"streaming.getEngine",
	"streaming.getMockHardware",
	"streaming.getPipelines",
	"streaming.listDevices",
	"streaming.streamHealth",
	"system.getCloudProviders",
	"system.getPhoneBox",
	"system.getRevisions",
	"system.getSensors",
	"system.getUpdateCapabilities",
	"system.getUpdateDetails",
	"system.getUpdateSettings",
	"system.kioskStatus",
	"wifi.getAdapterModes",
	"wifi.getStatus",
]);

/**
 * Operator intents the client refuses like any change, but whose OWNER keeps
 * one pending request and sends it once the session is back: Stop Stream. A
 * stream left running is worse than one late, coalesced stop (the device
 * answers "stopped" when already idle). The owner is the stop intent in
 * subscriptions.svelte.ts, fenced to this tab's session.
 */
export const INTENTS_AFTER_REAUTH: ReadonlySet<string> = new Set([
	"streaming.stop",
]);

/** Everything else, listed so a new procedure has to be decided explicitly. */
export const REFUSED_DURING_REAUTH: ReadonlySet<string> = new Set([
	"addons.install",
	"addons.uninstall",
	"auth.logout",
	"auth.revokeToken",
	"auth.setPassword",
	"bluetooth.connect",
	"bluetooth.disable",
	"bluetooth.disconnect",
	"bluetooth.enable",
	"bluetooth.forget",
	"bluetooth.pair",
	"bluetooth.scanStart",
	"bluetooth.scanStop",
	"bluetooth.trust",
	"dev.emit",
	"events.boots",
	"events.clear",
	"events.list",
	"logs.around",
	"logs.boots",
	"logs.clearAll",
	"logs.createBundle",
	"logs.createExport",
	"logs.deleteLegacyDebug",
	"logs.followStart",
	"logs.followStop",
	"logs.getStorage",
	"logs.previewBundle",
	"logs.query",
	"logs.setRetention",
	"moblink.clearCredential",
	"moblink.setCredential",
	"modems.clearUnreadableRecord",
	"modems.acknowledgeMutation",
	"modems.clearCredentials",
	"modems.configure",
	"modems.decommissionMutation",
	"modems.esimOperation",
	"modems.onStatusChange",
	"modems.openRouterAdmin",
	"modems.rebaselineMutation",
	"modems.scan",
	"modems.setBands",
	"modems.setCapabilities",
	"modems.setCredentials",
	"modems.setFccUnlock",
	"modems.setFiveGPreference",
	"modems.setGps",
	"modems.setRouterControl",
	"modems.setRouterNetMode",
	"modems.setRouterSubnet",
	"modems.setUsbMode",
	"modems.unlockSim",
	"modems.unlockSimPin2",
	"modems.unlockSimPuk",
	"modems.ussdCancel",
	"modems.ussdInitiate",
	"modems.ussdRespond",
	"modems.verifyCredentials",
	"network.configure",
	"network.onStatusChange",
	"network.setEthernetRole",
	"network.setIngestEnabled",
	"network.setSharingPolicy",
	"notifications.dismiss",
	"notifications.onNotification",
	"pairing.completePairing",
	"pairing.generateClaimCode",
	"relay.validate",
	"status.onStatusChange",
	"streaming.onStatusChange",
	"streaming.reloadAudioDelay",
	"streaming.restartConnection",
	"streaming.setAudioMix",
	"streaming.setBitrate",
	"streaming.setConfig",
	"streaming.setMockDeviceAttached",
	"streaming.setMockHardware",
	"streaming.setSourceVisibility",
	"streaming.start",
	"streaming.switchAudio",
	"streaming.switchInput",
	"system.allowCellularOnce",
	"system.checkForUpdates",
	"system.checkUpdatesNow",
	"system.getLog",
	"system.getSyslog",
	"system.installUpdatesNow",
	"system.kioskConfigure",
	"system.kioskOsk",
	"system.kioskStart",
	"system.kioskStop",
	"system.mintPreviewToken",
	"system.onSensorsChange",
	"system.onUpdateProgress",
	"system.poweroff",
	"system.reboot",
	"system.setAutostart",
	"system.setPhoneWay",
	"system.setRemoteConfig",
	"system.setUpdateSettings",
	"system.sshResetPassword",
	"system.sshSetPersistent",
	"system.sshStart",
	"system.sshStop",
	"system.startUpdate",
	"system.tailscaleJoin",
	"system.tailscaleLogout",
	"system.tailscaleSetEnabled",
	"ui.heartbeat",
	"wifi.connect",
	"wifi.connectNew",
	"wifi.disconnect",
	"wifi.forget",
	"wifi.hotspotConfigure",
	"wifi.hotspotPrepare",
	"wifi.hotspotStart",
	"wifi.hotspotStop",
	"wifi.onStatusChange",
	"wifi.portal",
	"wifi.scan",
	"wifi.setAdapterMode",
	"wifi.setCountry",
]);

/** Whether a call may wait on a socket that the re-auth has not signed in yet. */
export function mayHoldForReauth(procedure: string): boolean {
	return HELD_DURING_REAUTH.has(procedure);
}
