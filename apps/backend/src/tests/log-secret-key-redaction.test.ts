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
} from "../helpers/logger.ts";
import { loadConfig, setConfigFilePath } from "../modules/config.ts";
import { parseRecord } from "../modules/device-logs/parse.ts";
import { journalObject } from "./helpers/device-journal-record.ts";

// Synthetic values only. Each is distinctive so a leak shows up verbatim.
const SSH_PASS = "fixture-ssh-pass-7Qe2";
const SSH_PASS_HASH = "$6$fixturesalt$fixturehashfixturehash";
const REMOTE_KEY = "fixture-remote-key-K9x4";
const UI_PASSWORD_HASH = "$2b$10$fixturebcryptfixturebcryptfixtureb";
const SRT_PASSPHRASE = "fixture-srt-passphrase";
const PAIRING_SECRET = "fixture-pairing-secret";
const WIFI_PSK = "fixture-wifi-psk-55";

const SECRETS = [
	SSH_PASS,
	SSH_PASS_HASH,
	REMOTE_KEY,
	UI_PASSWORD_HASH,
	SRT_PASSPHRASE,
	PAIRING_SECRET,
	WIFI_PSK,
];

const flush = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 25));

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
		const lines: string[] = [];
		const stop = onLogLine((line) => {
			if (line.includes("top-level credential probe")) lines.push(line);
		});
		try {
			logger.debug("top-level credential probe", {
				ssh_pass: SSH_PASS,
				remote_key: REMOTE_KEY,
			});
			await flush();
		} finally {
			stop();
		}

		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain(SSH_PASS);
		expect(lines[0]).not.toContain(REMOTE_KEY);
	});
});

describe("config loaded: allowlisted fields only", () => {
	let dir = "";

	afterEach(() => {
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
				max_br: 5000,
			}),
			{ mode: 0o600 },
		);
		setConfigFilePath(path);

		const lines: string[] = [];
		const stop = onLogLine((line) => {
			if (line.includes('"msg":"config loaded"')) lines.push(line);
		});
		try {
			await loadConfig();
			await flush();
		} finally {
			stop();
		}

		expect(lines).toHaveLength(1);
		const line = lines[0] ?? "";
		for (const secret of SECRETS) expect(line).not.toContain(secret);
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
