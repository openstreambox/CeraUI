// A realistic support journal assembled from the log formats of the upstream
// daemons (ModemManager 1.20+, NetworkManager 1.4x, wpa_supplicant, hostapd,
// Linux 6.x, systemd) and this backend's logger. It is NOT a device capture.
// It holds only records the export's journalctl matches would fetch: one boot
// with a modem that fails then registers, a Wi-Fi uplink with a wrong key, a
// hotspot client, and a stream that starts, loses its sender and stops.
import {
	ceralive,
	event,
	hostapd,
	type JournalRecord,
	kernel,
	modemManager as mm,
	networkManager as nmRaw,
	systemd,
	wpaSupplicant as wpa,
} from "./journal-records.ts";

const nm = (message: string) =>
	nmRaw(message.replace(/^(<[a-z]+>\s+)/, "$1[1731528245.1234] "));

/** Values that must never reach the export from this sample. */
export const sampleSecrets = [
	"ExampleHomeNet",
	"Example Carrier Plan",
	"example-host",
	"203.0.113.7",
	"198.51.100.20",
	"3c:a6:2f:11:22:33",
	"02:11:22:33:44:55",
	"351756051523999",
	"8901260000000000000",
	"310260000000000",
	"a1b2c3d4e5f6",
	"osbkey7f3a9c2e",
	"1A2D003",
];

