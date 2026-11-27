/*
  Level `observe` acts on nothing. These guards hold that over every file in
  the roaming module, nested ones included, and every literal and import
  style, so a later change that adds an effect has to change a guard on
  purpose.
*/
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";

const SRC = join(import.meta.dir, "..");
const DIR = join(SRC, "modules/network/wifi-roaming");

/** The observer's files. A new file must be added here, and so pass the guards. */
const EXPECTED = [
	"loss-watch.ts",
	"observer.ts",
	"policy.ts",
	"proof.ts",
	"radio-port.ts",
	"runtime.ts",
	"sender-links.ts",
	"sender-port.ts",
];

/** Every file under the module, nested ones too, relative to it. */
function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path) : [relative(DIR, path)];
	});
}
const everything = walk(DIR).sort();
/** Source files of any script kind, tests excluded. */
const sources = everything
	.filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(f))
	.filter((f) => !/\.test\.[a-z]+$/.test(f))
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

/** Every module a file loads: static, side-effect, dynamic, require, re-export. */
function specifiers(text: string): string[] {
	const out: string[] = [];
	for (const re of [
		/\bfrom\s*(["'`])([^"'`]+)\1/g,
		/\bimport\s*(["'`])([^"'`]+)\1/g,
		/\bimport\s*\(\s*(["'`])([^"'`]+)\1/g,
		/\brequire\s*\(\s*(["'`])([^"'`]+)\1/g,
	])
		for (const m of code(text).matchAll(re)) out.push(m[2] as string);
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
	"Bun.$",
	"child_process",
	"execFile",
	"spawn",
	"withWifiAdapterLock",
	"holdOutOfBond",
	"protectRadiosFromScans",
];

/** Imports the observer may use: reads, the pure modules and its own files. */
const ALLOWED_IMPORTS = new Set([
	"node:fs/promises",
	"@ceraui/srtla-send/control",
	"../../../helpers/logger.ts",
	"../../../helpers/run.ts",
	"../../streaming/continuity-observer.ts",
	"../../streaming/srtla.ts",
	"../../wifi/wifi-adapter-admission.ts",
	"../../wifi/wifi-connections.ts",
	"../../wifi/wifi-interfaces.ts",
	"../../wifi/wifi-permanent-mac.ts",
	"../network-interfaces.ts",
	"./loss-watch.ts",
	"./observer.ts",
	"./policy.ts",
	"./proof.ts",
	"./radio-port.ts",
	"./sender-links.ts",
	"./sender-port.ts",
]);

/** From each shared module, exactly these symbols. */
const ALLOWED_SYMBOLS: Record<string, string[]> = {
	"../../../helpers/logger.ts": ["logger"],
	"../../../helpers/run.ts": ["ID_RE", "argMatch", "run"],
	"../../streaming/continuity-observer.ts": [
		"OwnedSender",
		"ownedSenderLifetime",
	],
	"../../streaming/srtla.ts": ["getLastPublishedBond"],
	"../../wifi/wifi-adapter-admission.ts": [
		"WifiAdapterAdmission",
		"admitWifiAdapter",
		"physicalWifiAdapterId",
		"samePhysicalWifiAdapter",
	],
	"../../wifi/wifi-connections.ts": ["getWifiInterfacesByMacAddress"],
	"../../wifi/wifi-interfaces.ts": ["WifiInterface"],
	"../../wifi/wifi-permanent-mac.ts": ["normalizeMacAddress"],
	"../network-interfaces.ts": ["getNetworkInterfaces"],
	"@ceraui/srtla-send/control": [
		"ControlClient",
		"SenderLinkStats",
		"SenderStats",
		"createControlClient",
	],
	"node:fs/promises": [
		"appendFile",
		"chmod",
		"lstat",
		"mkdir",
		"readFile",
		"readdir",
		"readlink",
		"rename",
		"unlink",
		"writeFile",
	],
};

const sortedEntries = (o: Record<string, Iterable<string>>) =>
	Object.fromEntries(
		Object.entries(o)
			.map(([k, v]) => [k, [...v].sort()] as const)
			.sort(([a], [b]) => a.localeCompare(b)),
	);

describe("the roaming observer acts on nothing", () => {
	test("its files are the expected ones, nothing else hides there, and no effect module exists", () => {
		expect(sources).toEqual(EXPECTED);
		expect(
			everything.filter(
				(f) =>
					!EXPECTED.includes(f) &&
					f !== "README.md" &&
					!/^[a-z-]+\.test\.ts$/.test(f),
			),
		).toEqual([]);
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
			for (const name of FORBIDDEN_NAMES) {
				const escaped = name.replace(/[.$]/g, (c) => `\\${c}`);
				if (new RegExp(`(^|[^\\w.])${escaped}(?!\\w)`).test(text))
					hits.push(`${file}: ${name}`);
			}
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

	test("it loads only reads, the pure modules and its own files, in any import form", () => {
		const hits: string[] = [];
		for (const file of sources)
			for (const spec of specifiers(read(file)))
				if (!ALLOWED_IMPORTS.has(spec)) hits.push(`${file}: ${spec}`);
		expect(hits).toEqual([]);
		// No dynamic loading at all: every module is named statically.
		for (const file of sources)
			expect(/\bimport\s*\(|\brequire\s*\(/.test(code(read(file)))).toBe(false);
	});

	test("from shared modules it takes only the read symbols it needs", () => {
		const taken: Record<string, Set<string>> = {};
		for (const file of sources) {
			const text = code(read(file));
			// Namespace and default imports would take everything.
			expect(
				/\bimport\s+(?:type\s+)?(?:\*|\w+\s*(?:,|\bfrom\b))/.test(text),
			).toBe(false);
			for (const m of text.matchAll(
				/\bimport\s+(?:type\s+)?{([^}]*)}\s*from\s*(["'`])([^"'`]+)\2/g,
			)) {
				const spec = m[3] as string;
				if (spec.startsWith("./")) continue;
				const names = taken[spec] ?? new Set<string>();
				taken[spec] = names;
				for (const raw of (m[1] as string).split(",")) {
					const name = raw
						.replace(/^\s*type\s+/, "")
						.trim()
						.split(/\s+as\s+/)[0];
					if (name) names.add(name);
				}
			}
		}
		expect(sortedEntries(taken)).toEqual(sortedEntries(ALLOWED_SYMBOLS));
	});

	test("the sender client is narrowed to its two reads", () => {
		const port = code(read("sender-port.ts"));
		expect(port.replace(/\s+/g, " ")).toContain(
			'Pick< ControlClient, "getStats" | "getCapabilities" | "close" >',
		);
		const calls = [...port.matchAll(/\b(?:client|opened)\??\.(\w+)\(/g)].map(
			(m) => m[1],
		);
		expect(new Set(calls)).toEqual(
			new Set(["close", "getCapabilities", "getStats"]),
		);
	});

	test("the only commands it runs are iw, with the interface list or one radio's link, and one nmcli read", () => {
		// Every way a runner could be reached: the name, a property, a read.
		const sites: string[] = [];
		for (const file of sources)
			for (const m of code(read(file)).matchAll(
				/\bquiet\(\[[^\]]*\]\)|\.run\b|\brun\b/g,
			))
				sites.push(`${file}: ${m[0].replace(/\s+/g, " ")}`);
		const LINK =
			/^radio-port\.ts: quiet\(\[ ?"dev", argMatch\(ID_RE, admission\.row\.ifname\), "link",? ?\]\)$/;
		const normalized = sites.map((s) => (LINK.test(s) ? "LINK" : s)).sort();
		// Exactly these sites, each as often as listed.
		expect(normalized).toEqual(
			[
				// The radio port's runner: the deps field, the production deps'
				// parameter and shorthand, the one call through it, the interface
				// list and the link read.
				"radio-port.ts: run",
				"radio-port.ts: run",
				"radio-port.ts: run",
				"radio-port.ts: run",
				// The two calls through it: iw, and the one NetworkManager read.
				"radio-port.ts: .run",
				"radio-port.ts: .run",
				// The loss watch imports only argMatch and ID_RE from the run helper.
				"loss-watch.ts: run",
				'radio-port.ts: quiet(["dev"])',
				"LINK",
				// The runtime: the production runner imported and handed to the
				// radio port, and the /run directory in its path and its doc.
				"runtime.ts: run",
				"runtime.ts: run",
				"runtime.ts: run",
				"runtime.ts: run",
			].sort(),
		);
		expect(code(read("radio-port.ts"))).toContain('deps.run("iw", args, {');
		// The wrapper is never aliased, passed on or called with a computed
		// argument: its name appears exactly at its definition and its two reads.
		const refs = sources.flatMap((file) =>
			// A property key of the same name (the runner option) is no reference.
			[...code(read(file)).matchAll(/\bquiet\b(?!\??\s*:)/g)].map(() => file),
		);
		expect(refs).toEqual(["radio-port.ts", "radio-port.ts", "radio-port.ts"]);
		expect(code(read("radio-port.ts"))).toContain("const quiet = async (args");
	});
});

describe("the runner, read from the syntax tree", () => {
	const tree = (file: string) =>
		ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);

	/** How each identifier `name` is used in `file`, by syntax, not by text. */
	function uses(file: string, name: string): string[] {
		const src = tree(file);
		const out: string[] = [];
		const visit = (n: ts.Node) => {
			if (ts.isIdentifier(n) && n.text === name) {
				const p = n.parent;
				const text = (x: ts.Node) => x.getText(src).replace(/\s+/g, " ");
				if (
					(ts.isPropertyAssignment(p) ||
						ts.isPropertySignature(p) ||
						ts.isShorthandPropertyAssignment(p)) &&
					p.name === n
				)
					out.push(`key:${text(p)}`);
				else if (ts.isPropertyAccessExpression(p) && p.name === n) {
					const call = p.parent;
					out.push(
						ts.isCallExpression(call) && call.expression === p
							? `member-call:${text(call).split("(")[0]}(${call.arguments[0] ? text(call.arguments[0]) : ""}`
							: `member:${text(p)}`,
					);
				} else if (ts.isVariableDeclaration(p) && p.name === n)
					out.push("declaration");
				else if (ts.isParameter(p) && p.name === n) out.push("parameter");
				else if (ts.isImportSpecifier(p)) out.push("import");
				else if (ts.isCallExpression(p) && p.expression === n)
					out.push(
						`call:${p.arguments.map((a) => (ts.isArrayLiteralExpression(a) ? text(a) : `<${ts.SyntaxKind[a.kind]}>`)).join(",")}`,
					);
				else out.push(`other:${text(p)}`);
			}
			ts.forEachChild(n, visit);
		};
		visit(src);
		return out.sort();
	}

	test("the wrapper is declared once and called only with the two literal reads", () => {
		const q = uses("radio-port.ts", "quiet");
		expect(q.filter((u) => !u.startsWith("key:"))).toEqual(
			[
				"declaration",
				'call:["dev"]',
				'call:["dev", argMatch(ID_RE, admission.row.ifname), "link"]',
			].sort(),
		);
		for (const file of sources.filter((f) => f !== "radio-port.ts"))
			expect(uses(file, "quiet").filter((u) => !u.startsWith("key:"))).toEqual(
				[],
			);
	});

	test("the runner is called once, for iw, and otherwise only passed along by name", () => {
		const r = uses("radio-port.ts", "run");
		expect(r.filter((u) => u.startsWith("member"))).toEqual([
			'member-call:deps.run("iw"',
			'member-call:deps.run("nmcli"',
		]);
		expect(
			r.filter((u) => u.startsWith("other:") || u.startsWith("call:")),
		).toEqual([]);
		const rt = uses("runtime.ts", "run");
		expect(
			rt.filter((u) => u.startsWith("call:") || u.startsWith("member")),
		).toEqual([]);
		expect(rt.filter((u) => u.startsWith("other:"))).toEqual([
			"other:defaultRadioPortDeps(run, now, exclude)",
		]);
	});
});

describe("the one NetworkManager read", () => {
	test("nmcli appears once, reading only the seen-bssids property of one profile", () => {
		const hits = sources.flatMap((file) =>
			[...code(read(file)).matchAll(/\bnmcli\b/g)].map(() => file),
		);
		expect(hits).toEqual(["radio-port.ts"]);
		const text = code(read("radio-port.ts")).replace(/\s+/g, " ");
		expect(text).toContain(
			'deps.run( "nmcli", [ "-g", "802-11-wireless.seen-bssids", "connection", "show", argMatch(UUID_RE, uuid), ], { timeout: READ_TIMEOUT_MS, quiet: true }, )',
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

	test("only the boot wiring reaches the observer", () => {
		const hits: string[] = [];
		const scan = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				if (statSync(path).isDirectory()) {
					if (path !== DIR && name !== "tests") scan(path);
				} else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
					if (readFileSync(path, "utf8").includes("wifi-roaming/"))
						hits.push(relative(SRC, path));
				}
			}
		};
		scan(SRC);
		expect(hits).toEqual(["main.ts"]);
	});
});
