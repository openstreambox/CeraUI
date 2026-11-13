/** Allowlisted line shapes for third-party daemons in the support download.
 *
 * ModemManager, NetworkManager, wpa_supplicant, hostapd and the kernel write
 * free text this project does not control. Instead of guessing what might be
 * private in it, only the lines diagnosis needs are admitted, each as a fixed
 * shape. A line that matches no shape is withheld and counted: an unknown line
 * costs diagnosis, never privacy. Admitted lines still pass the content filters.
 *
 * Shapes cover both daemon generations devices run: Debian bookworm
 * (ModemManager 1.20, NetworkManager 1.42) and trixie (CeraLive's
 * ModemManager 1.24 carry, NetworkManager 1.52). Each shape is taken from a
 * format string the daemon logs at info level or above; debug-only lines never
 * reach the journal and have no shape.
 *
 * Placeholders expand to named capture groups. A group's name prefix decides
 * what reaches the export: `addr` becomes [address], `name` becomes [name],
 * `serial` becomes [serial], `id` becomes [id], `drop` is removed, `if` keeps an
 * interface name with any embedded MAC masked, `reason` keeps only ModemManager's
 * own error phrases (anything else becomes [reason]), `head` must be one of
 * ModemManager's own "couldn't …" actions or the line is withheld, and every
 * other group is kept as written.
 */

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

const PLACEHOLDERS: Record<string, [prefix: string, pattern: string]> = {
	// Kernel and NetworkManager interface names only, so a device or modem
	// named after a person never fits: wlan0, wwan0mbim0, enp1s0, wlx<mac>,
	// cdc-wdm0, p2p-dev-wlan0, ttyUSB2 (a modem's control port).
	IF: [
		"if",
		"(?:wwan\\d{1,3}(?:mbim|qmi|at|qcdm|firehose|xmmrpc)\\d{1,3}|(?:wlan|wwan|eth|usb|cdc-wdm|rmnet_data|rmnet_ipa|rmnet|mhi_hwip|mhi_swip|qmimux|ppp|wg|tun|tap|veth|br|bond|lo|ap|uap|mlan|ttyUSB|ttyACM|p2p-dev-wlan|p2p-wlan)\\d{0,4}(?:[.-]\\d{1,4})?|(?:en|wl|ww)(?:x[0-9a-fA-F]{12}|[pPsod]\\d[0-9a-z]{0,10}|c\\d{1,3})|docker\\d{1,3}|tailscale\\d{1,3})",
	],
	MAC: ["addr", "[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}"],
	IP: ["addr", "[0-9a-fA-F][0-9a-fA-F.:]{1,44}"],
	SQNAME: ["name", "[^'\\n]{0,64}"],
	DQNAME: ["name", '[^"\\n]{0,64}'],
	UUID: ["id", "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"],
	SERIAL: ["serial", "[^\\s]{1,64}"],
	// Error text from the daemon; reduced to ModemManager's own phrases.
	REASON: ["reason", "[^\\n]{1,300}"],
	// The action after ModemManager's "couldn't"; must be one of its own.
	COULDNT: ["head", "[a-z0-9 '-]{3,60}?"],
	OPID: ["id", "[0-9A-Za-z]{0,8}"],
	STATE: ["state", "[a-zA-Z_-]{2,32}"],
	NUM: ["num", "-?\\d{1,6}"],
	USBPATH: ["usb", "\\d{1,2}-[\\d.]{1,16}(?::\\d\\.\\d{1,2})?"],
	DRIVER: ["driver", "[a-z][a-z0-9_-]{1,23}"],
	TAIL: ["drop", ".{0,4000}"],
	// A libqmi enum nickname, such as generic-unspecified or option-unsubscribed.
	NICK: ["nick", "[a-z0-9]+(?:-[a-z0-9]+){0,7}"],
	KEYID: ["drop", "(?: keyid=[^\\n]{0,64})?"],
};

function compile(source: string): RegExp {
	let n = 0;
	const pattern = source.replace(/\{([A-Z]+)\}/g, (_, key: string) => {
		const placeholder = PLACEHOLDERS[key];
		if (!placeholder) throw new Error(`unknown line-shape placeholder ${key}`);
		n++;
		return `(?<${placeholder[0]}${n}>${placeholder[1]})`;
	});
	return new RegExp(`^${pattern}$`, "d");
}

