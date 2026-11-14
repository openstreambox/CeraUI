/** Build the closed daemon vocabularies the support download renders.
 *
 * The support export keeps a daemon field only when it is a member of the
 * producer's own vocabulary: ModemManager's enum nicknames, D-Bus error names,
 * connect steps and plugin names; libqmi's call-end and protocol-error
 * nicknames keyed by their numeric code; NetworkManager's device states,
 * reasons, supplicant and connectivity states; wpa_supplicant's and hostapd's
 * state words, ciphers and 802.11 reason names. Anything else is shown as a
 * placeholder. The lists come from the Debian source packages of the versions
 * devices run; their SHA-256 sums are recorded in the generated file:
 *
 *   bun scripts/support-daemon-vocabulary.ts --write \
 *     modemmanager_1.20.4.orig.tar.xz modemmanager_1.24.2.orig.tar.xz \
 *     libqmi_1.32.2.orig.tar.xz libqmi_1.36.0.orig.tar.xz \
 *     libqmi_1.38.0.orig.tar.gz \
 *     network-manager_1.42.4.orig.tar.xz network-manager_1.52.1.orig.tar.bz2 \
 *     wpa_2.10.orig.tar.xz \
 *     libmbim_1.28.2.orig.tar.xz libmbim_1.32.0.orig.tar.xz
 *
 * (from https://deb.debian.org/debian/pool/main/; libqmi under libq/libqmi/ and libmbim under libm/libmbim/). Enum nicknames follow
 * glib-mkenums: an explicit `nick=` annotation, else the value name without
 * the enum's common prefix, lower case, `_` as `-`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const GENERATED_PATH = join(
	import.meta.dir,
	"../src/modules/system/support-daemon-vocabulary.generated.ts",
);

export interface EnumValue {
	readonly name: string;
	readonly value: number | undefined;
	readonly nick: string;
}

function stripComments(text: string): string {
	// Keep glib-mkenums `/*< … >*/` annotations; drop other comments.
	return text
		.replace(/\/\*(?!<)[\s\S]*?\*\//g, " ")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function evaluate(
	expression: string,
	known: Map<string, number>,
): number | undefined {
	const text = expression.trim().replace(/^\((.*)\)$/, "$1");
	if (/^-?\d+$/.test(text)) return Number(text);
	if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text, 16);
	const shift = /^\(?\s*1\s*<<\s*(\d+)\s*\)?$/.exec(text);
	if (shift?.[1]) return 2 ** Number(shift[1]);
	return known.get(text);
}

/** Every `typedef enum { … } Name;` in a header, with glib-mkenums nicks. */
export function parseEnums(header: string): Map<string, EnumValue[]> {
	const out = new Map<string, EnumValue[]>();
	const text = stripComments(header);
	for (const match of text.matchAll(
		/typedef\s+enum\s*(?:\/\*<([^>]*)>\s*\*\/)?\s*\{([\s\S]*?)\}\s*(\w+)\s*;/g,
	)) {
		const options = match[1] ?? "";
		const body = match[2] ?? "";
		const typeName = match[3] ?? "";
		const entries: { name: string; value?: string; nick?: string }[] = [];
		for (const line of body.split("\n")) {
			const entry =
				/^\s*([A-Z][A-Za-z0-9_]*)\s*(?:=\s*((?:[^,/]|\/(?!\*))*))?,?\s*(?:\/\*<([^>]*)>\s*\*\/)?,?\s*$/.exec(
					line,
				);
			if (!entry?.[1]) continue;
			const annotation = entry[3] ?? "";
			if (/\bskip\b/.test(annotation)) continue;
			const nick = /\bnick=([^\s,]+)/.exec(annotation)?.[1];
			entries.push({
				name: entry[1],
				...(entry[2]?.trim() ? { value: entry[2].trim() } : {}),
				...(nick ? { nick } : {}),
			});
		}
		let prefix = /\bprefix=([A-Za-z0-9_]+)/.exec(options)?.[1];
		if (prefix)
			prefix = `${prefix.toUpperCase().replace(/-/g, "_").replace(/_?$/, "")}_`;
		else {
			let common: string | undefined;
			for (const entry of entries) {
				if (entry.nick) continue;
				if (common === undefined) common = entry.name;
				else {
					let i = 0;
					while (i < common.length && common[i] === entry.name[i]) i++;
					common = common.slice(0, i);
				}
			}
			prefix = common === undefined ? "" : common.replace(/_[^_]*$/, "_");
		}
		const known = new Map<string, number>();
		let next = 0;
		const values: EnumValue[] = [];
		for (const entry of entries) {
			const value =
				entry.value === undefined ? next : evaluate(entry.value, known);
			if (value !== undefined) {
				known.set(entry.name, value);
				next = value + 1;
			}
			values.push({
				name: entry.name,
				value,
				nick:
					entry.nick ??
					(entry.name.startsWith(prefix)
						? entry.name.slice(prefix.length)
						: entry.name
					)
						.replace(/_/g, "-")
						.toLowerCase(),
			});
		}
		out.set(typeName, values);
	}
	return out;
}

function files(dir: string, suffix: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...files(path, suffix));
		else if (entry.name.endsWith(suffix)) out.push(path);
	}
	return out;
}

function enumsIn(paths: readonly string[]): Map<string, EnumValue[]> {
	const out = new Map<string, EnumValue[]>();
	for (const path of paths)
		if (!existsSync(path)) throw new Error("missing enum header");
		else
			for (const [name, values] of parseEnums(readFileSync(path, "utf8")))
				out.set(name, values);
	return out;
}

type CodeTable = Record<string, string[]>;

function addCodes(into: CodeTable, values: readonly EnumValue[] | undefined) {
	if (!values?.length) throw new Error("missing or empty code enum");
	for (const { value, nick } of values) {
		if (value === undefined) throw new Error("unresolved enum code");
		const list = into[String(value)] ?? [];
		if (!list.includes(nick)) list.push(nick);
		into[String(value)] = list;
	}
}

function addNicks(into: Set<string>, values: readonly EnumValue[] | undefined) {
	for (const { nick } of values ?? []) into.add(nick);
}

const VERBOSE_TYPE_ENUMS: Record<string, string> = {
	mip: "QmiWdsVerboseCallEndReasonMip",
	internal: "QmiWdsVerboseCallEndReasonInternal",
	cm: "QmiWdsVerboseCallEndReasonCm",
	"3gpp": "QmiWdsVerboseCallEndReason3gpp",
	ppp: "QmiWdsVerboseCallEndReasonPpp",
	ehrpd: "QmiWdsVerboseCallEndReasonEhrpd",
	ipv6: "QmiWdsVerboseCallEndReasonIpv6",
};

/** Strings of a NetworkManager `NM_UTILS_LOOKUP_STR_DEFINE(name, …)` table. */
function lookupStrings(text: string, name: string): string[] {
	const start = new RegExp(
		`NM_UTILS_LOOKUP_STR_DEFINE\\s*\\(\\s*${name}\\s*,`,
	).exec(text);
	if (!start) return [];
	const end = text.indexOf(");", start.index);
	const block = text.slice(start.index, end);
	const out: string[] = [];
	for (const item of block.matchAll(
		/NM_UTILS_LOOKUP_(?:STR_ITEM\s*\([^,]+,|DEFAULT(?:_WARN|_NM_ASSERT)?\s*\()([^)]*)\)/g,
	)) {
		const literals = [...(item[1] ?? "").matchAll(/"([^"]*)"/g)];
		const last = literals.at(-1)?.[1];
		if (last && !/\?/.test(last)) out.push(last);
	}
	return out;
}

/** `return "X";` strings in a C function body. */
function returnedStrings(text: string, name: string): string[] {
	const start = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*\\{`).exec(text);
	if (!start) return [];
	const end = text.indexOf("\n}", start.index);
	return [...text.slice(start.index, end).matchAll(/return\s+"([^"]+)";/g)].map(
		(m) => m[1] ?? "",
	);
}

