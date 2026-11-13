// Paired disclosure and diagnostic corpora, built as journal records with the
// trusted fields journald sets. Both run through the production renderer so a
// privacy fix cannot silently remove failure evidence, nor the reverse.
import {
	ceralive,
	child,
	event,
	hostapd,
	type JournalRecord,
	kernel,
	modemManager,
	networkManager,
	systemd,
	wpaSupplicant,
} from "./journal-records.ts";

const warn = (msg: string) => event({ level: "warn", msg });

export const privateRecords: { record: JournalRecord; secret: string }[] = [
	// Free text in the backend's own vocabulary.
	{
		record: warn("ingest_key=\nprivate-newline-value"),
		secret: "private-newline-value",
	},
	{
		record: warn("relay: ingest_key=osbkey7f3a9c2e server=relay.example.org"),
		secret: "osbkey7f3a9c2e",
	},
	{
		record: warn("stream key osbkey7f3a9c2e rejected by ingest"),
		secret: "osbkey7f3a9c2e",
	},
	{ record: warn("relay account: streamer42acct"), secret: "streamer42acct" },
	{ record: warn("stream id live/osbkey7f3a9c2e"), secret: "osbkey7f3a9c2e" },
	{
		record: warn("using passphrase hunter2222hunter"),
		secret: "hunter2222hunter",
	},
	{
		record: warn("connecting to ExampleNet with password hunter2222"),
		secret: "hunter2222",
	},
	{
		record: warn("gps fix 12.345678,-23.456789 hdop 0.8"),
		secret: "12.345678",
	},
	{ record: warn("gps_lat=12.345678 gps_lon=-23.456789"), secret: "12.345678" },
	{ record: warn("sms from (0100) 5550123"), secret: "5550123" },
	{ record: warn("sms from 0100/55501234"), secret: "55501234" },
	{ record: warn("sms received from 0000 1234567"), secret: "1234567" },
	{
		record: warn("$GNGNS,120000,0000.000,N,00000.000,E,AA,12,0.9,0.0,0.0,,*00"),
		secret: "GNGNS",
	},
	{
		record: warn("latitude: 0.000000 longitude: 0.000000"),
		secret: "0.000000",
	},
	{
		record: warn("value = 33 35 31 37 35 36 30 35 31 35 32 33 39 39 39"),
		secret: "33 35 31",
	},
	{ record: warn("35-175605-152399-9"), secret: "175605" },
	{ record: warn("passphrase=hunter2hunter2"), secret: "hunter2hunter2" },
	{ record: warn("streamid=publish:KEYVALUE"), secret: "KEYVALUE" },
	{ record: warn("psk=private-wifi-key"), secret: "private-wifi-key" },
	{
		record: event({
			level: "error",
			msg: "relay login failed",
			meta: {
				err: {
					name: "Error",
					message: "relay rejected login for streamer42acct",
				},
			},
		}),
		secret: "streamer42acct",
	},
	{
		record: event({
			level: "error",
			msg: "operation failed",
			meta: {
				error: {
					name: "Error",
					code: "EACCES",
					message: "relay account: private-error-value",
					stack: "private-stack",
				},
			},
		}),
		secret: "private-error-value",
	},
	{
		record: event({
			level: "warn",
			msg: "probe failed",
			meta: { reason: "connection refused by 203.0.113.7:5000" },
		}),
		secret: "203.0.113.7",
	},
	// Address shapes inside otherwise useful text.
	{ record: warn("probe to 203.0.113.7:5000 failed"), secret: "203.0.113.7" },
	{ record: warn("lease 203.0.113.7: renewing"), secret: "203.0.113.7" },
	{ record: warn("uplink address 203.0.113.7."), secret: "203.0.113.7" },
	{ record: warn("ip4 addr:203.0.113.7 via wwan0"), secret: "203.0.113.7" },
	{
		record: warn("ip6 gw 2001:db8:85a3::1: unreachable"),
		secret: "2001:db8:85a3",
	},
	{ record: warn("uplink 3C-A6-2F-11-22-33 ready"), secret: "3C-A6-2F" },
	{ record: warn("uplink 3ca62f112233 ready"), secret: "3ca62f112233" },
	{ record: warn("uplink 3ca6.2f11.2233 ready"), secret: "3ca6.2f11" },
	{
		record: warn("dhcp client id 01:3c:a6:2f:11:22:33 accepted"),
		secret: ":33",
	},
	// Plain backend stdout, which children share.
	{
		record: ceralive("libsrt: #!::r=osbkey7f3a9c2e,m=publish,u=streamer42acct"),
		secret: "osbkey7f3a9c2e",
	},
	{ record: ceralive('osbkey7f3a9c2e","x":1'), secret: "osbkey7f3a9c2e" },
	{
		record: ceralive("sender stderr: 7f3a9c2e&latency=2000 ok"),
		secret: "7f3a9c2e",
	},
	// systemd command lines and environment.
	{
		record: systemd(
			"Started stream.service - /usr/bin/belacoder /etc/pipeline relay.example.org 5000 -s osbkey7f3a9c2e.",
		),
		secret: "osbkey7f3a9c2e",
	},
	{
		record: systemd("stream.service: Environment=RELAY_KEY=osbkey7f3a9c2e"),
		secret: "osbkey7f3a9c2e",
	},
	// Children and other processes inside admitted units.
	{
		record: child(
			"NetworkManager.service",
			"dnsmasq",
			"dnsmasq-dhcp",
			"DHCPACK(wlan0) 10.42.0.23 3c:a6:2f:11:22:33 example-phone",
		),
		secret: "example-phone",
	},
	{
		record: child(
			"NetworkManager.service",
			"pppd",
			"pppd",
			"local  IP address 100.64.1.2",
		),
		secret: "100.64.1.2",
	},
	{
		record: child(
			"ceralive.service",
			"sudo",
			"sudo",
			"    root : PWD=/ ; USER=root ; COMMAND=/usr/libexec/ceralive/helper set-relay streamer42acct osbkey7f3a9c2e",
		),
		secret: "osbkey7f3a9c2e",
	},
	{
		record: child(
			"ceralive.service",
			"ceralive",
			"audit",
			"argv=unlabelled-private-value",
		),
		secret: "unlabelled-private-value",
	},
	{
		record: child(
			"unfamiliar.service",
			"unfamiliar",
			"unfamiliar",
			"unlabelled-private-value",
		),
		secret: "unlabelled-private-value",
	},
	// ModemManager: identities, traces and debug output.
	{
		record: modemManager(
			"<info>  [modem0] 3GPP registration info: operator id 00101, cell 1A2D003",
		),
		secret: "1A2D003",
	},
	{ record: modemManager("<info>  ci=1A2D003"), secret: "1A2D003" },
	{
		record: modemManager(
			"<dbg> [modem0] parsed CEREG: stat 1 ci 01A2D003 act 7",
		),
		secret: "01A2D003",
	},
	{
		record: modemManager(
			'<debug> [ttyUSB2/at] <-- \'<CR><LF>+CEREG: 2,1,"00AA","0A0B0C0D",7<CR><LF>\'',
		),
		secret: "0A0B0C0D",
	},
	{
		record: modemManager(
			"<info>  [/dev/cdc-wdm0] <<<<<<   value       = 33:35:31:37:35:36:30:35:31:35:32:33:39:39:39",
		),
		secret: "33:35:31",
	},
	{
		record: modemManager(
			"<warn>  [modem0] couldn't load own numbers: +15550100123",
		),
		secret: "15550100123",
	},
	{
		record: modemManager(
			"<info>  [modem0] equipment identifier: 351756051523999",
		),
		secret: "351756051523999",
	},
	// NetworkManager: names, addresses and DHCP options.
	{
		record: networkManager(
			"<info>  [1731528245.1234] device (wlan0): Activation: starting connection 'ExampleHomeNet' (0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0)",
		),
		secret: "ExampleHomeNet",
	},
	{
		record: networkManager(
			"<info>  [1731528245.1234] policy: set 'Alex Example Account' (wwan0) as default for IPv4 routing and DNS",
		),
		secret: "Alex Example",
	},
	{
		record: networkManager(
			"<info>  [1731528245.1234] device (wlan0): Activation: (wifi) access point 'ExampleHomeNet' has security, but secrets are required.",
		),
		secret: "ExampleHomeNet",
	},
	{
		record: networkManager(
			"<info>  [1731528245.1234] dhcp4 (wwan0): state changed new lease, address=203.0.113.7",
		),
		secret: "203.0.113.7",
	},
	{
		record: networkManager(
			"<info>  [1731528245.1234] dhcp4 (eth0): option host_name            => 'example-host'",
		),
		secret: "example-host",
	},
	{
		record: networkManager(
			"<info>  [1731528245.1234] connectivity: (wwan0,IPv4,7) check failed to 203.0.113.7:80",
		),
		secret: "203.0.113.7",
	},
	// Wi-Fi client and hotspot.
	{
		record: wpaSupplicant(
			"wlan0: Trying to associate with 3c:a6:2f:11:22:33 (SSID='ExampleHomeNet' freq=2437 MHz)",
		),
		secret: "ExampleHomeNet",
	},
	{
		record: wpaSupplicant(
			'wlan0: CTRL-EVENT-SSID-TEMP-DISABLED id=0 ssid="ExampleHomeNet" auth_failures=1 duration=10 reason=WRONG_KEY',
		),
		secret: "ExampleHomeNet",
	},
	{
		record: wpaSupplicant(
			"wlan0: CTRL-EVENT-CONNECTED - Connection to 3c:a6:2f:11:22:33 completed [id=0 id_str=]",
		),
		secret: "3c:a6:2f",
	},
	{
		record: hostapd("Using key 'hunterWifi22' for ssid OSB-Hotspot"),
		secret: "hunterWifi22",
	},
	{
		record: hostapd("wlan0: AP-STA-CONNECTED 3c:a6:2f:11:22:33"),
		secret: "3c:a6:2f",
	},
	// Kernel, including text a root process could write to /dev/kmsg.
	{
		record: kernel("usb 1-1.2: SerialNumber: a1b2c3d4e5f6"),
		secret: "a1b2c3d4e5f6",
	},
	{
		record: kernel("usb 1-1.2: SerialNumber: LF6A2B3C4D"),
		secret: "LF6A2B3C4D",
	},
	{
		record: kernel("usb 1-1.2: SerialNumber: 00e04c000001"),
		secret: "00e04c000001",
	},
	{
		record: kernel("brcmfmac: Connecting to SSID ExampleHomeNet"),
		secret: "ExampleHomeNet",
	},
	{
		record: kernel("srtla: relay passcode hunter22 accepted"),
		secret: "hunter22",
	},
	{
		record: kernel(
			"input: Example Person Headphones as /devices/virtual/misc/uhid/0005:004C:0001.0001/input/input5",
		),
		secret: "Example Person",
	},
	{
		record: kernel(
			"qmi_wwan 1-1.2:1.4 wwan0: register 'qmi_wwan' at usb-xhci-hcd.0.auto-1.2, WWAN/QMI device, 3c:a6:2f:11:22:33",
		),
		secret: "3c:a6:2f",
	},
	{ record: kernel("wlx3ca62f112233: authenticated"), secret: "3ca62f112233" },
];

