// A support journal assembled from what a device actually writes, NOT a device
// capture. Third-party lines use format strings the daemons log at info level
// or above, taken from the Debian source packages: ModemManager 1.20.4 and
// NetworkManager 1.42.4 (bookworm), CeraLive's ModemManager 1.24.2 carry and
// NetworkManager 1.52.1 (trixie), wpa_supplicant 2.10 (both). Backend lines
// are only warn/error events, because the production console logs at warn,
// and each message is one this backend writes. ModemManager hides personal
// values as ### unless started with --log-personal-info; the sample shows the
// unhidden form so the export's own masking is tested.
//
// Incidents: a modem that needs its PIN, is denied registration, fails on a
// missing APN and then connects; a Wi-Fi uplink with a wrong key that later
// drops; a hotspot client; a sender that exits mid-stream and a stream start
// that fails after its retries; an under-voltage USB reset.
import {
	event,
	type JournalRecord,
	kernel,
	modemManager,
	networkManager,
	systemd,
	wpaSupplicant as wpa,
} from "./journal-records.ts";

export type Generation = "bookworm" | "trixie";

/** Values that must never reach the export from this sample. */
export const sampleSecrets = [
	"ExampleHomeNet",
	"Example Carrier Plan",
	"Jane Doe Mobile",
	"26201",
	"203.0.113.7",
	"198.51.100.20",
	"3c:a6:2f:11:22:33",
	"02:11:22:33:44:55",
	"8901260000000000000",
	"a1b2c3d4e5f6",
	"Hunter2Secret",
	"Bobs-phone",
	"attempt-7f3a9c2e",
];

