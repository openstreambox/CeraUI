/** Typed line shapes for third-party daemons in the support download.
 *
 * ModemManager, NetworkManager, wpa_supplicant, hostapd and the kernel write
 * free text this project does not control. Only the lines diagnosis needs are
 * recognised, each as a fixed shape, and a recognised line is rebuilt from the
 * shape's literal text plus typed fields. No captured text is copied as
 * written: every field is a member of the producer's own closed vocabulary
 * (generated from its source, `support-daemon-vocabulary.generated.ts`), a
 * bounded number, an interface name by the kernel's naming grammar, or a fixed
 * placeholder such as [name] or [address]. An unknown value becomes its
 * placeholder ([state], [reason], [interface]…); a line that matches no shape
 * is withheld and counted.
 *
 * Shapes cover both daemon generations devices run: Debian bookworm
 * (ModemManager 1.20, NetworkManager 1.42) and trixie (CeraLive's
 * ModemManager 1.24 carry, NetworkManager 1.52). Each shape is taken from a
 * format string the daemon logs at info level or above; debug-only lines never
 * reach the journal and have no shape.
 *
 * Literal shape text outside `{FIELD}` placeholders may only use fixed words,
 * digits and hex digits; a test enforces this.
 */

import {
	DAEMON_VOCABULARY,
	MBIM_PROTOCOL_ERRORS,
	MBIM_STATUS_ERRORS,
	QMI_CALL_END_REASONS,
	QMI_PROTOCOL_ERRORS,
	QMI_VERBOSE_CALL_END_REASONS,
	QMI_VERBOSE_CALL_END_TYPES,
	WLAN_REASONS,
} from "./support-daemon-vocabulary.generated.ts";
import {
	MODEM_COULDNT_HEADS,
	MODEM_ERROR_PHRASES,
} from "./support-reason-vocabulary.generated.ts";

export type ShapeSource =
	| "ModemManager"
	| "NetworkManager"
	| "wpa_supplicant"
	| "hostapd"
	| "kernel";

const V = DAEMON_VOCABULARY;
const set = (...lists: readonly (readonly string[])[]) => new Set(lists.flat());

/** Kernel and NetworkManager interface names: wlan0, wwan0mbim0, cdc-wdm0,
 * ttyUSB2, and systemd's predictable names, which are only letter+digit pairs
 * (enp1s0u1u2, wlP1p1s0, wlx<mac>). A name such as enp1janedoe does not fit.
 */
const STRICT_IF =
	"(?:wwan\\d{1,3}(?:mbim|qmi|at|qcdm|firehose|xmmrpc)\\d{1,3}|(?:wlan|wwan|eth|usb|cdc-wdm|rmnet_data|rmnet_ipa|rmnet|mhi_hwip|mhi_swip|qmimux|ppp|wg|tun|tap|veth|br|bond|ap|uap|mlan|ttyUSB|ttyACM|p2p-dev-wlan|p2p-wlan|docker|tailscale)\\d{1,3}(?:[.-]\\d{1,4})?|lo|(?:en|wl|ww)(?:x[0-9a-fA-F]{12}|(?:[oPpsfdunciv]\\d{1,4}){1,8}))";
const INTERFACE_NAME = new RegExp(`^${STRICT_IF}$`);
/** The interface grammar, exported for the literal-text test. */
export const STRICT_INTERFACE_PATTERN = STRICT_IF;

/** A kernel or modem port interface name, by the kernel naming grammar. */
export function isInterfaceName(value: string): boolean {
	return (
		value.length <= 15 &&
		(/^(?:wl|en|ww)x[0-9a-f]{12}$/i.test(value) ||
			(value.match(/\d/g)?.length ?? 0) <= 6) &&
		INTERFACE_NAME.test(value)
	);
}

const interfaceField = (value: string) =>
	isInterfaceName(value)
		? value.replace(/^(wlx|enx|wwx)[0-9a-f]{12}$/i, "$1[address]")
		: "[interface]";

const member =
	(values: ReadonlySet<string>, placeholder: string) => (value: string) =>
		values.has(value) ? value : placeholder;

/** The nickname for a code in a libqmi table, or undefined. */
function qmiNick(
	table: Readonly<Record<string, readonly string[]>> | undefined,
	code: string | undefined,
	nick: string,
): string | undefined {
	return code !== undefined && table?.[code]?.includes(nick) ? nick : undefined;
}