// ModemManager writes `<level> [object] text` to syslog: 1.20 uses <info>,
// <warn>, <error>; 1.24 uses <inf>, <msg>, <wrn>, <err>. With --log-journal it
// writes no level text. Debug (<debug>, <dbg>) is never admitted.
const MM = String.raw`(?:<(?:info|inf|msg|warn|wrn|err|error)>\s{1,3})?`;
const MM_OBJ = String.raw`\[modem\d{1,3}(?:/[a-zA-Z0-9-]{1,16}){0,2}\] `;
// NetworkManager's `[epoch.fraction]` prefix is removed before matching.
const NM = String.raw`<(?:info|warn|error)>\s{1,3}`;
const MOVE = String.raw`\({STATE} -> {STATE}\)`;

// wpa_supplicant and hostapd share the AP code: `AP-ENABLED ` keeps its
// trailing space, AP-STA-CONNECTED may carry ip_addr= and keyid= (dropped).
const AP_SHAPES = [
	String.raw`{IF}: interface state [A-Z_]{2,16}->[A-Z_]{2,16}`,
	String.raw`{IF}: AP-(?:ENABLED|DISABLED) ?`,
	String.raw`{IF}: AP-STA-(?:CONNECTED|DISCONNECTED|POSSIBLE-PSK-MISMATCH) {MAC}(?: ip_addr={IP})?{KEYID}`,
];

