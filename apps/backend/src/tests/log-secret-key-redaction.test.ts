import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	configLogView,
	LOGGABLE_CONFIG_FIELDS,
} from "../helpers/config-log-view.ts";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import {
	isSensitiveKey,
	logger,
	logRedact,
	onLogLine,
	REDACTED,
	redactKeyValueText,
} from "../helpers/logger.ts";
import { loadConfig, setConfigFilePath } from "../modules/config.ts";
import { parseRecord } from "../modules/device-logs/parse.ts";
import { logRpcCall } from "../rpc/rpc-logging.ts";
import { journalObject } from "./helpers/device-journal-record.ts";

// Synthetic values only. Each is distinctive so a leak shows up verbatim.
const SSH_PASS = "fixture-ssh-pass-7Qe2";
const SSH_PASS_HASH = "$6$fixturesalt$fixturehashfixturehash";
const REMOTE_KEY = "fixture-remote-key-K9x4";
const UI_PASSWORD_HASH = "$2b$10$fixturebcryptfixturebcryptfixtureb";
const SRT_PASSPHRASE = "fixture-srt-passphrase";
const PAIRING_SECRET = "fixture-pairing-secret";
const WIFI_PSK = "fixture-wifi-psk-55";
const RELAY_ACCOUNT = "fixture-relay-account-61";

const SECRETS = [
	SSH_PASS,
	SSH_PASS_HASH,
	REMOTE_KEY,
	UI_PASSWORD_HASH,
	SRT_PASSPHRASE,
	PAIRING_SECRET,
	WIFI_PSK,
];

/**
 * Collect ring records containing `marker` while `emit` runs, resolving once
 * one has arrived (winston delivers on a later tick) or failing after 2 s.
 */
async function captureLines(
	marker: string,
	emit: () => unknown,
): Promise<string[]> {
	const lines: string[] = [];
	const stop = onLogLine((line) => {
		if (line.includes(marker)) lines.push(line);
	});
	try {
		await emit();
		const deadline = Date.now() + 2_000;
		while (lines.length === 0 && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 5));
	} finally {
		stop();
	}
	return lines;
}

describe("logger key rules: credentials whose names the substring rule missed", () => {
	test("ssh_pass, ssh_pass_hash, remote_key and their spellings are masked", () => {
		const out = logRedact({
			ssh_pass: SSH_PASS,
			ssh_pass_hash: SSH_PASS_HASH,
			sshPass: SSH_PASS,
			SSH_PASS: SSH_PASS,
			remote_key: REMOTE_KEY,
			remoteKey: REMOTE_KEY,
			api_key: "x",
			stream_key: "x",
			pre_shared_key: "x",
			"802-11-wireless-security.psk": WIFI_PSK,
			wifiPsk: WIFI_PSK,
			root_pwd: "x",
			nested: { ssh_pass: SSH_PASS, list: [{ remote_key: REMOTE_KEY }] },
		}) as Record<string, unknown>;

		const text = JSON.stringify(out);
		for (const secret of SECRETS) expect(text).not.toContain(secret);
		for (const [key, value] of Object.entries(out)) {
			if (key !== "nested") expect(value).toBe(REDACTED);
		}
	});

	test("words that only contain pass or key stay readable", () => {
		const input = {
			video_passthrough: "auto",
			passthrough: true,
			passThrough: true,
			"pass-through": "auto",
			deviceKey: "d-0123456789abcdef",
			bypass: false,
			compass: 3,
			key: "wifi_modes",
			stableKey: "usb-1.2",
			sortKey: 4,
			keyframe_interval: 2,
			keyInt: 60,
			passed: 12,
		};

		expect(logRedact(input)).toEqual(input);
	});

	test("an Error carrying a credential field is projected without it", () => {
		const err = Object.assign(new Error("ssh setup failed"), {
			ssh_pass: SSH_PASS,
		});

		expect(JSON.stringify(logRedact({ err }))).not.toContain(SSH_PASS);
	});

	test("every logger key rule is applied through the one shared predicate", () => {
		for (const key of [
			"ssh_pass",
			"remote_key",
			"password_hash",
			"srt_streamid",
			"smsText",
			"latitude",
			"ownNumber",
			"username",
		])
			expect(isSensitiveKey(key)).toBe(true);
	});

	test("the top-level record keys go through the same rules on a live transport", async () => {
		const lines = await captureLines("top-level credential probe", () =>
			logger.debug("top-level credential probe", {
				ssh_pass: SSH_PASS,
				remote_key: REMOTE_KEY,
			}),
		);

		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain(SSH_PASS);
		expect(lines[0]).not.toContain(REMOTE_KEY);
	});
});