export interface Vocabulary {
	wlanReasons: CodeTable;
	qmiCallEnd: CodeTable;
	qmiVerboseType: CodeTable;
	qmiVerboseReason: Record<string, CodeTable>;
	qmiProtocolError: CodeTable;
	mbimStatusError: CodeTable;
	mbimProtocolError: CodeTable;
	lists: Record<string, string[]>;
}

export function collectDaemonVocabulary(roots: {
	modemManager: readonly string[];
	libqmi: readonly string[];
	libmbim?: readonly string[];
	networkManager: readonly string[];
	wpa: readonly string[];
}): Vocabulary {
	const mbimStatusError: CodeTable = {};
	const mbimProtocolError: CodeTable = {};
	for (const root of roots.libmbim ?? []) {
		const enums = enumsIn([join(root, "src/libmbim-glib/mbim-errors.h")]);
		addCodes(mbimStatusError, enums.get("MbimStatusError"));
		addCodes(mbimProtocolError, enums.get("MbimProtocolError"));
	}
	const qmiCallEnd: CodeTable = {};
	const qmiVerboseType: CodeTable = {};
	const qmiVerboseReason: Record<string, CodeTable> = {};
	const qmiProtocolError: CodeTable = {};
	for (const root of roots.libqmi) {
		const dir = join(root, "src/libqmi-glib");
		const enums = enumsIn([
			join(dir, "qmi-enums-wds.h"),
			join(dir, "qmi-errors.h"),
		]);
		addCodes(qmiCallEnd, enums.get("QmiWdsCallEndReason"));
		addCodes(qmiVerboseType, enums.get("QmiWdsVerboseCallEndReasonType"));
		addCodes(qmiProtocolError, enums.get("QmiProtocolError"));
		for (const { value, nick } of enums.get("QmiWdsVerboseCallEndReasonType") ??
			[]) {
			const enumName = VERBOSE_TYPE_ENUMS[nick];
			if (value === undefined || !enumName) continue;
			const table = qmiVerboseReason[String(value)] ?? {};
			addCodes(table, enums.get(enumName));
			qmiVerboseReason[String(value)] = table;
		}
	}

	const sets: Record<string, Set<string>> = {};
	const set = (key: string) => {
		sets[key] ??= new Set();
		return sets[key];
	};
	const MM_ENUMS: Record<string, string> = {
		mmModemStates: "MMModemState",
		mmRegistrationStates: "MMModem3gppRegistrationState",
		mmPacketServiceStates: "MMModem3gppPacketServiceState",
		mmAccessTechnologies: "MMModemAccessTechnology",
		mmModemLocks: "MMModemLock",
		mmNetworkErrors: "MMNetworkError",
	};
	const DBUS_DOMAINS: Record<string, string> = {
		MMCoreError: "Core",
		MMMobileEquipmentError: "MobileEquipment",
		MMConnectionError: "Connection",
		MMSerialError: "Serial",
		MMMessageError: "Message",
		MMCdmaActivationError: "CdmaActivation",
		MMCarrierLockError: "CarrierLock",
	};
	for (const root of roots.modemManager) {
		const enums = enumsIn([
			join(root, "include/ModemManager-enums.h"),
			join(root, "include/ModemManager-errors.h"),
		]);
		for (const [key, enumName] of Object.entries(MM_ENUMS))
			addNicks(set(key), enums.get(enumName));
		for (const [enumName, domain] of Object.entries(DBUS_DOMAINS))
			for (const { nick } of enums.get(enumName) ?? [])
				set("mmDbusErrors").add(
					`org.freedesktop.ModemManager1.Error.${domain}.${nick}`,
				);
		const simple = join(root, "src/mm-iface-modem-simple.c");
		if (existsSync(simple))
			for (const step of readFileSync(simple, "utf8").matchAll(
				/simple connect state \(%d\/%d\): ([a-z ]+)"/g,
			))
				set("mmConnectSteps").add(step[1] ?? "");
		for (const meson of [
			...files(join(root, "src/plugins"), "meson.build"),
			...files(join(root, "plugins"), "meson.build"),
		])
			for (const name of readFileSync(meson, "utf8").matchAll(
				/MM_MODULE_NAME="([^"]+)"/g,
			))
				if (!name[1]?.startsWith("shared-"))
					set("mmPlugins").add(name[1] ?? "");
		for (const source of [
			...files(join(root, "src/plugins"), ".c"),
			...files(join(root, "plugins"), ".c"),
		])
			for (const name of readFileSync(source, "utf8").matchAll(
				/MM_PLUGIN_NAME,\s*"([^"]+)"/g,
			))
				set("mmPlugins").add(name[1] ?? "");
	}

	for (const root of roots.networkManager) {
		const read = (path: string) =>
			existsSync(join(root, path))
				? readFileSync(join(root, path), "utf8")
				: "";
		const utils = read("src/core/devices/nm-device-utils.c");
		for (const value of lookupStrings(
			utils,
			"nm_device_state_queued_state_to_string",
		))
			set("nmDeviceStates").add(value);
		for (const value of lookupStrings(
			utils,
			"nm_device_state_reason_to_string",
		))
			set("nmDeviceReasons").add(value);
		for (const name of [
			"nm_device_managed_type_to_string",
			"nm_device_sys_iface_state_to_string",
		])
			for (const value of lookupStrings(utils, name))
				set("nmManagedTypes").add(value);
		for (const value of lookupStrings(
			read("src/core/supplicant/nm-supplicant-interface.c"),
			"nm_supplicant_interface_state_to_string",
		))
			set("nmSupplicantStates").add(value);
		for (const value of lookupStrings(
			read("src/core/nm-connectivity.c"),
			"_state_to_string",
		))
			set("nmConnectivityStates").add(value);
		for (const value of returnedStrings(
			read("src/core/nm-manager.c"),
			"_nm_state_to_string",
		))
			set("nmStates").add(value);
		// "manager: (…): new <type> device (…)" uses each class's type_desc.
		for (const source of files(join(root, "src/core/devices"), ".c"))
			for (const desc of readFileSync(source, "utf8").matchAll(
				/NM_DEVICE_TYPE_DESC,\s*"([^"]+)"/g,
			))
				set("nmDeviceTypes").add(desc[1] ?? "");
	}
	const wlanReasons: CodeTable = {};
	for (const root of roots.wpa) {
		const read = (path: string) =>
			existsSync(join(root, path))
				? readFileSync(join(root, path), "utf8")
				: "";
		// 802.11 reason codes; the kernel prints the same names after "Reason: N=".
		for (const define of read("src/common/ieee802_11_defs.h").matchAll(
			/#define WLAN_REASON_([A-Z0-9_]+)\s+(\d+)\b/g,
		))
			addCodes(wlanReasons, [
				{
					name: define[1] ?? "",
					value: Number(define[2]),
					nick: define[1] ?? "",
				},
			]);
		for (const source of files(join(root, "wpa_supplicant"), ".c"))
			for (const reason of readFileSync(source, "utf8").matchAll(
				/wpas_auth_failed\(wpa_s, "([A-Z_]+)"/g,
			))
				set("wpaTempDisabledReasons").add(reason[1] ?? "");
		for (const value of returnedStrings(
			read("src/common/wpa_common.c"),
			"wpa_cipher_txt",
		))
			set("wpaCiphers").add(value);
		const events = read("wpa_supplicant/events.c");
		for (const value of returnedStrings(events, "reg_init_str"))
			if (value !== "?") set("wpaRegInitiators").add(value);
		for (const value of returnedStrings(events, "reg_type_str"))
			if (value !== "?") set("wpaRegTypes").add(value);
		for (const value of returnedStrings(
			read("src/ap/hostapd.c"),
			"hostapd_state_text",
		))
			set("hostapdStates").add(value);
	}
	const lists: Record<string, string[]> = {};
	for (const [key, values] of Object.entries(sets))
		lists[key] = [...values].filter(Boolean).sort();
	const sortTable = (table: CodeTable) =>
		Object.fromEntries(
			Object.entries(table)
				.sort(([a], [b]) => Number(a) - Number(b))
				.map(([code, nicks]) => [code, [...nicks].sort()]),
		);
	if (
		!roots.modemManager.length ||
		!roots.libqmi.length ||
		!roots.libmbim?.length ||
		!roots.networkManager.length ||
		!roots.wpa.length
	)
		throw new Error("missing source family");
	for (const [key, values] of Object.entries(lists))
		if (!values.length) throw new Error(`empty vocabulary ${key}`);
	if (Object.keys(lists).length < 21 || !Object.keys(wlanReasons).length)
		throw new Error("incomplete vocabulary");
	return {
		mbimStatusError: sortTable(mbimStatusError),
		mbimProtocolError: sortTable(mbimProtocolError),
		wlanReasons: sortTable(wlanReasons),
		qmiCallEnd: sortTable(qmiCallEnd),
		qmiVerboseType: sortTable(qmiVerboseType),
		qmiVerboseReason: Object.fromEntries(
			Object.entries(qmiVerboseReason)
				.sort(([a], [b]) => Number(a) - Number(b))
				.map(([type, table]) => [type, sortTable(table)]),
		),
		qmiProtocolError: sortTable(qmiProtocolError),
		lists: Object.fromEntries(
			Object.entries(lists).sort(([a], [b]) => (a < b ? -1 : 1)),
		),
	};
}