// Processes whose names a helper needs; any other process is [process].
export const KNOWN_PROCESSES: ReadonlySet<string> = new Set([
	"ceralive",
	"srtla_send",
	"srtla_rec",
	"ceracoder",
	"belacoder",
	"cerastream",
	"srt-live-transm",
	"gst-launch-1.0",
	"ffmpeg",
	"bun",
	"node",
	"ModemManager",
	"NetworkManager",
	"wpa_supplicant",
	"hostapd",
	"dnsmasq",
	"systemd",
	"systemd-journal",
	"systemd-udevd",
	"kworker",
	"qmi-proxy",
	"mbim-proxy",
	"cog",
	"cage",
	"bluetoothd",
]);

// Kernel strings from fixed tables. USB speeds (usb_speed_string and the
// SuperSpeed variants in hub.c), host controller and usbnet driver names.
const USB_SPEEDS = new Set([
	"low-speed",
	"full-speed",
	"high-speed",
	"wireless",
	"super-speed",
	"super-speed-plus",
	"SuperSpeed",
	"SuperSpeed Plus",
	"SuperSpeed Plus Gen 2x1",
	"SuperSpeed Plus Gen 1x2",
	"SuperSpeed Plus Gen 2x2",
	"SuperSpeed Gen 1x2",
	"UNKNOWN",
]);
const USB_HOST_DRIVERS = new Set([
	"xhci-hcd",
	"xhci_hcd",
	"ehci-platform",
	"ehci-pci",
	"ehci_hcd",
	"ohci-platform",
	"ohci-pci",
	"ohci_hcd",
	"uhci_hcd",
	"dwc2",
	"musb-hdrc",
	"ci_hdrc",
]);
const USBNET_DRIVERS = new Set([
	"qmi_wwan",
	"cdc_mbim",
	"cdc_ether",
	"cdc_ncm",
	"rndis_host",
	"huawei_cdc_ncm",
	"sierra_net",
]);
const USBNET_DESCRIPTIONS = new Set([
	"WWAN/QMI device",
	"WWAN/QMI device (raw-ip)",
	"CDC Ethernet Device",
	"CDC NCM",
	"CDC NCM (NO ZLP)",
	"CDC NCM (SEND ZLP)",
	"CDC MBIM",
	"Mobile Broadband Network Device",
	"RNDIS device",
	"Huawei CDC NCM device",
	"Sierra Wireless USB-to-WWAN Modem",
]);
const USB_BUS =
	/^usb-(?:(?:xhci-hcd|ehci-platform|ohci-platform|dwc2|musb-hdrc)(?:\.\d{1,3})?(?:\.auto)?|[0-9a-f]{4,8}\.usb|[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.\d)-\d{1,2}(?:\.\d{1,2}){0,5}$/;

const CALL_END_NICKS = set(...Object.values(QMI_CALL_END_REASONS));
const VERBOSE_REASON_NICKS = set(
	...Object.values(QMI_VERBOSE_CALL_END_REASONS).flatMap((table) =>
		Object.values(table),
	),
);
const MM_DBUS_ERRORS = set(V.mmDbusErrors);

interface FieldType {
	readonly pattern: string;
	/** The export text; null withholds the whole line. `previous` holds the
	 * raw values of the fields before this one in the same line. */
	readonly render: (
		value: string,
		previous: readonly string[],
	) => string | null;
}

const constant = (pattern: string, text: string): FieldType => ({
	pattern,
	render: () => text,
});
const kept = (pattern: string): FieldType => ({ pattern, render: (v) => v });
const word = "[A-Za-z0-9_+-]{1,48}";
const enumField = (
	values: readonly string[],
	placeholder: string,
	pattern = word,
): FieldType => ({ pattern, render: member(set(values), placeholder) });

const FIELDS: Record<string, FieldType> = {
	// Typed values.
	NUM: kept("-?\\d{1,6}"),
	SIGNAL: kept("-?\\d{1,3}"),
	USBPATH: kept("\\d{1,2}-\\d{1,2}(?:\\.\\d{1,2}){0,5}(?::\\d\\.\\d{1,2})?"),
	IF: { pattern: "[A-Za-z0-9_.@-]{1,24}", render: interfaceField },
	// Fixed placeholders: the value is never copied.
	MAC: constant("[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}", "[address]"),
	IP: constant("[0-9a-fA-F][0-9a-fA-F.:]{1,44}", "[address]"),
	SQNAME: constant("[^'\\n]{0,64}", "[name]"),
	DQNAME: constant('[^"\\n]{0,64}', "[name]"),
	NAME: constant("[^\\n]{1,64}", "[name]"),
	UUID: constant(
		"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
		"[id]",
	),
	SERIAL: constant("[^\\s]{1,64}", "[serial]"),
	OPID: constant("[0-9A-Za-z]{0,8}", "[id]"),
	TAIL: constant(".{0,4000}", ""),
	KEYID: constant("(?: keyid=[^\\n]{0,64})?", ""),
	// ModemManager.
	MMSTATE: enumField(V.mmModemStates, "[state]"),
	MMREG: enumField(V.mmRegistrationStates, "[state]"),
	MMPKT: enumField(V.mmPacketServiceStates, "[state]"),
	MMLOCK: enumField(V.mmModemLocks, "[lock]"),
	MMNETERR: enumField(V.mmNetworkErrors, "[reason]"),
	MMPLUGIN: enumField(V.mmPlugins, "[plugin]", "[A-Za-z0-9 _-]{1,32}"),
	MMSTEP: enumField(V.mmConnectSteps, "[step]", "[a-z ]{1,60}"),
	ACCESS: {
		pattern: "[a-z0-9, -]{1,120}",
		render: (value) =>
			value
				.split(", ")
				.map((tech) =>
					V.mmAccessTechnologies.includes(tech as never) ? tech : "[value]",
				)
				.join(", "),
	},
	// Error text from the daemon; reduced to ModemManager's own vocabulary.
	REASON: { pattern: "[^\\n]{1,300}", render: (v) => boundedModemReason(v) },
	// The action after ModemManager's "couldn't"; must be one of its own.
	COULDNT: {
		pattern: "[a-z0-9 '-]{3,60}?",
		render: (value) => (COULDNT.has(value) ? value : null),
	},
	// libqmi nicknames, valid only as the table entry for the preceding code.
	CALLEND: {
		pattern: "[A-Za-z0-9_-]{1,64}|\\(null\\)",
		render: (value, previous) =>
			value === "(null)"
				? value
				: (qmiNick(QMI_CALL_END_REASONS, previous.at(-1), value) ?? "[reason]"),
	},
	VERBOSE: {
		pattern: "\\[[^\\]\\n]{0,48}\\] (?:[A-Za-z0-9_-]{1,64}|\\(null\\))",
		render: (value, previous) => {
			const [type, reason] = previous.slice(-2);
			const match = /^\[([^\]]*)\] (.*)$/.exec(value);
			const typeNick = qmiNick(
				QMI_VERBOSE_CALL_END_TYPES,
				type,
				match?.[1] ?? "",
			);
			if (!typeNick || !match?.[2]) return "[reason]";
			const reasonNick =
				match[2] === "(null)"
					? "(null)"
					: qmiNick(QMI_VERBOSE_CALL_END_REASONS[type ?? ""], reason, match[2]);
			return reasonNick
				? `[${typeNick}] ${reasonNick}`
				: `[${typeNick}] [reason]`;
		},
	},
	// NetworkManager.
	NMDEV: enumField(V.nmDeviceStates, "[state]"),
	NMREASON: enumField(V.nmDeviceReasons, "[reason]"),
	NMMANAGED: enumField(V.nmManagedTypes, "[type]"),
	NMSUPP: enumField(V.nmSupplicantStates, "[state]"),
	NMGLOBAL: enumField(V.nmStates, "[state]"),
	NMCONN: enumField(V.nmConnectivityStates, "[state]"),
	NMTYPE: enumField(V.nmDeviceTypes, "[type]", "[A-Za-z0-9 .-]{1,40}"),
	VERSION: {
		pattern: "[0-9A-Za-z.+~-]{1,32}",
		render: (value) =>
			/^\d{1,2}\.\d{1,3}(?:\.\d{1,3})?(?:-\d{1,4}(?:\.\d{1,4})?)?$/.test(value)
				? value
				: "[version]",
	},
	// wpa_supplicant and hostapd.
	WPATEMP: enumField(V.wpaTempDisabledReasons, "[reason]"),
	CIPHER: enumField(V.wpaCiphers, "[cipher]"),
	REGINIT: enumField(V.wpaRegInitiators, "[value]"),
	REGTYPE: enumField(V.wpaRegTypes, "[value]"),
	ALPHA2: kept("[A-Z0-9]{2}"),
	APSTATE: enumField(V.hostapdStates, "[state]"),
	// Kernel.
	KVER: {
		pattern: "[0-9][0-9A-Za-z.+_~-]{0,48}",
		render: (value) => {
			const parts = /^(\d{1,2}\.\d{1,3}(?:\.\d{1,3})?)(-\d{1,4})?(.*)$/.exec(
				value,
			);
			if (!parts?.[1]) return "[release]";
			return `${parts[1]}${parts[2] ?? ""}${parts[3] ? "-[release]" : ""}`;
		},
	},
	USBSPEED: enumField([...USB_SPEEDS], "[speed]", "[A-Za-z0-9 -]{3,40}"),
	HCD: enumField([...USB_HOST_DRIVERS], "[driver]", "[a-z][a-z0-9_-]{1,23}"),
	USBNET: enumField([...USBNET_DRIVERS], "[driver]", "[a-z][a-z0-9_]{1,23}"),
	USBDESC: enumField(
		[...USBNET_DESCRIPTIONS],
		"[description]",
		"[^,\\n]{1,48}",
	),
	USBBUS: {
		pattern: "[A-Za-z0-9_.:-]{1,64}",
		render: (value) => (USB_BUS.test(value) ? value : "[bus]"),
	},
	PROCESS: {
		pattern: "[^()\\n]{1,16}",
		render: (value) => (KNOWN_PROCESSES.has(value) ? value : "[process]"),
	},
	WLANREASON: {
		pattern: "\\d{1,3}=[A-Za-z0-9_]{1,48}",
		render: (value) => {
			const [code, name] = value.split("=");
			return WLAN_REASONS[code ?? ""]?.includes(name ?? "")
				? value
				: `${code}=[reason]`;
		},
	},
	LINK: {
		pattern: "(?: - [^\\n]{0,60})?",
		render: (value) =>
			/^ - (?:\d{1,3}(?:\.\d)?(?:Mbps|Gbps)|Unknown)\/(?:Full|Half|Unknown)(?: - flow control (?:off|rx|tx|rx\/tx))?$/.test(
				value,
			)
				? value
				: "",
	},
};