const SHAPES: Record<ShapeSource, readonly string[]> = {
	ModemManager: [
		String.raw`${MM}ModemManager \(version [0-9.]{1,16}\) starting in system bus\.\.\.`,
		`${MM}${MM_OBJ}(?:modem )?state changed ${MOVE}`,
		`${MM}${MM_OBJ}(?:3GPP |EPS |5GS |CS |PS )?registration state changed ${MOVE}`,
		`${MM}${MM_OBJ}3GPP packet service state changed ${MOVE}`,
		String.raw`${MM}${MM_OBJ}access technology changed \([a-z0-9, -]{1,40} -> [a-z0-9, -]{1,40}\)`,
		String.raw`${MM}${MM_OBJ}signal quality updated \({NUM}\)`,
		`${MM}${MM_OBJ}power state updated: (?:on|off|low|unknown)`,
		`${MM}${MM_OBJ}set power state '(?:on|off|low)'`,
		String.raw`${MM}${MM_OBJ}failed setting power state '(?:on|off|low)': {REASON}`,
		String.raw`${MM}${MM_OBJ}consolidated registration state: cs '{STATE}', ps '{STATE}', eps '{STATE}', 5gs '{STATE}' --> '{STATE}'`,
		String.raw`${MM}${MM_OBJ}Network rejection received: reason '{STATE}' \({NUM}\), operator id '{OPID}', operator name '{SQNAME}', access technology '[a-z0-9, -]{1,40}'`,
		String.raw`${MM}${MM_OBJ}simple connect started\.\.\.`,
		String.raw`${MM}${MM_OBJ}simple connect state \({NUM}/{NUM}\): [a-z ]{3,60}`,
		String.raw`${MM}${MM_OBJ}(?:port '?[a-zA-Z0-9/]{1,24}'? )?(?:port )?timed out {NUM} consecutive times(?:, marking modem as invalid)?`,
		String.raw`${MM}${MM_OBJ}connection #{NUM} finished: duration [0-9:s]{1,16}(?:, tx: \d{1,15} bytes, rx: \d{1,15} bytes)?`,
		String.raw`${MM}${MM_OBJ}(?:couldn't {COULDNT}|couldn't start IPv[46] network|connection attempt #\d{1,3} failed|modem couldn't be initialized|data connection attempt failed|synchronizing all bearer status failed|failed sending SIM PIN|failed enabling modem|registration in network failed|packet service attach in 3GPP network failed|failed waiting for enabled state)(?:: {REASON})?`,
		// 1.24 warnings and QMI call-end reasons that name a carrier's refusal.
		String.raw`${MM}${MM_OBJ}modem is locked with '[a-z0-9-]{2,24}'`,
		String.raw`${MM}${MM_OBJ}\s{0,2}call end reason \({NUM}\): (?:{NICK}|\(null\))`,
		String.raw`${MM}${MM_OBJ}verbose call end reason \({NUM},{NUM}\): \[[a-z0-9-]{2,24}\] (?:{NICK}|\(null\))`,
		String.raw`${MM}${MM_OBJ}(?:received critical sim error: SIM might be permanently blocked, reprobing\.\.\.|Received critical sim error\. SIM might be permanently blocked\. Reprobing\.\.\.)`,
		String.raw`${MM}\[device {TAIL}\] creating modem with plugin '[a-zA-Z0-9 _-]{1,32}' and '{NUM}' ports(?: \([0-9a-f]{4}(?::[0-9a-f]{4}){1,2}\))? ?`,
		String.raw`${MM}\[base-manager\] modem for device '{TAIL}' successfully created`,
	],
	NetworkManager: [
		String.raw`${NM}NetworkManager \(version [0-9a-z.-]{1,32}\) is starting\.\.\.(?: \({TAIL}\))?`,
		String.raw`${NM}manager: NetworkManager state is now [A-Z_]{2,24}`,
		String.raw`${NM}device \({IF}\): state change: {STATE} -> {STATE} \(reason '{STATE}', (?:sys-iface-state|managed-type): '{STATE}'(?:, missing firmware)?\)`,
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
		String.raw`${NM}device \({IF}\): supplicant interface state: {STATE} -> {STATE}(?: \(simulated signal\))?`,
		String.raw`${NM}device \({IF}\): carrier: link connected`,
		String.raw`${NM}modem-broadband\[{IF}\]: failed to connect modem: {REASON}`,
		String.raw`${NM}modem-broadband\[{IF}\]: failed to connect '{SQNAME}': (?:APN not found: {REASON}|not a mobile broadband modem|unable to determine the network id)`,
		String.raw`${NM}modem\["{IF}"\]: cannot enable/disable modem: locked`,
		String.raw`${NM}policy: connection '{SQNAME}' auto-activation failed: {REASON}`,
		String.raw`${NM}policy: set '{SQNAME}' \({IF}\) as default for IPv[46] routing and DNS`,
		String.raw`${NM}dhcp[46] \({IF}\): state changed (?:new|no) lease(?:, address={IP})?(?:, acd pending|, acd conflict)?`,
		String.raw`${NM}dhcp[46] \({IF}\): activation: beginning transaction \(timeout in {NUM} seconds\)`,
		String.raw`${NM}connectivity: \({IF}(?:,IPv[46])?(?:,\d{1,6})?\) (?:timed out|is now [A-Z]{2,12}|check failed to {IP}:\d{1,5})`,
		String.raw`${NM}manager: \({IF}\): new [A-Za-z0-9 .-]{1,40} device \(/org/freedesktop/NetworkManager/Devices/\d{1,6}\)`,
	],
	wpa_supplicant: [
		String.raw`{IF}: CTRL-EVENT-CONNECTED - Connection to {MAC} completed(?: \[id=\d{1,4} id_str={TAIL}\])?`,
		String.raw`{IF}: CTRL-EVENT-DISCONNECTED bssid={MAC} reason={NUM}(?: locally_generated=1)?`,
		String.raw`{IF}: CTRL-EVENT-SSID-TEMP-DISABLED id=\d{1,4} ssid="{DQNAME}" auth_failures=\d{1,4} duration=\d{1,6} reason=[A-Z_]{2,32}`,
		String.raw`{IF}: CTRL-EVENT-SSID-REENABLED id=\d{1,4} ssid="{DQNAME}"`,
		String.raw`{IF}: CTRL-EVENT-ASSOC-REJECT bssid={MAC} status_code={NUM}`,
		String.raw`{IF}: CTRL-EVENT-SCAN-FAILED ret={NUM}(?: retry=\d)?`,
		String.raw`{IF}: CTRL-EVENT-REGDOM-CHANGE init=[A-Z_]{2,16} type=[A-Z_]{2,16}(?: alpha2=[A-Z0-9]{2})?`,
		String.raw`{IF}: CTRL-EVENT-SIGNAL-CHANGE above=[01] signal={NUM} noise={NUM} txrate={NUM}`,
		String.raw`{IF}: (?:SME: )?Trying to (?:associate|authenticate) with {MAC} \(SSID='{SQNAME}' freq=\d{4} MHz\)`,
		String.raw`{IF}: Associated with {MAC}`,
		String.raw`{IF}: Authentication with {MAC} timed out\.`,
		String.raw`{IF}: WPA: Key negotiation completed with {MAC} \[PTK=[A-Z0-9-]{2,16} GTK=[A-Z0-9-]{2,16}\]`,
		String.raw`{IF}: WPA: 4-Way Handshake failed - pre-shared key may be incorrect`,
		// Hotspot: NetworkManager runs the access point through wpa_supplicant.
		...AP_SHAPES,
	],
	hostapd: [
		...AP_SHAPES,
		String.raw`{IF}: STA {MAC} IEEE 802\.11: (?:associated|disassociated|deauthenticated due to inactivity[a-z ()]{0,40})`,
		String.raw`{IF}: STA {MAC} WPA: pairwise key handshake completed \((?:RSN|WPA)\)`,
	],
	kernel: [
		String.raw`Linux version [0-9][0-9A-Za-z.+_-]{0,48}{TAIL}`,
		String.raw`usb {USBPATH}: USB disconnect, device number \d{1,4}`,
		String.raw`usb {USBPATH}: new [A-Za-z -]{3,40} USB device number \d{1,4} using {DRIVER}`,
		String.raw`usb {USBPATH}: reset [A-Za-z -]{3,40} USB device number \d{1,4} using {DRIVER}`,
		String.raw`usb {USBPATH}: New USB device found, idVendor=[0-9a-f]{4}, idProduct=[0-9a-f]{4}(?:, bcdDevice=\s?[0-9a-f.]{1,6})?`,
		String.raw`usb {USBPATH}: New USB device strings: Mfr=\d{1,3}, Product=\d{1,3}, SerialNumber=\d{1,3}`,
		String.raw`usb {USBPATH}: (?:Product|Manufacturer): [A-Za-z0-9 _.,()/-]{1,64}`,
		String.raw`usb {USBPATH}: SerialNumber: {SERIAL}`,
		String.raw`usb {USBPATH}: (?:device descriptor read/(?:64|all), error -\d{1,4}|device not accepting address \d{1,4}, error -\d{1,4}|unable to enumerate USB device)`,
		String.raw`(?:usb|hub) [a-z0-9.:-]{1,24}: (?:[Oo]ver-current (?:condition|change)(?: on port \d{1,3})?|attempt power cycle|unable to enumerate USB device|Cannot enable\. Maybe the USB cable is bad\?|disabled by hub \(EMI\?\), re-enabling\.\.\.)`,
		String.raw`usb {USBPATH}: GSM modem \(1-port\) converter (?:now attached to|now disconnected from) ttyUSB\d{1,2}`,
		String.raw`option {USBPATH}: GSM modem \(1-port\) converter detected`,
		String.raw`option\d{1,2} ttyUSB\d{1,2}: GSM modem \(1-port\) converter now disconnected from ttyUSB\d{1,2}`,
		String.raw`(?:qmi_wwan|cdc_mbim|cdc_ether|cdc_ncm|rndis_host) {USBPATH} {IF}: register '[a-z_]{1,16}' at [a-zA-Z0-9_.:-]{1,64}, [A-Za-z0-9 /]{1,40}, {MAC}`,
		String.raw`(?:qmi_wwan|cdc_mbim|cdc_ether|cdc_ncm|rndis_host) {USBPATH} {IF}: (?:renamed from {IF}|unregister '[a-z_]{1,16}' [a-zA-Z0-9_.:-]{1,64}, [A-Za-z0-9 /]{1,40})`,
		String.raw`xhci_hcd [0-9a-f.:]{1,24}: (?:xHCI host controller not responding, assume dead|HC died; cleaning up|Host halt failed, -?\d{1,4}|USB bus \d{1,3} deregistered)`,
		String.raw`(?:hwmon hwmon\d{1,2}: )?Under-?voltage detected!?(?: \(0x[0-9a-f]{8}\))?`,
		String.raw`(?:hwmon hwmon\d{1,2}: )?Voltage normali[sz]ed(?: \(0x[0-9a-f]{8}\))?`,
		String.raw`Out of memory: Killed process \d{1,10} \([a-zA-Z0-9_.:-]{1,16}\){TAIL}`,
		String.raw`[a-zA-Z0-9_.:-]{1,16} invoked oom-killer: {TAIL}`,
		String.raw`thermal thermal_zone\d{1,2}: critical temperature reached \(\d{1,3} C\), shutting down`,
		String.raw`CPU\d{1,3}: (?:Core|Package) temperature (?:above threshold, cpu clock throttled|\/speed normal)[a-z ()0-9:]{0,40}`,
		String.raw`IPv6: ADDRCONF\(NETDEV_(?:UP|CHANGE)\): {IF}: link (?:is not ready|becomes ready)`,
		String.raw`{IF}: (?:authenticated|associated|deauthenticating from {MAC} by local choice \(Reason: \d{1,3}=[A-Z_]{1,40}\)|authenticate with {MAC}|send auth to {MAC} \(try \d/\d\)|associate with {MAC} \(try \d/\d\)|disconnect from AP {MAC} for new auth to {MAC}|Link is (?:Up|Down)[A-Za-z0-9 /-]{0,40})`,
	],
};