export function renderGenerated(
	vocabulary: Vocabulary,
	sources: readonly string[],
): string {
	const table = (value: unknown) => JSON.stringify(value);
	return `// Generated by apps/backend/scripts/support-daemon-vocabulary.ts; do not edit.
// Sources (Debian pool):
${sources.map((line) => `//   ${line}`).join("\n")}

/** IEEE 802.11 reason names by code (wpa_supplicant's WLAN_REASON_* table). */
export const WLAN_REASONS: Readonly<Record<string, readonly string[]>> = ${table(vocabulary.wlanReasons)};

/** libqmi QmiWdsCallEndReason nicknames by numeric code. */
export const QMI_CALL_END_REASONS: Readonly<Record<string, readonly string[]>> = ${table(vocabulary.qmiCallEnd)};

/** libqmi QmiWdsVerboseCallEndReasonType nicknames by numeric code. */
export const QMI_VERBOSE_CALL_END_TYPES: Readonly<Record<string, readonly string[]>> = ${table(vocabulary.qmiVerboseType)};

/** libqmi verbose call-end reason nicknames by type code, then reason code. */
export const QMI_VERBOSE_CALL_END_REASONS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = ${table(vocabulary.qmiVerboseReason)};

/** libmbim error nicknames by numeric code. */
export const MBIM_STATUS_ERRORS: Readonly<Record<string, readonly string[]>> = ${table(vocabulary.mbimStatusError)};
export const MBIM_PROTOCOL_ERRORS: Readonly<Record<string, readonly string[]>> = ${table(vocabulary.mbimProtocolError)};

/** libqmi QmiProtocolError nicknames by numeric code. */
export const QMI_PROTOCOL_ERRORS: Readonly<Record<string, readonly string[]>> = ${table(vocabulary.qmiProtocolError)};

/** Closed daemon vocabularies: ModemManager enum nicknames, D-Bus error
 * names, connect steps and plugins; NetworkManager state and reason strings.
 */
export const DAEMON_VOCABULARY = ${table(vocabulary.lists)} as const satisfies Readonly<Record<string, readonly string[]>>;
`;
}

function classify(
	tarball: string,
): "modemManager" | "libqmi" | "libmbim" | "networkManager" | "wpa" {
	const name = basename(tarball);
	if (name.startsWith("wpa_")) return "wpa";
	if (name.startsWith("modemmanager_")) return "modemManager";
	if (name.startsWith("libmbim_")) return "libmbim";
	if (name.startsWith("libqmi_")) return "libqmi";
	if (name.startsWith("network-manager_")) return "networkManager";
	throw new Error(`unrecognised source tarball ${name}`);
}

if (import.meta.main) {
	const tarballs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
	if (tarballs.length === 0) {
		console.error(
			"usage: support-daemon-vocabulary.ts [--write] <modemmanager_*|libqmi_*|network-manager_*|wpa_*>.orig.tar.*...",
		);
		process.exit(2);
	}
	const work = mkdtempSync(join(tmpdir(), "daemon-vocabulary-"));
	const roots = {
		modemManager: [] as string[],
		libqmi: [] as string[],
		libmbim: [] as string[],
		networkManager: [] as string[],
		wpa: [] as string[],
	};
	const sources: string[] = [];
	for (const [index, tarball] of tarballs.entries()) {
		const sha256 = createHash("sha256")
			.update(readFileSync(tarball))
			.digest("hex");
		const source = `${basename(tarball)} sha256 ${sha256}`;
		if (
			process.argv.includes("--check") &&
			!readFileSync(GENERATED_PATH, "utf8").includes(`//   ${source}`)
		)
			throw new Error("source hash differs from recorded header");
		sources.push(source);
		const into = join(work, String(index));
		mkdirSync(into, { recursive: true });
		const untar = spawnSync("tar", ["-xf", tarball, "-C", into]);
		if (untar.status !== 0) throw new Error(`could not extract ${tarball}`);
		for (const top of readdirSync(into))
			roots[classify(tarball)].push(join(into, top));
	}
	const text = renderGenerated(collectDaemonVocabulary(roots), sources);
	rmSync(work, { recursive: true, force: true });
	if (process.argv.includes("--check")) {
		const formatted = spawnSync(
			process.execPath,
			["x", "biome", "format", "--stdin-file-path", GENERATED_PATH],
			{ input: text, encoding: "utf8", cwd: join(import.meta.dir, "../../..") },
		);
		if (
			formatted.status !== 0 ||
			formatted.stdout !== readFileSync(GENERATED_PATH, "utf8")
		)
			throw new Error("generated vocabulary drift");
	} else if (process.argv.includes("--write")) {
		writeFileSync(GENERATED_PATH, text);
		// Match the repository formatting so `biome check` stays clean.
		spawnSync("bunx", ["biome", "format", "--write", GENERATED_PATH], {
			stdio: "inherit",
			cwd: join(import.meta.dir, "../../.."),
		});
	} else process.stdout.write(text);
}