describe("key rules on JSON that is already text", () => {
	test("plain, escaped, cut-off and numeric pairs lose their values", () => {
		const text = [
			`{"ssh_pass":"${SSH_PASS}","max_br":5000}`,
			`"{\\"remote_key\\":\\"${REMOTE_KEY}\\",\\"x\\":1}"`,
			'{"puk": 12345678, "pin":1234}',
			// A value cut off by the end of the text (a split record).
			`{"ssh_pass_hash":"${SSH_PASS_HASH}`,
		].join(" ");
		const out = redactKeyValueText(text);

		for (const secret of [SSH_PASS, REMOTE_KEY, SSH_PASS_HASH, "12345678"])
			expect(out).not.toContain(secret);
		expect(out).not.toMatch(/"pin":\s*1234/);
		expect(out).toContain('"max_br":5000');
		expect(out).toContain('\\"x\\":1');
	});

	test("ordinary pairs and plain text are left alone", () => {
		const text =
			'{"video_passthrough":"auto","stableKey":"usb-1.2","msg":"ok: done"} note: fine';
		expect(redactKeyValueText(text)).toBe(text);
	});

	test("a rejected frame's string preview is masked at write time", () => {
		const preview = JSON.stringify({
			path: ["system", "setRemoteConfig"],
			input: { remote_key: REMOTE_KEY },
		}).slice(0, 64);
		const out = logRedact({ preview }) as { preview: string };

		expect(out.preview).not.toContain(REMOTE_KEY.slice(0, 12));
		expect(out.preview).toContain("setRemoteConfig");
	});
});

describe("RPC traces: procedures whose credentials have generic names", () => {
	test.each([
		[["pairing", "completePairing"], { code: "fixture-claim-code" }],
		[["modems", "unlockSimPuk"], { puk: "12345678", newPin: "1234" }],
		[["addons", "configure"], { id: "a", userConfig: { token2: "x" } }],
		[["addons", "install"], { id: "a", userConfig: { anything: "x" } }],
	] as const)("%p records no arguments", (path, input) => {
		const traces: Array<Record<string, unknown> | undefined> = [];
		logRpcCall(
			{ path, input, ok: true, latencyMs: 1, cid: "c" },
			{
				sink: { debug: (_message, meta) => traces.push(meta) },
				now: () => 0,
				genCorrelationId: () => "c",
				isEnabled: () => true,
			},
		);

		expect(traces).toHaveLength(1);
		expect(traces[0]?.args).toBeUndefined();
	});

	test("a PUK is masked by its key wherever it is logged", () => {
		expect(logRedact({ puk: "12345678" })).toEqual({ puk: REDACTED });
	});
});

describe("config loaded: allowlisted fields only", () => {
	let dir = "";

	afterEach(async () => {
		// loadConfig replaced the runtime config and both held hashes; leave an
		// empty config behind, not this fixture's credentials.
		if (dir) {
			writeFileSync(join(dir, "config.json"), "{}", { mode: 0o600 });
			await loadConfig();
		}
		setConfigFilePath("config.json");
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	test("the boot-time record carries no credential from config.json", async () => {
		dir = mkdtempSync(join(tmpdir(), "config-loaded-redaction-"));
		const path = join(dir, "config.json");
		writeFileSync(
			path,
			JSON.stringify({
				password_hash: UI_PASSWORD_HASH,
				ssh_pass: SSH_PASS,
				ssh_pass_hash: SSH_PASS_HASH,
				remote_key: REMOTE_KEY,
				srt_passphrase: SRT_PASSPHRASE,
				pairing_secret: PAIRING_SECRET,
				// Masked only by the allowlist: no key rule matches it.
				relay_account: RELAY_ACCOUNT,
				max_br: 5000,
			}),
			{ mode: 0o600 },
		);
		setConfigFilePath(path);

		const lines = await captureLines('"msg":"config loaded"', () =>
			loadConfig(),
		);

		expect(lines).toHaveLength(1);
		const line = lines[0] ?? "";
		for (const secret of [...SECRETS, RELAY_ACCOUNT])
			expect(line).not.toContain(secret);
		// Still useful: allowlisted values survive, masked keys stay visible.
		expect(line).toContain('"max_br":5000');
		expect(line).toContain(`"ssh_pass":"${REDACTED}"`);
	});

	test("a config field nobody has classified yet is masked by default", () => {
		const view = configLogView({
			max_br: 5000,
			brand_new_credential: "fixture-new-credential",
		} as RuntimeConfig);

		expect(view.max_br).toBe(5000);
		expect(view.brand_new_credential).toBe(REDACTED);
	});

	test("no credential field is on the allowlist", () => {
		for (const key of [
			"password",
			"password_hash",
			"ssh_pass",
			"ssh_pass_hash",
			"srt_passphrase",
			"remote_key",
			"pairing_secret",
			"srt_streamid",
			"relay_streamid_override",
		] as const)
			expect(LOGGABLE_CONFIG_FIELDS.has(key)).toBe(false);
		for (const key of LOGGABLE_CONFIG_FIELDS)
			expect(isSensitiveKey(key)).toBe(false);
	});
});

describe("journal read side: records an older build already wrote", () => {
	// The live viewer (query, follow), the log export and the support bundle all
	// read journal records through parseRecord.
	test("a stored config loaded record is shown without its credentials", () => {
		const legacyLine = JSON.stringify({
			ts: "2026-11-27T00:00:00.000Z",
			level: "debug",
			msg: "config loaded",
			meta: {
				password_hash: REDACTED,
				ssh_pass: SSH_PASS,
				ssh_pass_hash: SSH_PASS_HASH,
				remote_key: REMOTE_KEY,
				max_br: 5000,
			},
		});
		const record = parseRecord(
			journalObject({
				_SYSTEMD_UNIT: "ceralive.service",
				MESSAGE: legacyLine,
			}),
		);

		expect(record).not.toBeNull();
		const message = record?.message ?? "";
		expect(message).toStartWith("config loaded ");
		for (const secret of SECRETS) expect(message).not.toContain(secret);
		expect(message).toContain('"max_br":5000');
	});
});