export const diagnosticRecords: { record: JournalRecord; evidence: string }[] =
	[
		// ModemManager.
		{
			record: modemManager(
				"<info>  [modem0] state changed (registered -> connecting)",
			),
			evidence: "state changed (registered -> connecting)",
		},
		{
			record: modemManager(
				"<info>  [modem0] modem state changed, 'enabling' --> 'enabled' (reason: user-requested)",
			),
			evidence: "'enabling' --> 'enabled' (reason: user-requested)",
		},
		{
			record: modemManager(
				"<info>  [modem0] 3GPP registration state changed (searching -> denied)",
			),
			evidence: "(searching -> denied)",
		},
		{
			record: modemManager("<info>  [modem0] signal quality updated (38)"),
			evidence: "signal quality updated (38)",
		},
		{
			record: modemManager(
				"<info>  [modem0] access technology changed (umts -> lte)",
			),
			evidence: "(umts -> lte)",
		},
		{
			record: modemManager(
				"<warn>  [modem0] couldn't load supported modes: Serial command timed out",
			),
			evidence: "Serial command timed out",
		},
		{
			record: modemManager(
				"<wrn> [modem0/ttyUSB2/at] port timed out 3 consecutive times",
			),
			evidence: "port timed out 3 consecutive times",
		},
		{
			record: modemManager(
				"<warn>  [modem0] modem couldn't be initialized: Couldn't check unlock status: SIM PIN required",
			),
			evidence: "SIM PIN required",
		},
		{
			record: modemManager(
				"<wrn> [modem0/bearer1] connection attempt #1 failed: missing-or-unknown-apn",
			),
			evidence: "missing-or-unknown-apn",
		},
		{
			record: modemManager(
				"<info>  [modem0] simple connect state (4/10): wait to get fully enabled",
			),
			evidence: "simple connect state (4/10): wait to get fully enabled",
		},
		// NetworkManager.
		{
			record: networkManager(
				"<info>  [1731528245.1234] device (cdc-wdm0): state change: connecting -> failed (reason 'gsm-registration-denied', sys-iface-state: 'managed')",
			),
			evidence: "gsm-registration-denied",
		},
		{
			record: networkManager(
				"<warn>  [1731528245.1234] modem-broadband[cdc-wdm0]: failed to connect modem: missing-or-unknown-apn",
			),
			evidence: "failed to connect modem: missing-or-unknown-apn",
		},
		{
			record: networkManager(
				"<warn>  [1731528245.1234] device (wlan0): state change: config -> failed (reason 'supplicant-timeout', sys-iface-state: 'managed')",
			),
			evidence: "supplicant-timeout",
		},
		{
			record: networkManager(
				"<info>  [1731528245.1234] device (wlan0): Activation: starting connection 'ExampleHomeNet' (0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0)",
			),
			evidence: "Activation: starting connection '[name]'",
		},
		{
			record: networkManager(
				"<info>  [1731528245.1234] dhcp4 (wwan0): state changed new lease, address=203.0.113.7",
			),
			evidence: "dhcp4 (wwan0): state changed new lease, address=[address]",
		},
		{
			record: networkManager(
				"<info>  [1731528245.1234] manager: NetworkManager state is now CONNECTED_GLOBAL",
			),
			evidence: "CONNECTED_GLOBAL",
		},
		{
			record: networkManager(
				"<info>  [1731528245.1234] connectivity: (wwan0,IPv4,7) check failed to 203.0.113.7:80",
			),
			evidence: "check failed to [address]:80",
		},
		// Wi-Fi client and hotspot.
		{
			record: wpaSupplicant(
				"wlan0: CTRL-EVENT-CONNECTED - Connection to 3c:a6:2f:11:22:33 completed [id=0 id_str=]",
			),
			evidence: "Connection to [address] completed",
		},
		{
			record: wpaSupplicant(
				"wlan0: CTRL-EVENT-DISCONNECTED bssid=3c:a6:2f:11:22:33 reason=4 locally_generated=1",
			),
			evidence: "reason=4",
		},
		{
			record: wpaSupplicant(
				'wlan0: CTRL-EVENT-SSID-TEMP-DISABLED id=0 ssid="ExampleHomeNet" auth_failures=1 duration=10 reason=WRONG_KEY',
			),
			evidence: 'ssid="[name]" auth_failures=1 duration=10 reason=WRONG_KEY',
		},
		{
			record: wpaSupplicant(
				"wlan0: WPA: 4-Way Handshake failed - pre-shared key may be incorrect",
			),
			evidence: "pre-shared key may be incorrect",
		},
		{
			record: hostapd("wlan0: AP-STA-CONNECTED 3c:a6:2f:11:22:33"),
			evidence: "AP-STA-CONNECTED [address]",
		},
		{
			record: hostapd("wlan0: interface state UNINITIALIZED->ENABLED"),
			evidence: "UNINITIALIZED->ENABLED",
		},
		// Kernel.
		{
			record: kernel("usb 1-2: USB disconnect, device number 8"),
			evidence: "USB disconnect, device number 8",
		},
		{
			record: kernel(
				"usb 1-1.2: New USB device found, idVendor=2c7c, idProduct=0800, bcdDevice= 4.14",
			),
			evidence: "idVendor=2c7c, idProduct=0800",
		},
		{
			record: kernel("usb 1-1.2: SerialNumber: a1b2c3d4e5f6"),
			evidence: "SerialNumber: [serial]",
		},
		{
			record: kernel(
				"usb 1-1.2: reset high-speed USB device number 3 using xhci-hcd",
			),
			evidence: "reset high-speed USB device",
		},
		{
			record: kernel("usb usb1-port1: over-current condition"),
			evidence: "over-current condition",
		},
		{
			record: kernel("hwmon hwmon1: Undervoltage detected!"),
			evidence: "Undervoltage detected!",
		},
		{
			record: kernel(
				"Out of memory: Killed process 1234 (ceralive) total-vm:1234567kB, anon-rss:123456kB, file-rss:0kB, shmem-rss:0kB, UID:0 pgtables:1234kB oom_score_adj:0",
			),
			evidence: "Out of memory: Killed process 1234 (ceralive)",
		},
		{
			record: kernel(
				"qmi_wwan 1-1.2:1.4 wwan0: register 'qmi_wwan' at usb-xhci-hcd.0.auto-1.2, WWAN/QMI device, 3c:a6:2f:11:22:33",
			),
			evidence: "register 'qmi_wwan'",
		},
		{
			record: kernel("wlx3ca62f112233: authenticated"),
			evidence: "wlx[address]: authenticated",
		},
		// systemd and the backend.
		{
			record: systemd(
				"ceralive.service: Main process exited, code=exited, status=1/FAILURE",
			),
			evidence: "status=1/FAILURE",
		},
		{
			record: ceralive("streamloop: sender exited (code=1, signal=null)"),
			evidence: "exited (code=1, signal=null)",
		},
		{
			record: event({
				level: "error",
				msg: "allocation failed: std::bad_alloc",
			}),
			evidence: "std::bad_alloc",
		},
		{
			record: warn("probe to 203.0.113.7:5000 failed"),
			evidence: "probe to [address]:5000 failed",
		},
		{
			record: warn("uplink 3C-A6-2F-11-22-33 ready"),
			evidence: "uplink [address] ready",
		},
		{
			record: warn("adapter address aa:bb:cc:dd:ee:ff"),
			evidence: "adapter address [address]",
		},
		{
			record: warn("stream key rejected by ingest"),
			evidence: "stream key rejected by ingest",
		},
	];
