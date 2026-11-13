/** Allowlisted line shapes for third-party daemons in the support download.
 *
 * ModemManager, NetworkManager, wpa_supplicant, hostapd and the kernel write
 * free text this project does not control. Instead of guessing what might be
 * private in it, only the lines diagnosis needs are admitted, each as a fixed
 * shape. A line that matches no shape is withheld and counted: an unknown line
 * costs diagnosis, never privacy. Admitted lines still pass the content filters.
 *
 * Placeholders expand to named capture groups. A group's name prefix decides
 * what reaches the export: `addr` becomes [address], `name` becomes [name],
 * `serial` becomes [serial], `id` becomes [id], `drop` is removed, `if` keeps an interface name
 * with any embedded MAC masked, and every other group is kept as written.
 */

export type ShapeSource =
	| "ModemManager"
	| "NetworkManager"
	| "wpa_supplicant"
	| "hostapd"
	| "kernel";

const PLACEHOLDERS: Record<string, [prefix: string, pattern: string]> = {
	IF: ["if", "[a-zA-Z][a-zA-Z0-9._-]{0,15}"],
	MAC: ["addr", "[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}"],
	IP: ["addr", "[0-9a-fA-F][0-9a-fA-F.:]{1,44}"],
	SQNAME: ["name", "[^'\\n]{0,64}"],
	DQNAME: ["name", '[^"\\n]{0,64}'],
	UUID: ["id", "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"],
	SERIAL: ["serial", "[^\\s]{1,64}"],
	// Error text from the daemon; kept, then checked by the content filters.
	REASON: ["reason", "[A-Za-z0-9 ,.'():_/+#-]{1,200}"],
	STATE: ["state", "[a-zA-Z_-]{2,32}"],
	NUM: ["num", "-?\\d{1,6}"],
	USBPATH: ["usb", "\\d{1,2}-[\\d.]{1,16}(?::\\d\\.\\d{1,2})?"],
	DRIVER: ["driver", "[a-z][a-z0-9_-]{1,23}"],
	TAIL: ["drop", ".{0,4000}"],
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

// ModemManager writes `<level>  [object] text`; debug output is never admitted.
const MM = String.raw`<(?:info|warn|wrn|err|error|msg)>\s{1,3}`;
const MM_OBJ = String.raw`\[modem\d{1,3}(?:/[a-zA-Z0-9-]{1,16}){0,2}\] `;
// NetworkManager's `[epoch.fraction]` prefix is removed before matching.
const NM = String.raw`<(?:info|warn|error)>\s{1,3}`;
const MOVE = String.raw`\({STATE} -> {STATE}\)`;

const SHAPES: Record<ShapeSource, readonly string[]> = {
	ModemManager: [
		String.raw`${MM}ModemManager \(version [0-9.]{1,16}\) starting in system bus\.\.\.`,
		`${MM}${MM_OBJ}(?:modem )?state changed ${MOVE}`,
		String.raw`${MM}${MM_OBJ}modem state changed, '{STATE}' --> '{STATE}' \(reason: {STATE}\)`,
		`${MM}${MM_OBJ}(?:3GPP |EPS |5GS |CS |PS )?registration state changed ${MOVE}`,
		`${MM}${MM_OBJ}3GPP packet service state changed ${MOVE}`,
		String.raw`${MM}${MM_OBJ}access technology changed \([a-z0-9, -]{1,40} -> [a-z0-9, -]{1,40}\)`,
		String.raw`${MM}${MM_OBJ}signal quality updated \({NUM}\)`,
		`${MM}${MM_OBJ}power state updated: (?:on|off|low|unknown)`,
		String.raw`${MM}${MM_OBJ}simple connect started\.\.\.`,
		String.raw`${MM}${MM_OBJ}simple connect state \({NUM}/{NUM}\): [a-z ]{3,60}`,
		String.raw`${MM}${MM_OBJ}(?:port '?[a-zA-Z0-9/]{1,24}'? )?(?:port )?timed out {NUM} consecutive times`,
		String.raw`${MM}${MM_OBJ}connection #{NUM} finished: duration [0-9:s]{1,16}(?:, tx: \d{1,15} bytes, rx: \d{1,15} bytes)?`,
		String.raw`${MM}${MM_OBJ}(?:couldn't [a-z0-9 -]{3,60}|connection attempt #\d{1,3} failed|modem couldn't be initialized|simple connect failed|couldn't connect bearer|bearer (?:connection|disconnection) failed)(?:: {REASON})?`,
		String.raw`${MM}\[device {TAIL}\] creating modem with plugin '[a-zA-Z0-9 _-]{1,32}' and '{NUM}' ports`,
		String.raw`${MM}\[base-manager\] modem for device '{TAIL}' successfully created`,
	],
	NetworkManager: [
		String.raw`${NM}NetworkManager \(version [0-9a-z.-]{1,32}\) is starting\.\.\.(?: \({TAIL}\))?`,
		String.raw`${NM}manager: NetworkManager state is now [A-Z_]{2,24}`,
		String.raw`${NM}device \({IF}\): state change: {STATE} -> {STATE} \(reason '{STATE}', sys-iface-state: '{STATE}'\)`,
		String.raw`${NM}device \({IF}\): Activation: starting connection '{SQNAME}' \({UUID}\)`,
		String.raw`${NM}device \({IF}\): Activation: Stage \d of 5 \([A-Za-z0-9 ]{1,40}\) [a-z ,.]{1,60}`,
		String.raw`${NM}device \({IF}\): Activation: successful, device activated\.`,
		String.raw`${NM}device \({IF}\): Activation: failed for connection '{SQNAME}'`,
		String.raw`${NM}device \({IF}\): Activation: \((?:wifi|wwan|gsm)\) access point '{SQNAME}' has security, but secrets are required\.`,
		String.raw`${NM}device \({IF}\): Activation: \(wifi\) association took too long[a-z ,.]{0,40}`,
		String.raw`${NM}device \({IF}\): supplicant interface state: {STATE} -> {STATE}`,
		String.raw`${NM}device \({IF}\): carrier: link (?:connected|disconnected)[a-z ()0-9]{0,48}`,
		String.raw`${NM}modem-broadband\[{IF}\]: failed to connect modem: {REASON}`,
		String.raw`${NM}modem-broadband\[{IF}\]: modem state changed, '{STATE}' --> '{STATE}' \(reason: {STATE}\)`,
		String.raw`${NM}policy: set '{SQNAME}' \({IF}\) as default for IPv[46] routing and DNS`,
		String.raw`${NM}dhcp[46] \({IF}\): state changed [a-z ]{1,24}(?:, address={IP})?`,
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
	],
	hostapd: [
		String.raw`{IF}: interface state [A-Z_]{2,16}->[A-Z_]{2,16}`,
		String.raw`{IF}: AP-(?:ENABLED|DISABLED)`,
		String.raw`{IF}: AP-STA-(?:CONNECTED|DISCONNECTED|POSSIBLE-PSK-MISMATCH) {MAC}`,
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

function replacement(group: string, value: string): string | undefined {
	if (group.startsWith("addr")) return "[address]";
	if (group.startsWith("name")) return "[name]";
	if (group.startsWith("serial")) return "[serial]";
	if (group.startsWith("id")) return "[id]";
	if (group.startsWith("drop")) return "";
	if (group.startsWith("if"))
		return value.replace(/^(wlx|enx|wwx)[0-9a-f]{12}$/i, "$1[address]");
	return undefined;
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
			if (value !== undefined) spans.push([span[0], span[1], value]);
		}
		let out = text;
		for (const [start, end, value] of spans.sort((a, b) => b[0] - a[0]))
			out = out.slice(0, start) + value + out.slice(end);
		return out.trimEnd();
	}
	return undefined;
}