export const journalSample: JournalRecord[] = [
	// Boot.
	kernel("Booting Linux on physical CPU 0x0000000000 [0x412fd050]"),
	kernel(
		"Linux version 6.1.75-vendor (builder@example) (gcc 12.2.0) #1 SMP PREEMPT",
	),
	kernel("Machine model: Example ARM board"),
	kernel("Memory: 3889552K/4061184K available (16384K kernel code)"),
	kernel("random: crng init done"),
	kernel("usb 1-1: new high-speed USB device number 2 using xhci-hcd"),
	kernel(
		"usb 1-1: New USB device found, idVendor=2c7c, idProduct=0800, bcdDevice= 4.14",
	),
	kernel("usb 1-1: New USB device strings: Mfr=1, Product=2, SerialNumber=3"),
	kernel("usb 1-1: Product: RM500Q-GL"),
	kernel("usb 1-1: Manufacturer: Quectel"),
	kernel("usb 1-1: SerialNumber: a1b2c3d4e5f6"),
	kernel("option 1-1:1.0: GSM modem (1-port) converter detected"),
	kernel("usb 1-1: GSM modem (1-port) converter now attached to ttyUSB0"),
	kernel("usb 1-1: GSM modem (1-port) converter now attached to ttyUSB1"),
	kernel("usb 1-1: GSM modem (1-port) converter now attached to ttyUSB2"),
	kernel(
		"qmi_wwan 1-1:1.4 wwan0: register 'qmi_wwan' at usb-xhci-hcd.0.auto-1, WWAN/QMI device, 02:11:22:33:44:55",
	),
	kernel("usbcore: registered new interface driver qmi_wwan"),
	kernel("EXT4-fs (mmcblk0p2): mounted filesystem with ordered data mode"),
	kernel(
		"brcmfmac: brcmf_c_preinit_dcmds: Firmware: BCM43455/1 wl0: Feb 27 2018 03:15:32 version 7.45.154",
	),
	kernel("IPv6: ADDRCONF(NETDEV_CHANGE): wlan0: link becomes ready"),
	systemd("Started ModemManager.service - Modem Manager."),
	systemd("Started NetworkManager.service - Network Manager."),
	systemd("Started wpa_supplicant.service - WPA supplicant."),
	systemd("Starting ceralive.service - CeraLive..."),
	systemd("Started ceralive.service - CeraLive."),
	systemd("Reached target multi-user.target - Multi-User System."),
	// ModemManager.
	mm("<info>  ModemManager (version 1.20.4) starting in system bus..."),
	mm(
		"<info>  [device /sys/devices/platform/usb/1-1] creating modem with plugin 'quectel' and '5' ports",
	),
	mm(
		"<info>  [base-manager] modem for device '/sys/devices/platform/usb/1-1' successfully created",
	),
	mm("<info>  [modem0] state changed (unknown -> locked)"),
	mm(
		"<warn>  [modem0] modem couldn't be initialized: Couldn't check unlock status: SIM PIN required",
	),
	mm("<info>  [modem0] state changed (locked -> disabled)"),
	mm("<info>  [modem0] state changed (disabled -> enabling)"),
	mm("<info>  [modem0] power state updated: on"),
	mm("<info>  [modem0] equipment identifier: 351756051523999"),
	mm("<info>  [modem0] sim identifier: 8901260000000000000"),
	mm("<info>  [modem0] subscriber identifier: 310260000000000"),
	mm("<info>  [modem0] state changed (enabling -> enabled)"),
	mm("<info>  [modem0] 3GPP registration state changed (idle -> searching)"),
	mm("<info>  [modem0] state changed (enabled -> searching)"),
	mm(
		"<info>  [modem0] 3GPP registration info: operator id 310260, cell 1A2D003",
	),
	mm("<info>  [modem0] 3GPP registration state changed (searching -> denied)"),
	mm("<info>  [modem0] 3GPP registration state changed (denied -> home)"),
	mm("<info>  [modem0] state changed (searching -> registered)"),
	mm("<info>  [modem0] access technology changed (unknown -> lte)"),
	mm("<info>  [modem0] signal quality updated (38)"),
	mm("<info>  [modem0] simple connect started..."),
	mm("<info>  [modem0] simple connect state (3/10): enable"),
	mm("<info>  [modem0] simple connect state (4/10): wait to get fully enabled"),
	mm("<info>  [modem0] simple connect state (5/10): register"),
	mm("<info>  [modem0] simple connect state (6/10): bearer"),
	mm("<info>  [modem0] simple connect state (7/10): connect"),
	mm("<info>  [modem0] state changed (registered -> connecting)"),
	mm(
		"<wrn> [modem0/bearer1] connection attempt #1 failed: missing-or-unknown-apn",
	),
	mm("<info>  [modem0] state changed (connecting -> registered)"),
	mm("<info>  [modem0] simple connect state (7/10): connect"),
	mm("<info>  [modem0] state changed (registered -> connecting)"),
	mm("<info>  [modem0] state changed (connecting -> connected)"),
	mm("<info>  [modem0] simple connect state (8/10): all done"),
	mm(
		"<info>  [modem0] 3GPP packet service state changed (detached -> attached)",
	),
	mm("<info>  [modem0] signal quality updated (41)"),
	mm("<wrn> [modem0/ttyUSB2/at] port timed out 3 consecutive times"),
	mm(
		"<info>  [modem0] location: 3GPP location updated (MCC: '310', MNC: '260', location area code: '0', tracking area code: '1A2D', cell ID: '01A2D003')",
	),
	mm(
		"<warn>  [modem0] couldn't load supported modes: Serial command timed out",
	),
	mm(
		"<info>  [modem0/bearer1] connection #1 finished: duration 1843s, tx: 734003200 bytes, rx: 1048576 bytes",
	),
	// NetworkManager.
	nm("<info>  NetworkManager (version 1.42.4) is starting... (boot:synthetic)"),
	nm(
		"<info>  manager: (wwan0): new Broadband device (/org/freedesktop/NetworkManager/Devices/4)",
	),
	nm(
		"<info>  manager: (wlan0): new 802.11 Wi-Fi device (/org/freedesktop/NetworkManager/Devices/3)",
	),
	nm(
		"<info>  device (cdc-wdm0): state change: unavailable -> disconnected (reason 'none', sys-iface-state: 'managed')",
	),
	nm(
		"<info>  device (cdc-wdm0): Activation: starting connection 'Example Carrier Plan' (0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0)",
	),
	nm(
		"<info>  device (cdc-wdm0): state change: disconnected -> prepare (reason 'none', sys-iface-state: 'managed')",
	),
	nm(
		"<info>  device (cdc-wdm0): Activation: Stage 1 of 5 (Device Prepare) scheduled...",
	),
	nm(
		"<warn>  modem-broadband[cdc-wdm0]: failed to connect modem: missing-or-unknown-apn",
	),
	nm(
		"<info>  device (cdc-wdm0): state change: prepare -> failed (reason 'gsm-apn-failed', sys-iface-state: 'managed')",
	),
	nm(
		"<warn>  device (cdc-wdm0): Activation: failed for connection 'Example Carrier Plan'",
	),
	nm(
		"<info>  device (cdc-wdm0): state change: failed -> disconnected (reason 'none', sys-iface-state: 'managed')",
	),
	nm(
		"<info>  device (cdc-wdm0): Activation: starting connection 'Example Carrier Plan' (0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0)",
	),
	nm(
		"<info>  modem-broadband[cdc-wdm0]: modem state changed, 'registered' --> 'connecting' (reason: user-requested)",
	),
	nm(
		"<info>  modem-broadband[cdc-wdm0]: modem state changed, 'connecting' --> 'connected' (reason: user-requested)",
	),
	nm(
		"<info>  device (cdc-wdm0): state change: ip-config -> ip-check (reason 'none', sys-iface-state: 'managed')",
	),
	nm("<info>  device (cdc-wdm0): Activation: successful, device activated."),
	nm(
		"<info>  policy: set 'Example Carrier Plan' (wwan0) as default for IPv4 routing and DNS",
	),
	nm("<info>  manager: NetworkManager state is now CONNECTED_GLOBAL"),
	nm(
		"<info>  device (wlan0): Activation: starting connection 'ExampleHomeNet' (1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809)",
	),
	nm(
		"<info>  device (wlan0): supplicant interface state: disconnected -> scanning",
	),
	nm(
		"<info>  device (wlan0): supplicant interface state: scanning -> authenticating",
	),
	nm(
		"<info>  device (wlan0): Activation: (wifi) access point 'ExampleHomeNet' has security, but secrets are required.",
	),
	nm(
		"<warn>  device (wlan0): state change: config -> failed (reason 'no-secrets', sys-iface-state: 'managed')",
	),
	nm(
		"<info>  device (wlan0): Activation: starting connection 'ExampleHomeNet' (1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809)",
	),
	nm(
		"<info>  dhcp4 (wlan0): activation: beginning transaction (timeout in 45 seconds)",
	),
	nm("<info>  dhcp4 (wlan0): option domain_name_servers  => '203.0.113.7'"),
	nm("<info>  dhcp4 (wlan0): option host_name            => 'example-host'"),
	nm("<info>  dhcp4 (wlan0): option ip_address           => '198.51.100.20'"),
	nm("<info>  dhcp4 (wlan0): option routers              => '198.51.100.1'"),
	nm("<info>  dhcp4 (wlan0): state changed new lease, address=198.51.100.20"),
	nm(
		"<info>  device (wlan0): state change: ip-config -> ip-check (reason 'none', sys-iface-state: 'managed')",
	),
	nm("<info>  connectivity: (wlan0,IPv4,8) check failed to 203.0.113.7:80"),
	nm("<info>  device (wlan0): carrier: link connected"),
	// Wi-Fi client.
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
	wpa('wlan0: CTRL-EVENT-SSID-REENABLED id=0 ssid="ExampleHomeNet"'),
	wpa(
		"wlan0: WPA: Key negotiation completed with 3c:a6:2f:11:22:33 [PTK=CCMP GTK=CCMP]",
	),
	wpa(
		"wlan0: CTRL-EVENT-CONNECTED - Connection to 3c:a6:2f:11:22:33 completed [id=0 id_str=]",
	),
	wpa("wlan0: CTRL-EVENT-REGDOM-CHANGE init=COUNTRY_IE type=COUNTRY alpha2=US"),
	wpa(
		"wlan0: CTRL-EVENT-SIGNAL-CHANGE above=0 signal=-71 noise=-92 txrate=65000",
	),
	wpa("wlan0: CTRL-EVENT-BSS-ADDED 0 3c:a6:2f:11:22:33"),
	wpa("wlan0: PMKSA-CACHE-ADDED 3c:a6:2f:11:22:33 0"),
	// Hotspot.
	hostapd("wlan1: interface state UNINITIALIZED->ENABLED"),
	hostapd("wlan1: AP-ENABLED"),
	hostapd("wlan1: STA 3c:a6:2f:11:22:33 IEEE 802.11: associated"),
	hostapd("wlan1: AP-STA-CONNECTED 3c:a6:2f:11:22:33"),
	hostapd(
		"wlan1: STA 3c:a6:2f:11:22:33 WPA: pairwise key handshake completed (RSN)",
	),
	hostapd("wlan1: AP-STA-DISCONNECTED 3c:a6:2f:11:22:33"),
	// Power and USB trouble.
	kernel("hwmon hwmon1: Undervoltage detected!"),
	kernel("hwmon hwmon1: Voltage normalised"),
	kernel("usb 1-1: USB disconnect, device number 2"),
	kernel(
		"option1 ttyUSB2: GSM modem (1-port) converter now disconnected from ttyUSB2",
	),
	kernel(
		"qmi_wwan 1-1:1.4 wwan0: unregister 'qmi_wwan' usb-xhci-hcd.0.auto-1, WWAN/QMI device",
	),
	kernel("usb 1-1: new high-speed USB device number 3 using xhci-hcd"),
	kernel("usb 1-1: device descriptor read/64, error -71"),
	kernel("usb usb1-port1: over-current condition"),
	kernel("usb 1-1: reset high-speed USB device number 3 using xhci-hcd"),
	// Stream.
	event({
		ts: "2026-11-13T20:04:05.000Z",
		level: "info",
		msg: "RPC streaming.start ok",
		meta: { procedure: "streaming.start", latency_ms: 12, ok: true },
	}),
	event({
		ts: "2026-11-13T20:04:05.100Z",
		level: "info",
		msg: "stream starting",
		module: "streaming",
		meta: { stage: "launch" },
	}),
	event({
		ts: "2026-11-13T20:04:05.200Z",
		level: "info",
		msg: "relay: ingest_key=osbkey7f3a9c2e server=relay.example.org",
		module: "srtla",
	}),
	event({
		ts: "2026-11-13T20:04:06.000Z",
		level: "warn",
		msg: "uplink wwan0 degraded",
		module: "network",
		meta: { ifname: "wwan0", latency_ms: 840 },
	}),
	event({
		ts: "2026-11-13T20:34:06.000Z",
		level: "error",
		msg: "Failed to restart sender",
		module: "streaming",
		meta: {
			err: {
				name: "Error",
				message: "spawn srtla_send ENOENT",
				code: "ENOENT",
			},
			attempt: 2,
		},
	}),
	ceralive("streamloop: srtla_send exited (code=1, signal=null)"),
	ceralive("srtla_send: connection group 7f3a9c2e registered"),
	ceralive("cerastream: pipeline state PLAYING"),
	event({
		ts: "2026-11-13T20:34:07.000Z",
		level: "info",
		msg: "stream stopped",
		module: "streaming",
		meta: { state: "stopped" },
	}),
	systemd("ceralive.service: Main process exited, code=killed, status=9/KILL"),
	systemd("ceralive.service: Failed with result 'signal'."),
	systemd("ceralive.service: Scheduled restart job, restart counter is at 1."),
	kernel(
		"Out of memory: Killed process 4321 (ceralive) total-vm:2345678kB, anon-rss:1234567kB, file-rss:0kB, shmem-rss:0kB, UID:0 pgtables:4567kB oom_score_adj:0",
	),
];