const COMPILED: Record<ShapeSource, readonly RegExp[]> = {
	ModemManager: SHAPES.ModemManager.map(compile),
	NetworkManager: SHAPES.NetworkManager.map(compile),
	wpa_supplicant: SHAPES.wpa_supplicant.map(compile),
	hostapd: SHAPES.hostapd.map(compile),
	kernel: SHAPES.kernel.map(compile),
};

const PHRASES = new Set([
	...MODEM_ERROR_PHRASES,
	// NetworkManager's own text for a modem that gave no IP configuration.
	"invalid bearer IP configuration",
	// ModemManager's modem state names, which some waits report as the error.
	...[
		"unknown",
		"failed",
		"initializing",
		"locked",
		"disabled",
		"disabling",
		"enabling",
		"enabled",
		"searching",
		"registered",
		"disconnecting",
		"connecting",
		"connected",
	],
]);
const NICKNAME = /^[a-z0-9]+(?:-[a-z0-9]+){0,7}$/;
const COULDNT = new Set(MODEM_COULDNT_HEADS);
const QMI_ERROR = /^QMI protocol error \(\d{1,5}\): '[A-Za-z-]{2,48}'/;
const DBUS_ERROR =
	/^(?:GDBus\.Error:)?org\.freedesktop\.ModemManager1\.Error\.[A-Za-z]{2,24}\.[A-Za-z]{2,48}$/;