function compile(source: string): { regex: RegExp; fields: FieldType[] } {
	const fields: FieldType[] = [];
	const pattern = source.replace(/\{([A-Z][A-Z0-9]*)\}/g, (_, key: string) => {
		const field = FIELDS[key];
		if (!field) throw new Error(`unknown line-shape field ${key}`);
		fields.push(field);
		return `(?<f${fields.length}>${field.pattern})`;
	});
	return { regex: new RegExp(`^${pattern}$`, "d"), fields };
}

// ModemManager writes `<level> [object] text` to syslog: 1.20 uses <info>,
// <warn>, <error>; 1.24 uses <inf>, <msg>, <wrn>, <err>. With --log-journal it
// writes no level text. Debug (<debug>, <dbg>) is never admitted.
const MM = String.raw`(?:<(?:info|inf|msg|warn|wrn|err|error)>\s{1,3})?`;
// Log objects: [modem0], [modem0/bearer1], [modem0/ttyUSB2/at].
const MM_OBJ = String.raw`\[modem\d{1,3}(?:/(?:bearer|sim|call|sms)\d{1,4}|/{IF}(?:/(?:at|qmi|mbim|qcdm|gps|net|audio|xmmrpc|qrtr|ignored))?)?\] `;
// NetworkManager's `[epoch.fraction]` prefix is removed before matching.
const NM = String.raw`<(?:info|warn|error)>\s{1,3}`;