export function journalSampleFor(generation: Generation): JournalRecord[] {
	const trixie = generation === "trixie";
	// ModemManager's syslog level text: 1.20 pads "<info> " and adds a space.
	const level = {
		info: trixie ? "<inf> " : "<info>  ",
		msg: trixie ? "<msg> " : "<info>  ",
		warn: trixie ? "<wrn> " : "<warn>  ",
		err: trixie ? "<err> " : "<error> ",
	};
	// ModemManager 1.24 logs msg, warn and error by default, not info; the
	// image does not pass --log-level, so trixie journals hold no <inf> lines.
	const mm = (kind: keyof typeof level, text: string) =>
		trixie && kind === "info"
			? undefined
			: modemManager(`${level[kind]}${text}`);
	const nm = (kind: "info" | "warn", text: string) =>
		networkManager(
			`${kind === "info" ? "<info> " : "<warn> "} [1731528245.1234] ${text}`,
		);
	const managed = trixie
		? "managed-type: 'full'"
		: "sys-iface-state: 'managed'";
	const change = (iface: string, from: string, to: string, reason: string) =>
		nm(
			"info",
			`device (${iface}): state change: ${from} -> ${to} (reason '${reason}', ${managed})`,
		);
	const warn = (msg: string, meta?: Record<string, unknown>) =>
		event({
			ts: "2026-11-13T20:04:05.000Z",
			level: "warn",
			msg,
			...(meta ? { meta } : {}),
		});
	const error = (msg: string, meta?: Record<string, unknown>) =>
		event({
			ts: "2026-11-13T20:34:06.000Z",
			level: "error",
			msg,
			...(meta ? { meta } : {}),
		});

	const records: (JournalRecord | undefined)[] = [
		// Boot.
		kernel("Booting Linux on physical CPU 0x0000000000 [0x412fd050]"),
		kernel(
			"Linux version 6.1.75-vendor (builder@example) (gcc 12.2.0) #1 SMP PREEMPT",
		),
		kernel("Machine model: Example ARM board"),
		kernel("usb 1-1: new high-speed USB device number 2 using xhci-hcd"),
		kernel(
			"usb 1-1: New USB device found, idVendor=2c7c, idProduct=0800, bcdDevice= 4.14",
		),
		kernel("usb 1-1: New USB device strings: Mfr=1, Product=2, SerialNumber=3"),
		kernel("usb 1-1: Product: RM500Q-GL"),
		kernel("usb 1-1: Manufacturer: Quectel"),
		kernel("usb 1-1: SerialNumber: a1b2c3d4e5f6"),
		kernel("option 1-1:1.0: GSM modem (1-port) converter detected"),
		kernel("usb 1-1: GSM modem (1-port) converter now attached to ttyUSB2"),
		kernel(
			"qmi_wwan 1-1:1.4 wwan0: register 'qmi_wwan' at usb-xhci-hcd.0.auto-1, WWAN/QMI device, 02:11:22:33:44:55",
		),
		kernel("usbcore: registered new interface driver qmi_wwan"),
		systemd("Started ModemManager.service - Modem Manager."),
		systemd("Started NetworkManager.service - Network Manager."),
		systemd("Started wpa_supplicant.service - WPA supplicant."),
		systemd("Started ceralive.service - CeraLive."),
		// Modem: PIN, registration denied, missing APN, then connected.
		mm(
			"msg",
			`ModemManager (version ${trixie ? "1.24.2" : "1.20.4"}) starting in system bus...`,
		),
		mm(
			"msg",
			`[device /sys/devices/platform/usb/1-1] creating modem with plugin 'quectel' and '5' ports${trixie ? " (2c7c:0800)" : ""}`,
		),
		mm(
			"msg",
			"[base-manager] modem for device '/sys/devices/platform/usb/1-1' successfully created",
		),
		mm(
			"warn",
			"[modem0] modem couldn't be initialized: Couldn't check unlock status: SIM PIN required",
		),
		mm("msg", "[modem0] state changed (unknown -> locked)"),
		...(trixie
			? [
					mm("warn", "[modem0] modem is locked with 'sim-pin'"),
					mm("warn", "[modem0] failed sending SIM PIN: Incorrect password"),
				]
			: []),
		networkManager(
			'<warn>  [1731528245.1234] modem["cdc-wdm0"]: cannot enable/disable modem: locked',
		),
		mm("info", "[modem0/sim0] loaded SIM identifier: 8901260000000000000"),
		warn(
			"SIM PIN auto-unlock: modem 0 not unlocked (incorrect PIN); clearing stored PIN — manual entry required",
		),
		mm("msg", "[modem0] state changed (locked -> disabled)"),
		mm("msg", "[modem0] state changed (disabled -> enabling)"),
		mm("msg", "[modem0] power state updated: on"),
		mm("msg", "[modem0] state changed (enabling -> enabled)"),
		mm("msg", "[modem0] 3GPP registration state changed (idle -> searching)"),
		mm("msg", "[modem0] state changed (enabled -> searching)"),
		mm("msg", "[modem0] 3GPP registration state changed (searching -> denied)"),
		...(trixie
			? [
					mm(
						"warn",
						"[modem0] Network rejection received: reason 'plmn-not-allowed' (11), operator id '26201', operator name 'Jane Doe Mobile', access technology 'lte'",
					),
					mm(
						"warn",
						"[modem0] registration in network failed: Network timeout",
					),
				]
			: []),
		mm("msg", "[modem0] 3GPP registration state changed (denied -> home)"),
		mm("msg", "[modem0] state changed (searching -> registered)"),
		mm("msg", "[modem0] simple connect started..."),
		mm("msg", "[modem0] simple connect state (3/10): enable"),
		mm("msg", "[modem0] simple connect state (5/10): register"),
		mm("msg", "[modem0] simple connect state (6/10): bearer"),
		mm("msg", "[modem0] simple connect state (7/10): connect"),
		mm("msg", "[modem0] state changed (registered -> connecting)"),
		mm(
			"warn",
			"[modem0/bearer1] connection attempt #1 failed: Missing or unknown APN",
		),
		...(trixie
			? [
					mm(
						"msg",
						"[modem0/bearer1] couldn't start IPv4 network: QMI protocol error (14): 'CallFailed'",
					),
				]
			: []),
		mm(
			"msg",
			`[modem0/bearer1] ${trixie ? "  " : ""}call end reason (3): generic-unspecified`,
		),
		mm(
			"msg",
			"[modem0/bearer1] verbose call end reason (6,33): [3gpp] option-unsubscribed",
		),
		mm(
			"warn",
			"[modem0] couldn't connect: QMI protocol error (14): 'CallFailed'",
		),
		mm(
			"warn",
			"[modem0/bearer1] couldn't connect bearer: credentials (exampleuser, Hunter2Secret)",
		),
		mm("msg", "[modem0] state changed (connecting -> registered)"),
		nm(
			"info",
			"manager: (cdc-wdm0): new Broadband device (/org/freedesktop/NetworkManager/Devices/4)",
		),
		change("cdc-wdm0", "unavailable", "disconnected", "none"),
		nm(
			"info",
			"device (cdc-wdm0): Activation: starting connection 'Example Carrier Plan' (0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0)",
		),
		change("cdc-wdm0", "disconnected", "prepare", "none"),
		nm(
			"warn",
			"modem-broadband[cdc-wdm0]: failed to connect modem: Missing or unknown APN",
		),
		change("cdc-wdm0", "prepare", "failed", "gsm-apn-failed"),
		nm(
			"warn",
			"device (cdc-wdm0): Activation: failed for connection 'Example Carrier Plan'",
		),
		change("cdc-wdm0", "failed", "disconnected", "none"),
		nm(
			"info",
			"device (cdc-wdm0): Activation: starting connection 'Example Carrier Plan' (0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0)",
		),
		mm("msg", "[modem0] state changed (registered -> connecting)"),
		mm("msg", "[modem0] state changed (connecting -> connected)"),
		mm("msg", "[modem0] simple connect state (8/10): all done"),
		change("cdc-wdm0", "ip-config", "ip-check", "none"),
		nm("info", "device (cdc-wdm0): Activation: successful, device activated."),
		nm(
			"info",
			"policy: set 'Example Carrier Plan' (wwan0) as default for IPv4 routing and DNS",
		),
		nm("info", "manager: NetworkManager state is now CONNECTED_GLOBAL"),
		mm(
			"warn",
			"[modem0/ttyUSB2/at] port ttyUSB2 timed out 3 consecutive times",
		),
		mm("warn", "[modem0] couldn't load operator name: Jane Doe Mobile"),
		mm(
			"msg",
			"[modem0/bearer1] connection #1 finished: duration 1843s, tx: 734003200 bytes, rx: 1048576 bytes",
		),
		// Wi-Fi uplink: wrong key, then it connects and later drops.
		nm(
			"info",
			"device (wlan0): Activation: starting connection 'ExampleHomeNet' (1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809)",
		),
		nm(
			"info",
			"device (wlan0): supplicant interface state: disconnected -> scanning",
		),
		wpa(
			"wlan0: SME: Trying to authenticate with 3c:a6:2f:11:22:33 (SSID='ExampleHomeNet' freq=2437 MHz)",
		),
		wpa(
			"wlan0: Trying to associate with 3c:a6:2f:11:22:33 (SSID='ExampleHomeNet' freq=2437 MHz)",
		),
		wpa("wlan0: Associated with 3c:a6:2f:11:22:33"),
		wpa("wlan0: WPA: 4-Way Handshake failed - pre-shared key may be incorrect"),
		wpa(
			'wlan0: CTRL-EVENT-SSID-TEMP-DISABLED id=0 ssid="ExampleHomeNet" auth_failures=1 duration=10 reason=WRONG_KEY',
		),
		wpa("wlan0: CTRL-EVENT-DISCONNECTED bssid=3c:a6:2f:11:22:33 reason=15"),
		nm(
			"info",
			"device (wlan0): Activation: (wifi) access point 'ExampleHomeNet' has security, but secrets are required.",
		),
		change("wlan0", "config", "need-auth", "none"),
		change("wlan0", "need-auth", "failed", "no-secrets"),
		nm(
			"info",
			"device (wlan0): Activation: starting connection 'ExampleHomeNet' (1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809)",
		),
		wpa(
			"wlan0: WPA: Key negotiation completed with 3c:a6:2f:11:22:33 [PTK=CCMP GTK=CCMP]",
		),
		wpa(
			"wlan0: CTRL-EVENT-CONNECTED - Connection to 3c:a6:2f:11:22:33 completed [id=0 id_str=]",
		),
		nm(
			"info",
			'device (wlan0): Activation: (wifi) Stage 2 of 5 (Device Configure) successful. Connected to wireless network "ExampleHomeNet"',
		),
		nm(
			"info",
			"dhcp4 (wlan0): activation: beginning transaction (timeout in 45 seconds)",
		),
		nm("info", "dhcp4 (wlan0): state changed new lease, address=198.51.100.20"),
		nm("info", "device (wlan0): Activation: successful, device activated."),
		wpa(
			"wlan0: CTRL-EVENT-REGDOM-CHANGE init=COUNTRY_IE type=COUNTRY alpha2=US",
		),
		wpa("wlan0: CTRL-EVENT-BSS-ADDED 0 3c:a6:2f:11:22:33"),
		wpa("wlan0: CTRL-EVENT-DISCONNECTED bssid=3c:a6:2f:11:22:33 reason=4"),
		kernel(
			"wlan0: deauthenticating from 3c:a6:2f:11:22:33 by local choice (Reason: 3=DEAUTH_LEAVING)",
		),
		change("wlan0", "activated", "failed", "supplicant-timeout"),
		nm(
			"warn",
			"device (wlan0): Activation: (wifi) association took too long, failing activation",
		),
		warn("Default-route connectivity observation unavailable", {
			error: { name: "Error", message: "ENETUNREACH" },
		}),
		// Hotspot through NetworkManager's AP mode (wpa_supplicant).
		wpa("wlan1: interface state UNINITIALIZED->ENABLED"),
		wpa("wlan1: AP-ENABLED "),
		nm(
			"info",
			'device (wlan1): Activation: (wifi) Stage 2 of 5 (Device Configure) successful. Started Wi-Fi Hotspot "ExampleHomeNet"',
		),
		wpa("wlan1: AP-STA-CONNECTED 3c:a6:2f:11:22:33 keyid=Bobs-phone"),
		wpa("wlan1: AP-STA-DISCONNECTED 3c:a6:2f:11:22:33"),
		// Power and USB trouble.
		kernel("hwmon hwmon1: Undervoltage detected!"),
		kernel("usb 1-1: USB disconnect, device number 2"),
		kernel(
			"option1 ttyUSB2: GSM modem (1-port) converter now disconnected from ttyUSB2",
		),
		kernel(
			"qmi_wwan 1-1:1.4 wwan0: unregister 'qmi_wwan' usb-xhci-hcd.0.auto-1, WWAN/QMI device",
		),
		kernel("usb 1-1: device descriptor read/64, error -71"),
		kernel("usb 1-1: reset high-speed USB device number 3 using xhci-hcd"),
		kernel("hwmon hwmon1: Voltage normalised"),
		// Stream: the sender exits, a restart fails after its retries.
		warn(
			"streamloop: /usr/bin/srtla_send exited (code=1, signal=null); not respawning — systemd owns process restart (ADR-0005)",
		),
		// Winston appends the diagnostic's message to the text.
		warn("stream start retry scheduled engine socket not reachable", {
			attemptId: "attempt-7f3a9c2e",
			phase: "connect",
			class: "engine_unavailable",
			code: "ECONNREFUSED",
			retry: {
				state: "scheduled",
				attempt: 1,
				nextAttempt: 2,
				maxAttempts: 3,
				delayMs: 2000,
				suppressed: false,
			},
		}),
		error("stream start failed engine socket not reachable", {
			attemptId: "attempt-7f3a9c2e",
			phase: "connect",
			class: "engine_unavailable",
			code: "ECONNREFUSED",
			retry: {
				state: "exhausted",
				attempt: 3,
				maxAttempts: 3,
				suppressed: false,
			},
		}),
		error("Failed to start stream", {
			err: {
				name: "Error",
				message: "spawn /usr/bin/srtla_send ENOENT",
				stack: "Error: spawn /usr/bin/srtla_send ENOENT\n    at private-stack",
			},
		}),
		systemd(
			"ceralive.service: Main process exited, code=killed, status=9/KILL",
		),
		systemd("ceralive.service: Failed with result 'signal'."),
		systemd(
			"ceralive.service: Scheduled restart job, restart counter is at 1.",
		),
		kernel(
			"Out of memory: Killed process 4321 (ceralive) total-vm:2345678kB, anon-rss:1234567kB, file-rss:0kB, shmem-rss:0kB, UID:0 pgtables:4567kB oom_score_adj:0",
		),
	];
	return records.filter((record): record is JournalRecord => !!record);
}

/** The current device image (trixie). */
export const journalSample = journalSampleFor("trixie");