/** Keep leading segments that are ModemManager's own phrases; the first other
 * segment and everything after it become [reason].
 */
export function boundedModemReason(value: string): string {
	const out: string[] = [];
	let rest = value.trim();
	while (rest) {
		const qmi = QMI_ERROR.exec(rest)?.[0];
		const cut = rest.indexOf(": ");
		const segment = qmi ?? (cut < 0 ? rest : rest.slice(0, cut));
		const known =
			qmi !== undefined ||
			// "Call failed: <libqmi call-end nickname>".
			(out.at(-1) === "Call failed" && NICKNAME.test(segment)) ||
			PHRASES.has(segment) ||
			PHRASES.has(segment.replace(/\.$/, "")) ||
			DBUS_ERROR.test(segment);
		if (!known) {
			out.push("[reason]");
			break;
		}
		out.push(segment);
		rest = rest.slice(segment.length);
		if (!rest) break;
		if (!rest.startsWith(": ")) {
			out.push("[reason]");
			break;
		}
		rest = rest.slice(2);
	}
	return out.join(": ");
}

/** The export text for a group; null withholds the whole line. */
function replacement(group: string, value: string): string | null | undefined {
	if (group.startsWith("head")) return COULDNT.has(value) ? undefined : null;
	if (group.startsWith("reason")) return boundedModemReason(value);
	if (group.startsWith("addr")) return "[address]";
	if (group.startsWith("name")) return "[name]";
	if (group.startsWith("serial")) return "[serial]";
	if (group.startsWith("id")) return "[id]";
	if (group.startsWith("drop")) return "";
	if (group.startsWith("if"))
		return value.replace(/^(wlx|enx|wwx)[0-9a-f]{12}$/i, "$1[address]");
	return undefined;
}

const INTERFACE_NAME = new RegExp(`^${PLACEHOLDERS.IF?.[1] ?? "(?!)"}$`);

/** A kernel or modem port interface name, by the rule the shapes use. */
export function isInterfaceName(value: string): boolean {
	return value.length <= 32 && INTERFACE_NAME.test(value);
}

export function isShapeSource(source: string): source is ShapeSource {
	return Object.hasOwn(SHAPES, source);
}

/** Render a third-party line through its allowlisted shape, or undefined. */
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
	for (const shape of COMPILED[source]) {
		const match = shape.exec(text);
		if (!match) continue;
		const spans: [start: number, end: number, value: string][] = [];
		for (const [group, span] of Object.entries(match.indices?.groups ?? {})) {
			if (!span) continue;
			const value = replacement(group, text.slice(span[0], span[1]));
			if (value === null) return undefined;
			if (value !== undefined) spans.push([span[0], span[1], value]);
		}
		let out = text;
		for (const [start, end, value] of spans.sort((a, b) => b[0] - a[0]))
			out = out.slice(0, start) + value + out.slice(end);
		return out.trimEnd();
	}
	return undefined;
}