// wpa_supplicant and hostapd share the AP code: `AP-ENABLED ` keeps its
// trailing space, AP-STA-CONNECTED may carry ip_addr= and keyid= (dropped).
const AP_SHAPES = [
	`{IF}: interface state {APSTATE}->{APSTATE}`,
	`{IF}: AP-(?:ENABLED|DISABLED) ?`,
	`{IF}: AP-STA-(?:CONNECTED|DISCONNECTED|POSSIBLE-PSK-MISMATCH) {MAC}(?: ip_addr={IP})?{KEYID}`,
];

const SHAPES: Record<ShapeSource, readonly string[]> = {
	ModemManager: [
		String.raw`${MM}ModemManager \(version \d{1,3}(?:\.\d{1,3}){1,3}\) starting in system bus\.\.\.`,
		String.raw`${MM}${MM_OBJ}(?:modem )?state changed \({MMSTATE} -> {MMSTATE}\)`,
		String.raw`${MM}${MM_OBJ}(?:3GPP |EPS |5GS |CS |PS )?registration state changed \({MMREG} -> {MMREG}\)`,
		String.raw`${MM}${MM_OBJ}3GPP packet service state changed \({MMPKT} -> {MMPKT}\)`,
		String.raw`${MM}${MM_OBJ}access technology changed \({ACCESS} -> {ACCESS}\)`,
		String.raw`${MM}${MM_OBJ}signal quality updated \({NUM}\)`,
		`${MM}${MM_OBJ}power state updated: (?:on|off|low|unknown)`,
		`${MM}${MM_OBJ}set power state '(?:on|off|low)'`,
		`${MM}${MM_OBJ}failed setting power state '(?:on|off|low)': {REASON}`,
		`${MM}${MM_OBJ}consolidated registration state: cs '{MMREG}', ps '{MMREG}', eps '{MMREG}', 5gs '{MMREG}' --> '{MMREG}'`,
		String.raw`${MM}${MM_OBJ}Network rejection received: reason '{MMNETERR}' \({NUM}\), operator id '{OPID}', operator name '{SQNAME}', access technology '{ACCESS}'`,
		String.raw`${MM}${MM_OBJ}simple connect started\.\.\.`,
		String.raw`${MM}${MM_OBJ}simple connect state \({NUM}/{NUM}\): {MMSTEP}`,
		`${MM}${MM_OBJ}(?:port '?{IF}'? )?(?:port )?timed out {NUM} consecutive times(?:, marking modem as invalid)?`,
		String.raw`${MM}${MM_OBJ}connection #{NUM} finished: duration [0-9:s]{1,16}(?:, tx: \d{1,12} bytes, rx: \d{1,12} bytes)?`,
		String.raw`${MM}${MM_OBJ}(?:couldn't {COULDNT}|couldn't start IPv[46] network|connection attempt #\d{1,3} failed|modem couldn't be initialized|data connection attempt failed|synchronizing all bearer status failed|failed sending SIM PIN|failed enabling modem|registration in network failed|packet service attach in 3GPP network failed|failed waiting for enabled state)(?:: {REASON})?`,
		// 1.24 warnings and QMI call-end reasons that name a carrier's refusal.
		`${MM}${MM_OBJ}modem is locked with '{MMLOCK}'`,
		String.raw`${MM}${MM_OBJ}\s{0,2}call end reason \({NUM}\): {CALLEND}`,
		String.raw`${MM}${MM_OBJ}verbose call end reason \({NUM},{NUM}\): {VERBOSE}`,
		String.raw`${MM}${MM_OBJ}(?:received critical sim error: SIM might be permanently blocked, reprobing\.\.\.|Received critical sim error\. SIM might be permanently blocked\. Reprobing\.\.\.)`,
		String.raw`${MM}\[device {TAIL}\] creating modem with plugin '{MMPLUGIN}' and '{NUM}' ports(?: \([0-9a-f]{4}(?::[0-9a-f]{4}){1,2}\))? ?`,
		String.raw`${MM}\[base-manager\] modem for device '{TAIL}' successfully created`,
	],
	NetworkManager: [
		String.raw`${NM}NetworkManager \(version {VERSION}\) is starting\.\.\.(?: \({TAIL}\))?`,
		`${NM}manager: NetworkManager state is now {NMGLOBAL}`,
		String.raw`${NM}device \({IF}\): state change: {NMDEV} -> {NMDEV} \(reason '{NMREASON}', (?:sys-iface-state|managed-type): '{NMMANAGED}'(?:, missing firmware)?\)`,
		String.raw`${NM}device \({IF}\): Activation: starting connection '{SQNAME}' \({UUID}\)`,
		String.raw`${NM}device \({IF}\): Activation: (?:\((?:ethernet|wifi)\) )?Stage 2 of 5 \(Device Configure\) successful\.`,
		String.raw`${NM}device \({IF}\): Activation: \(wifi\) Stage 2 of 5 \(Device Configure\) successful\. (?:Connected to wireless network|Started Wi-Fi Hotspot) "{DQNAME}"(?: \(hidden\))?`,
		String.raw`${NM}device \({IF}\): link timed out\.`,
		String.raw`${NM}device \({IF}\): Activation: Stage [1-5] of 5 \((?:Device Prepare|Device Configure|IP Configure Start|IP Configure Timeout|IP Check)\) (?:scheduled\.\.\.|started\.\.\.|complete\.|successful\.)`,
		String.raw`${NM}device \({IF}\): Activation: successful, device activated\.`,
		String.raw`${NM}device \({IF}\): Activation: failed for connection '{SQNAME}'`,
		String.raw`${NM}device \({IF}\): Activation: (?:\((?:wifi|ethernet)\) )?(?:access point|connection) '{SQNAME}' has security, but secrets are required\.`,
		String.raw`${NM}device \({IF}\): Activation: \(wifi\) (?:asking for new secrets|disconnected during association, asking for new key)`,
		String.raw`${NM}device \({IF}\): Activation: \((?:wifi|ethernet|macsec)\) association took too long(?:, failing activation|\.)?`,
		String.raw`${NM}device \({IF}\): supplicant interface state: {NMSUPP} -> {NMSUPP}(?: \(simulated signal\))?`,
		String.raw`${NM}device \({IF}\): carrier: link connected`,
		String.raw`${NM}modem-broadband\[{IF}\]: failed to connect modem: {REASON}`,
		String.raw`${NM}modem-broadband\[{IF}\]: failed to connect '{SQNAME}': (?:APN not found: {REASON}|not a mobile broadband modem|unable to determine the network id)`,
		String.raw`${NM}modem\["{IF}"\]: cannot enable/disable modem: locked`,
		`${NM}policy: connection '{SQNAME}' auto-activation failed: {REASON}`,
		String.raw`${NM}policy: set '{SQNAME}' \({IF}\) as default for IPv[46] routing and DNS`,
		String.raw`${NM}dhcp[46] \({IF}\): state changed (?:new|no) lease(?:, address={IP})?(?:, acd pending|, acd conflict)?`,
		String.raw`${NM}dhcp[46] \({IF}\): activation: beginning transaction \(timeout in {NUM} seconds\)`,
		String.raw`${NM}connectivity: \({IF}(?:,IPv[46])?(?:,\d{1,6})?\) (?:timed out|is now {NMCONN}|check failed to {IP}:\d{1,5})`,
		String.raw`${NM}manager: \({IF}\): new {NMTYPE} device \(/org/freedesktop/NetworkManager/Devices/\d{1,6}\)`,
	],
	wpa_supplicant: [
		`{IF}: CTRL-EVENT-(?:BEACON-LOSS|NETWORK-NOT-FOUND)`,
		String.raw`{IF}: CTRL-EVENT-CONNECTED - Connection to {MAC} completed(?: \[id=\d{1,4} id_str={TAIL}\])?`,
		`{IF}: CTRL-EVENT-DISCONNECTED bssid={MAC} reason={NUM}(?: locally_generated=1)?`,
		String.raw`{IF}: CTRL-EVENT-SSID-TEMP-DISABLED id=\d{1,4} ssid="{DQNAME}" auth_failures=\d{1,4} duration=\d{1,6} reason={WPATEMP}`,
		String.raw`{IF}: CTRL-EVENT-SSID-REENABLED id=\d{1,4} ssid="{DQNAME}"`,
		`{IF}: CTRL-EVENT-ASSOC-REJECT bssid={MAC} status_code={NUM}`,
		String.raw`{IF}: CTRL-EVENT-SCAN-FAILED ret={NUM}(?: retry=\d)?`,
		`{IF}: CTRL-EVENT-REGDOM-CHANGE init={REGINIT} type={REGTYPE}(?: alpha2={ALPHA2})?`,
		`{IF}: CTRL-EVENT-SIGNAL-CHANGE above=[01] signal={SIGNAL} noise={SIGNAL} txrate={NUM}`,
		String.raw`{IF}: (?:SME: )?Trying to (?:associate|authenticate) with {MAC} \(SSID='{SQNAME}' freq=\d{4} MHz\)`,
		`{IF}: Associated with {MAC}`,
		String.raw`{IF}: Authentication with {MAC} timed out\.`,
		String.raw`{IF}: WPA: Key negotiation completed with {MAC} \[PTK={CIPHER} GTK={CIPHER}\]`,
		`{IF}: WPA: 4-Way Handshake failed - pre-shared key may be incorrect`,
		// Hotspot: NetworkManager runs the access point through wpa_supplicant.
		...AP_SHAPES,
	],
	hostapd: [
		...AP_SHAPES,
		String.raw`{IF}: STA {MAC} IEEE 802\.11: (?:associated|disassociated|deauthenticated due to (?:inactivity \(timer DEAUTH/REMOVE\)|local deauth request|session timeout))`,
		String.raw`{IF}: STA {MAC} WPA: pairwise key handshake completed \((?:RSN|WPA)\)`,
	],
	kernel: [
		String.raw`{IF}: (?:deauthenticated|disassociated) from {MAC} \(Reason: {WLANREASON}\)`,
		`{IF}: Connection to AP {MAC} lost`,
		`Linux version {KVER}{TAIL}`,
		String.raw`usb {USBPATH}: USB disconnect, device number \d{1,4}`,
		String.raw`usb {USBPATH}: (?:new|reset) {USBSPEED} USB device number \d{1,4} using {HCD}`,
		String.raw`usb {USBPATH}: New USB device found, idVendor=[0-9a-f]{4}, idProduct=[0-9a-f]{4}(?:, bcdDevice=\s?[0-9a-f.]{1,6})?`,
		String.raw`usb {USBPATH}: New USB device strings: Mfr=\d{1,3}, Product=\d{1,3}, SerialNumber=\d{1,3}`,
		`usb {USBPATH}: (?:Product|Manufacturer): {NAME}`,
		`usb {USBPATH}: SerialNumber: {SERIAL}`,
		String.raw`usb {USBPATH}: (?:device descriptor read/(?:64|all), error -\d{1,4}|device not accepting address \d{1,4}, error -\d{1,4}|unable to enumerate USB device)`,
		String.raw`(?:usb|hub) (?:{USBPATH}(?:-port\d{1,2})?|usb\d{1,2}-port\d{1,2}): (?:[Oo]ver-current (?:condition|change)(?: on port \d{1,3})?|attempt power cycle|unable to enumerate USB device|Cannot enable\. Maybe the USB cable is bad\?|disabled by hub \(EMI\?\), re-enabling\.\.\.)`,
		String.raw`usb {USBPATH}: GSM modem \(1-port\) converter (?:now attached to|now disconnected from) ttyUSB\d{1,2}`,
		String.raw`option {USBPATH}: GSM modem \(1-port\) converter detected`,
		String.raw`option\d{1,2} ttyUSB\d{1,2}: GSM modem \(1-port\) converter now disconnected from ttyUSB\d{1,2}`,
		`{USBNET} {USBPATH} {IF}: register '{USBNET}' at {USBBUS}, {USBDESC}, {MAC}`,
		`{USBNET} {USBPATH} {IF}: (?:renamed from {IF}|unregister '{USBNET}' {USBBUS}, {USBDESC})`,
		String.raw`(?:xhci_hcd|xhci-hcd) (?:[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.\d|xhci-hcd\.\d{1,2}\.auto): (?:xHCI host controller not responding, assume dead|HC died; cleaning up|Host halt failed, -?\d{1,4}|USB bus \d{1,3} deregistered)`,
		String.raw`(?:hwmon hwmon\d{1,2}: )?Under-?voltage detected!?(?: \(0x[0-9a-f]{8}\))?`,
		String.raw`(?:hwmon hwmon\d{1,2}: )?Voltage normali[sz]ed(?: \(0x[0-9a-f]{8}\))?`,
		String.raw`Out of memory: Killed process \d{1,7} \({PROCESS}\){TAIL}`,
		`{PROCESS} invoked oom-killer: {TAIL}`,
		String.raw`thermal thermal_zone\d{1,2}: critical temperature reached \(\d{1,3} C\), shutting down`,
		String.raw`CPU\d{1,3}: (?:Core|Package) temperature (?:above threshold, cpu clock throttled|\/speed normal)(?: \(total events = \d{1,7}\))?`,
		String.raw`IPv6: ADDRCONF\(NETDEV_(?:UP|CHANGE)\): {IF}: link (?:is not ready|becomes ready)`,
		String.raw`{IF}: (?:authenticated|associated|deauthenticating from {MAC} by local choice \(Reason: {WLANREASON}\)|authenticate with {MAC}|send auth to {MAC} \(try \d/\d\)|associate with {MAC} \(try \d/\d\)|disconnect from AP {MAC} for new auth to {MAC}|Link is (?:Up|Down){LINK})`,
	],
};

