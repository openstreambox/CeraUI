/*
  Level `observe` acts on nothing. These guards hold that over every file in
  the roaming module and every literal style, so a later change that adds an
  effect has to change a guard on purpose.
*/
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");
const DIR = join(SRC, "modules/network/wifi-roaming");

/** The observer's files. A new file must be added here, and so pass the guards. */
const EXPECTED = [
	"observer.ts",
	"policy.ts",
	"proof.ts",
	"radio-port.ts",
	"runtime.ts",
	"sender-links.ts",
	"sender-port.ts",
];

const sources = readdirSync(DIR)
	.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
	.sort();
const read = (file: string) => readFileSync(join(DIR, file), "utf8");

/** Source without comments, so a guard judges code, not prose about it. */
function code(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Every string literal's text: double, single and template (all parts). */
function literals(text: string): string[] {
	const out: string[] = [];
	for (const m of code(text).matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/gs))
		out.push(m[2] as string);
	return out;
}

/** Literal words that would name a command changing the radio or the network. */
const FORBIDDEN_WORDS = new Set([
	"scan",
	"trigger",
	"rescan",
	"--rescan",
	"connect",
	"disconnect",
	"up",
	"down",
	"add",
	"modify",
	"delete",
	"del",
	"set",
	"clone",
	"reapply",
	"roam",
	"reassociate",
	"-s",
	"--show-secrets",
]);

/** Names that would reach NetworkManager, the Wi-Fi client or the sender's controls. */
const FORBIDDEN_NAMES = [
	"nmcli",
	"wpa_cli",
	"wpa_supplicant",
	"fi.w1",
	"org.freedesktop.NetworkManager",
	"AddAndActivateConnection",
	"ActivateConnection",
	"DeactivateConnection",
	"AddConnection",
	"RequestScan",
	"Reapply",
	"GetSecrets",
	"SelectNetwork",
	"AddNetwork",
	"Reassociate",
	"setMode",
	"setQuality",
	"setStallDeselect",
	"setConnTimeout",
	"rawRequest",
	"subscribe",
	"subscribeStats",
	"Bun.spawn",
	"child_process",
	"execFile",
	"withWifiAdapterLock",
	"holdOutOfBond",
	"protectRadiosFromScans",
];

/** Imports the observer may use: reads, the pure modules and its own files. */
const ALLOWED_IMPORTS = new Set([
	"node:fs/promises",
	"@ceraui/srtla-send/control",
	"@ceraui/srtla-send/sender",
	"../../../helpers/logger.ts",
	"../../../helpers/run.ts",
	"../../streaming/constants.ts",
	"../../wifi/wifi-adapter-admission.ts",
	"../../wifi/wifi-connections.ts",
	"../../wifi/wifi-interfaces.ts",
	"../../wifi/wifi-permanent-mac.ts",
	"../network-interfaces.ts",
	"./observer.ts",
	"./policy.ts",
	"./proof.ts",
	"./radio-port.ts",
	"./sender-links.ts",
	"./sender-port.ts",
]);

describe("the roaming observer acts on nothing", () => {
	test("its files are the expected ones, and none of the effect modules exist", () => {
		expect(sources).toEqual(EXPECTED);
		for (const gone of [
			"bond-hold.ts",
			"scan-gate.ts",
			"nm-port.ts",
			"coordinator.ts",
			"swap-op.ts",
			"radio-lock.ts",
			"ownership.ts",
		])
			expect(existsSync(join(DIR, gone))).toBe(false);
	});

	test("no literal names a command that changes a radio, a profile or the network", () => {
		const hits: string[] = [];
		for (const file of sources)
			for (const lit of literals(read(file)))
				for (const word of lit.split(/[\s"',[\]]+/))
					if (FORBIDDEN_WORDS.has(word.toLowerCase()))
						hits.push(`${file}: ${JSON.stringify(lit)}`);
		expect(hits).toEqual([]);
	});

	test("no NetworkManager or Wi-Fi client member, sender control, exec or lock is named", () => {
		const hits: string[] = [];
		for (const file of sources) {
			const text = code(read(file));
			for (const name of FORBIDDEN_NAMES)
				if (
					new RegExp(`(^|[^\\w.])${name.replace(/\./g, "\\.")}\\b`).test(text)
				)
					hits.push(`${file}: ${name}`);
		}
		expect(hits).toEqual([]);
	});

	test("no secret is read", () => {
		const hits: string[] = [];
		for (const file of sources)
			for (const word of ["password", "psk", "secret", "credential"])
				if (code(read(file)).toLowerCase().includes(word))
					hits.push(`${file}: ${word}`);
		expect(hits).toEqual([]);
	});

	test("it imports only reads, the pure modules and its own files", () => {
		const hits: string[] = [];
		for (const file of sources)
			for (const m of code(read(file)).matchAll(/from\s+"([^"]+)"/g))
				if (!ALLOWED_IMPORTS.has(m[1] as string)) hits.push(`${file}: ${m[1]}`);
		expect(hits).toEqual([]);
		// From the Wi-Fi registry only the read accessor.
		for (const file of sources) {
			const m =
				/import\s*{([^}]*)}\s*from\s*"\.\.\/\.\.\/wifi\/wifi-connections\.ts"/.exec(
					code(read(file)),
				);
			if (m)
				expect(
					(m[1] as string)
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean),
				).toEqual(["getWifiInterfacesByMacAddress"]);
		}
	});

	test("the only command it runs is iw, with the interface list or one radio's link", () => {
		const runs: string[] = [];
		for (const file of sources) {
			const text = code(read(file));
			for (const m of text.matchAll(/\brun\(\s*"([^"]+)"/g))
				runs.push(`${file}: ${m[1]}`);
			for (const m of text.matchAll(/\bquiet\(\s*(\[[^\]]*\])/g))
				runs.push(`${file}: iw ${m[1]}`);
		}
		expect(runs.sort()).toEqual(
			[
				"radio-port.ts: iw",
				'radio-port.ts: iw ["dev"]',
				'radio-port.ts: iw ["dev", ifname, "link"]',
			].sort(),
		);
	});
});

describe("what the observer leaves untouched", () => {
	test("the diversity check, the rescan path, bond admission and the sender lists know nothing of roaming", () => {
		for (const file of [
			"modules/wifi/wifi-network-diversity.ts",
			"modules/wifi/wifi-connections.ts",
			"rpc/procedures/wifi.procedure.ts",
			"modules/network/network-interfaces.ts",
			"modules/streaming/srtla.ts",
			"modules/streaming/streamloop/session.ts",
		])
			expect(readFileSync(join(SRC, file), "utf8")).not.toContain(
				"wifi-roaming",
			);
	});

	test("only the boot wiring and the shutdown reach the observer", () => {
		const main = readFileSync(join(SRC, "main.ts"), "utf8");
		expect(main).toContain("./modules/network/wifi-roaming/runtime.ts");
	});
});
