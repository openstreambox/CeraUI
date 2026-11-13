// Synthetic journal-format regression fixtures. Both disclosure and diagnostic
// corpora are exercised together so privacy fixes preserve failure evidence.
const prefix = "2026-11-13T21:04:05+0100 osb-box ";
export const privateLines = [
	[
		'ceralive[1234]: {"msg":"ingest_key=\\nprivate-newline-value"}',
		"private-newline-value",
	],

	[
		'ceralive[1234]: {"level":"warn","msg":"relay: ingest_key=osbkey7f3a9c2e server=relay.example.org"}',
		"osbkey7f3a9c2e",
	],
	[
		'ceralive[1234]: {"level":"warn","msg":"stream key osbkey7f3a9c2e rejected by ingest"}',
		"osbkey7f3a9c2e",
	],
	[
		'ceralive[1234]: {"level":"warn","msg":"relay account: streamer42acct"}',
		"streamer42acct",
	],
	[
		"ceralive[1234]: libsrt: #!::r=osbkey7f3a9c2e,m=publish,u=streamer42acct",
		"osbkey7f3a9c2e",
	],
	[
		"systemd[1]: Started stream.service - /usr/bin/belacoder /etc/pipeline relay.example.org 5000 -s osbkey7f3a9c2e.",
		"osbkey7f3a9c2e",
	],
	[
		"systemd[1]: stream.service: Environment=RELAY_KEY=osbkey7f3a9c2e",
		"osbkey7f3a9c2e",
	],
	[
		"sudo[2001]:     root : PWD=/ ; USER=root ; COMMAND=/usr/libexec/ceralive/helper set-relay streamer42acct osbkey7f3a9c2e",
		"osbkey7f3a9c2e",
	],
	[
		'ceralive[1234]: {"level":"warn","msg":"gps fix 12.345678,-23.456789 hdop 0.8"}',
		"12.345678",
	],
	[
		'ceralive[1234]: {"level":"warn","msg":"gps_lat=12.345678 gps_lon=-23.456789"}',
		"12.345678",
	],
	[
		'ceralive[1234]: {"level":"warn","msg":"sms from (0100) 5550123"}',
		"5550123",
	],
	[
		'ceralive[1234]: {"level":"warn","msg":"sms from 0100/55501234"}',
		"55501234",
	],
	[
		"ModemManager[589]: <info>  [modem0] 3GPP registration info: operator id 00101, cell 1A2D003",
		"1A2D003",
	],
	["ModemManager[589]: <info> ci=1A2D003", "1A2D003"],
	[
		"hostapd[800]: Using key 'hunterWifi22' for ssid OSB-Hotspot",
		"hunterWifi22",
	],
	[
		"ModemManager[589]: <dbg> parsed CEREG: stat 1 ci 01A2D003 act 7",
		"01A2D003",
	],
	['ceralive[1234]: osbkey7f3a9c2e","x":1', "osbkey7f3a9c2e"],
	["ceralive[1234]: sender stderr: 7f3a9c2e&latency=2000 ok", "7f3a9c2e"],
	["audit[2001]: argv=unlabelled-private-value", "unlabelled-private-value"],
	["unfamiliar[1234]: unlabelled-private-value", "unlabelled-private-value"],
].map(([line, secret]) => ({ line: prefix + line, secret: secret as string }));

export const diagnosticLines = [
	[
		"NetworkManager[612]: <info>  [1731528245.1234] device (cdc-wdm0): state change: connecting -> failed (reason 'gsm-registration-denied', sys-iface-state: 'managed')",
		"gsm-registration-denied",
	],
	[
		"NetworkManager[612]: <warn>  [1731528245.1234] modem-broadband[cdc-wdm0]: failed to connect modem: Network timeout",
		"Network timeout",
	],
	[
		"ModemManager[589]: <warn>  [modem0] couldn't load supported modes: Serial command timed out",
		"Serial command timed out",
	],
	[
		"ModemManager[589]: <wrn> [modem0/ttyUSB2/at] port timed out 3 consecutive times",
		"port timed out 3 consecutive times",
	],
	[
		"ModemManager[589]: <warn>  [modem0] modem couldn't be initialized: Couldn't check unlock status: SIM PIN required",
		"SIM PIN required",
	],
	[
		"ModemManager[589]: <wrn> [modem0/bearer1] connection attempt #1 failed: missing-or-unknown-apn",
		"missing-or-unknown-apn",
	],
	[
		"wpa_supplicant[700]: wlan0: CTRL-EVENT-CONNECTED - Connection to 3c:a6:2f:11:22:33 completed",
		"completed",
	],
	[
		"kernel: nvme nvme0: pci function 0000:01:00.0",
		"pci function 0000:01:00.0",
	],
	["kernel: interface tx bytes=123456789 packets=123456789", "bytes=123456789"],
	[
		'ceralive[1234]: {"level":"error","msg":"allocation failed: std::bad_alloc"}',
		"std::bad_alloc",
	],
	[
		"NetworkManager[612]: <info>  [1731528245.1234] dhcp4 (wwan0): address 10.64.12.7",
		"dhcp4 (wwan0): address [address]",
	],
	[
		"NetworkManager[612]: <info>  [1731528245.1234] device (wwan0): ipv6 gateway fe80::1 unreachable",
		"ipv6 gateway [address] unreachable",
	],
	["kernel: usb 1-2: USB disconnect, device number 8", "USB disconnect"],
	["kernel: Under-voltage detected!", "Under-voltage detected"],
	[
		"systemd[1]: ceralive.service: Main process exited, code=exited, status=1/FAILURE",
		"status=1/FAILURE",
	],
	[
		"ceralive[1234]: streamloop: sender exited (code=1, signal=null)",
		"exited (code=1, signal=null)",
	],
].map(([line, evidence]) => ({
	line: prefix + line,
	evidence: evidence as string,
}));