/** Shape sources, exported so a test can check the literal-text rule. */
export const LINE_SHAPE_SOURCES: Readonly<
	Record<ShapeSource, readonly string[]>
> = SHAPES;

const COMPILED: Record<ShapeSource, readonly ReturnType<typeof compile>[]> = {
	ModemManager: SHAPES.ModemManager.map(compile),
	NetworkManager: SHAPES.NetworkManager.map(compile),
	wpa_supplicant: SHAPES.wpa_supplicant.map(compile),
	hostapd: SHAPES.hostapd.map(compile),
	kernel: SHAPES.kernel.map(compile),
};

const PHRASES = new Set([
	...MODEM_ERROR_PHRASES,
	"QMI protocol error",
	"QMI core error",
	"MBIM status error",
	"MBIM protocol error",
	"MBIM core error",
	// NetworkManager's own text for a modem that gave no IP configuration.
	"invalid bearer IP configuration",
	// ModemManager's modem state names, which some waits report as the error.
	...V.mmModemStates,
]);
const COULDNT = new Set(MODEM_COULDNT_HEADS);
const QMI_ERROR = /^QMI protocol error \((\d{1,5})\): '([^'\n]{0,64})'/;
const DBUS_ERROR =
	/^(?:GDBus\.Error:)?(org\.freedesktop\.ModemManager1\.Error\.\S{1,80})$/;

/** Keep leading segments that are ModemManager's own phrases (or a libqmi or
 * D-Bus name valid for its code); the first other segment and everything
 * after it become [reason].
 */
export function boundedModemReason(value: string): string {
	const out: string[] = [];
	let rest = value.trim();
	while (rest) {
		const unhandled =
			/^Unhandled (?:QMI (?:protocol|core)|MBIM (?:status|protocol|core)) error \(\d{1,5}\)/.exec(
				rest,
			);
		const mbim =
			/^MBIM (status|protocol) error \((\d{1,5})\): '([^'\n]{0,64})'/.exec(
				rest,
			);
		if (unhandled) {
			out.push(unhandled[0]);
			rest = rest.slice(unhandled[0].length);
			if (!rest) break;
			if (!rest.startsWith(": ")) {
				out.push("[reason]");
				break;
			}
			rest = rest.slice(2);
			continue;
		}
		if (mbim) {
			const nick = qmiNick(
				mbim[1] === "status" ? MBIM_STATUS_ERRORS : MBIM_PROTOCOL_ERRORS,
				mbim[2],
				mbim[3] ?? "",
			);
			out.push(nick ? mbim[0] : `MBIM ${mbim[1]} error (${mbim[2]}): [reason]`);
			if (!nick) break;
			rest = rest.slice(mbim[0].length);
			if (!rest) break;
			if (!rest.startsWith(": ")) {
				out.push("[reason]");
				break;
			}
			rest = rest.slice(2);
			continue;
		}
		const qmi = QMI_ERROR.exec(rest);
		if (qmi) {
			const nick = qmiNick(QMI_PROTOCOL_ERRORS, qmi[1], qmi[2] ?? "");
			if (!nick) {
				out.push(`QMI protocol error (${qmi[1]}): [reason]`);
				break;
			}
			out.push(qmi[0]);
			rest = rest.slice(qmi[0].length);
		} else {
			const cut = rest.indexOf(": ");
			const segment = cut < 0 ? rest : rest.slice(0, cut);
			const dbus = DBUS_ERROR.exec(segment)?.[1];
			const known =
				// "Call failed: <libqmi call-end nickname>".
				(out.at(-1) === "Call failed" && CALL_END_NICKS.has(segment)) ||
				// A verbose 3GPP call-end nickname prefixed to the error.
				VERBOSE_REASON_NICKS.has(segment) ||
				(out.at(-1) === "MBIM status error" &&
					Object.values(MBIM_STATUS_ERRORS).some((nicks) =>
						nicks.includes(segment),
					)) ||
				(out.at(-1) === "MBIM protocol error" &&
					Object.values(MBIM_PROTOCOL_ERRORS).some((nicks) =>
						nicks.includes(segment),
					)) ||
				PHRASES.has(segment) ||
				PHRASES.has(segment.replace(/\.$/, "")) ||
				(dbus !== undefined && MM_DBUS_ERRORS.has(dbus));
			if (!known) {
				out.push("[reason]");
				break;
			}
			out.push(segment);
			rest = rest.slice(segment.length);
		}
		if (!rest) break;
		if (!rest.startsWith(": ")) {
			out.push("[reason]");
			break;
		}
		rest = rest.slice(2);
	}
	return out.join(": ");
}

export function isShapeSource(source: string): source is ShapeSource {
	return Object.hasOwn(SHAPES, source);
}

/** Render a third-party line through its typed shape, or undefined. */
export function matchLineShape(
	source: ShapeSource,
	message: string,
): string | undefined {
	const text =
		source === "NetworkManager"
			? message.replace(
					/^(<[a-z]{3,5}>\s{1,3})\[\d{10}\.\d{1,6}\]\s{1,3}/,
					"$1",
				)
			: message;
	for (const { regex, fields } of COMPILED[source]) {
		const match = regex.exec(text);
		if (!match) continue;
		const spans: [start: number, end: number, value: string][] = [];
		const previous: string[] = [];
		for (const [index, field] of fields.entries()) {
			const span = match.indices?.groups?.[`f${index + 1}`];
			if (!span) continue;
			const raw = text.slice(span[0], span[1]);
			const value = field.render(raw, previous);
			if (value === null) return undefined;
			previous.push(raw);
			spans.push([span[0], span[1], value]);
		}
		let out = text;
		for (const [start, end, value] of spans.sort((a, b) => b[0] - a[0]))
			out = out.slice(0, start) + value + out.slice(end);
		return out.trimEnd();
	}
	return undefined;
}
