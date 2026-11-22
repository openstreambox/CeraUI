import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	StartResult,
	StreamReadiness,
	UplinkHealthRecord,
} from "@ceraui/rpc/schemas";
import {
	lastStartError,
	noteStartResult,
	resetLastStartErrorForTest,
} from "../modules/streaming/last-start-error.ts";
import {
	broadcastStreamReadinessIfChanged,
	resetStreamReadinessForTest,
	setReadinessDepsForTest,
} from "../modules/streaming/stream-readiness.ts";
import {
	buildStatusScreenSnapshot,
	resetStatusScreenForTest,
	STATUS_SCREEN_MAX_ENTRIES,
	STATUS_SCREEN_REFRESH_MS,
	type StatusScreenInputs,
	type StatusScreenSnapshot,
	setStatusScreenDepsForTest,
	tickStatusScreenSnapshot,
	writeStatusScreenSnapshot,
} from "../modules/system/status-screen-snapshot.ts";

const NOW = 1_800_000_000_000;

// Values the backend holds that must never reach the screen. Each is planted
// in every free-text slot of the inputs below.
const FORBIDDEN = [
	"live_SECRETKEY_123", // stream key / ID
	"relay.example.net", // destination host
	"HomeWiFi-5G", // Wi-Fi name
	"hunter2pass", // a password
	"351234567890123", // IMEI
	"8949020000012345678", // ICCID
	"+4915112345678", // phone number
	"Huawei E3372", // modem / dongle name
	"Movistar", // operator name
	"wwan0", // interface name
	"segfault in engine", // log or message text
];

function uplink(
	iface: string,
	kind: UplinkHealthRecord["kind"],
	state: UplinkHealthRecord["state"],
): UplinkHealthRecord {
	return {
		iface,
		kind,
		displayName: "Huawei E3372",
		state,
		weight: 100,
		lastTransition: NOW,
		staleAt: NOW + 10_000,
		probes: { successes: 3, failures: 0 },
		signals: { activeAt: NOW },
	};
}

function readiness(code?: string, ready = false): StreamReadiness {
	return {
		ready,
		live: false,
		...(code === undefined ? {} : { reason: { check: "uplinks", code } }),
		checks: [
			{ id: "lock", state: "ok" },
			{ id: "source", state: "ok" },
			{ id: "receiver", state: "unknown", code: "receiver_untested" },
			{ id: "uplinks", state: "blocked", code: "no_uplink_passes" },
		],
		uplinks: { usable: 0, total: 2 },
		at: NOW,
	};
}

const MODEM_TEXT = {
	ifname: "wwan0",
	name: "Huawei E3372",
	sim_network: "Movistar",
	model: "E3372",
	manufacturer: "Huawei",
	imei: "351234567890123",
	iccid: "8949020000012345678",
	own_numbers: ["+4915112345678"],
	config: {
		apn: "internet.movistar",
		username: "HomeWiFi-5G",
		password: "hunter2pass",
	},
	availability_reason: "segfault in engine",
	slot_label: "live_SECRETKEY_123",
};

function inputs(over: Partial<StatusScreenInputs> = {}): StatusScreenInputs {
	return {
		now: NOW,
		version: "2026.11.21",
		readiness: readiness("no_uplink_passes"),
		readinessAgeMs: 0,
		uplinks: [
			uplink("wwan1", "cellular", "degraded"),
			uplink("eth0", "ethernet", "down"),
			uplink("wwan0", "cellular", "up"),
		],
		modems: {
			"2": { ...MODEM_TEXT, sim_presence: "absent" },
			"0": { ...MODEM_TEXT, sim_presence: "present" },
			"1": {
				...MODEM_TEXT,
				sim_presence: "present",
				sim_lock: { required: "sim-pin", remainingAttempts: 3 },
			},
			"10": { ...MODEM_TEXT, device_class: "router-ethernet" },
		} as unknown as StatusScreenInputs["modems"],
		lastError: { code: "start_timeout", at: NOW - 5_000 },
		...over,
	};
}

const ALLOWED_KEYS = new Set([
	"schema",
	"expires",
	"ceraui",
	"uplinks",
	"kind",
	"state",
	"modems",
	"sim",
	"ready",
	"code",
	"last_error",
	"at",
]);
const ALLOWED_STRINGS = new Set([
	"cellular",
	"ethernet",
	"wifi",
	"other",
	"up",
	"degraded",
	"down",
	"present",
	"absent",
	"locked",
	"unknown",
]);

/** Every key is allowlisted and every string is an enum value or a checked token. */
function assertOnlyAllowlisted(value: unknown, key = ""): void {
	if (Array.isArray(value)) {
		for (const item of value) assertOnlyAllowlisted(item, key);
	} else if (typeof value === "object" && value !== null) {
		for (const [k, v] of Object.entries(value)) {
			expect(ALLOWED_KEYS.has(k)).toBe(true);
			assertOnlyAllowlisted(v, k);
		}
	} else if (typeof value === "string") {
		if (key === "code") expect(value).toMatch(/^[A-Za-z0-9_]{1,48}$/);
		else if (key === "ceraui") expect(value).toMatch(/^[0-9.+~A-Za-z-]+$/);
		else expect(ALLOWED_STRINGS.has(value)).toBe(true);
	} else {
		expect(["number", "boolean"]).toContain(typeof value);
	}
}

beforeEach(() => {
	resetStatusScreenForTest();
	resetLastStartErrorForTest();
	resetStreamReadinessForTest();
});
afterEach(() => {
	resetStatusScreenForTest();
	resetLastStartErrorForTest();
	resetStreamReadinessForTest();
});

test("the snapshot carries the contract's fields in a stable order", () => {
	expect(buildStatusScreenSnapshot(inputs())).toEqual({
		schema: 2,
		expires: Math.floor(NOW / 1000) + 90,
		ceraui: "2026.11.21",
		uplinks: [
			{ kind: "ethernet", state: "down" },
			{ kind: "cellular", state: "up" },
			{ kind: "cellular", state: "degraded" },
		],
		modems: [{ sim: "present" }, { sim: "locked" }, { sim: "absent" }],
		ready: { ready: false, code: "no_uplink_passes" },
		last_error: { code: "start_timeout", at: Math.floor(NOW / 1000) - 5 },
	});
});

test("no backend text reaches the snapshot: names, keys, hosts, numbers, messages", () => {
	const planted = inputs({
		uplinks: FORBIDDEN.map((text, i) => ({
			...uplink(text, "wifi", "up"),
			displayName: text,
			ssid: text,
			index: i,
		})) as unknown as UplinkHealthRecord[],
		readiness: {
			...readiness("no_uplink"),
			destination: "relay.example.net",
			streamKey: "live_SECRETKEY_123",
		} as unknown as StreamReadiness,
		lastError: {
			code: "engine_internal",
			at: NOW,
			message: "segfault in engine",
		} as unknown as StatusScreenInputs["lastError"],
	});
	const snapshot = buildStatusScreenSnapshot(planted);
	const text = JSON.stringify(snapshot);
	for (const secret of FORBIDDEN) expect(text).not.toContain(secret);
	assertOnlyAllowlisted(snapshot);
});

test("codes that are not plain tokens are dropped, never passed on", () => {
	for (const bad of [
		"rtmp://relay.example.net/live_SECRETKEY_123",
		"relay.example.net",
		"HomeWiFi-5G",
		"code with spaces",
		"x".repeat(49),
		"",
		"١٢",
	]) {
		const snapshot = buildStatusScreenSnapshot(
			inputs({
				readiness: readiness(bad),
				lastError: { code: bad, at: NOW },
			}),
		);
		expect(snapshot.ready).toEqual({ ready: false, code: "other" });
		expect(snapshot.last_error).toBeUndefined();
		expect(JSON.stringify(snapshot)).not.toContain(bad || '""code');
	}
});

test("only the numeric release part of the version is passed on", () => {
	for (const [stamp, shown] of [
		["2026.11.21", "2026.11.21"],
		["1.2.3", "1.2.3"],
		["2026.11.21-osb", "2026.11.21"],
		["2026.11.21-1.abc1234", "2026.11.21"],
		["2026.11.21-hunter2pass", "2026.11.21"],
		["2026.11.21 (abc1234)", "2026.11.21"],
	])
		expect(buildStatusScreenSnapshot(inputs({ version: stamp })).ceraui).toBe(
			shown,
		);
	for (const bad of [
		"abc1234",
		"2026",
		"live_SECRETKEY_123",
		"\u0662\u0660\u0662\u0666.\u0661\u0661",
		"2026.11.21x",
		"12345.1.1",
		undefined,
	])
		expect(
			"ceraui" in buildStatusScreenSnapshot(inputs({ version: bad })),
		).toBe(false);
});

test("SIM states: lock first, then positive presence, else unknown; router dongles skipped", () => {
	const modems = {
		"0": { sim_lock: { required: "sim-puk" }, sim_presence: "present" },
		"1": { sim_lock: { required: "sim-pin2" }, sim_presence: "present" },
		"2": { sim_lock: { required: "none" } },
		"3": { no_sim: true },
		"4": { device_class: "router-ethernet", sim_presence: "present" },
		"5": { sim_presence: "absent" },
	} as unknown as StatusScreenInputs["modems"];
	expect(buildStatusScreenSnapshot(inputs({ modems })).modems).toEqual([
		{ sim: "locked" },
		{ sim: "present" },
		{ sim: "unknown" },
		{ sim: "unknown" },
		{ sim: "absent" },
	]);
});

test("lists are capped, invalid kinds and states dropped, readiness optional", () => {
	const many = Array.from({ length: 12 }, (_, i) =>
		uplink(`eth${i}`, "ethernet", "up"),
	);
	const odd = [
		{ ...uplink("x0", "ethernet", "up"), kind: "satellite" },
		{ ...uplink("x1", "ethernet", "up"), state: "great" },
	] as unknown as UplinkHealthRecord[];
	const snapshot = buildStatusScreenSnapshot(
		inputs({
			uplinks: [...odd, ...many],
			readiness: undefined,
			lastError: undefined,
		}),
	);
	expect(snapshot.uplinks).toHaveLength(STATUS_SCREEN_MAX_ENTRIES);
	expect(snapshot.uplinks.every((u) => u.kind === "ethernet")).toBe(true);
	expect("ready" in snapshot).toBe(false);
	expect("last_error" in snapshot).toBe(false);
	const ready = buildStatusScreenSnapshot(
		inputs({ readiness: readiness(undefined, true) }),
	);
	expect(ready.ready).toEqual({ ready: true });
});

test("expires is integer seconds within the hour the page accepts", () => {
	const snapshot = buildStatusScreenSnapshot(inputs({ now: NOW + 123 }));
	expect(Number.isInteger(snapshot.expires)).toBe(true);
	expect(snapshot.expires).toBeGreaterThan((NOW + 123) / 1000);
	expect(snapshot.expires).toBeLessThanOrEqual((NOW + 123) / 1000 + 3600);
});

test("the last start error is the class only, cleared by a start that succeeds", () => {
	const failed = {
		result: "failed",
		attemptId: "a1",
		failure: {
			attemptId: "a1",
			phase: "connect",
			class: "engine_unavailable",
			message: "relay.example.net refused live_SECRETKEY_123",
			retriable: true,
		},
	} as StartResult;
	noteStartResult(failed, NOW);
	expect(lastStartError()).toEqual({ code: "engine_unavailable", at: NOW });
	noteStartResult({ result: "busy", attemptId: "a2" });
	expect(lastStartError()?.code).toBe("engine_unavailable");
	noteStartResult({ result: "started", attemptId: "a3" });
	expect(lastStartError()).toBeUndefined();
});

test("codes outside the supported sets never pass, even when token-shaped", () => {
	for (const secret of [
		"live_SECRETKEY_123",
		"351234567890123",
		"HomeWiFi5G",
	]) {
		const snapshot = buildStatusScreenSnapshot(
			inputs({
				readiness: readiness(secret),
				lastError: { code: secret, at: NOW },
			}),
		);
		expect(JSON.stringify(snapshot)).not.toContain(secret);
		expect(snapshot.ready).toEqual({ ready: false, code: "other" });
		expect(snapshot.last_error).toBeUndefined();
	}
	for (const code of [
		"MODEM_TRANSITION_ACTIVE",
		"receiver_refused",
		"no_link_carrying",
	])
		expect(
			buildStatusScreenSnapshot(inputs({ readiness: readiness(code) })).ready,
		).toEqual({
			ready: false,
			code,
		});
	for (const code of [
		"engine_unavailable",
		"capture_source_unavailable",
		"update_in_progress",
	])
		expect(
			buildStatusScreenSnapshot(inputs({ lastError: { code, at: NOW } }))
				.last_error?.code,
		).toBe(code);
});

test("a readiness answer older than 10 s is left out, not shown as current", () => {
	const ready = readiness(undefined, true);
	expect(
		buildStatusScreenSnapshot(
			inputs({ readiness: ready, readinessAgeMs: 10_000 }),
		).ready,
	).toEqual({ ready: true });
	expect(
		"ready" in
			buildStatusScreenSnapshot(
				inputs({ readiness: ready, readinessAgeMs: 10_001 }),
			),
	).toBe(false);
});

test("readiness is aged by its monotonic evaluation stamp, never by its wall-clock time", () => {
	// Evaluated before a two-hour backward step: its wall time is now in the future.
	const ahead = { ...readiness(undefined, true), at: NOW + 2 * 3_600_000 };
	expect(
		"ready" in
			buildStatusScreenSnapshot(
				inputs({ readiness: ahead, readinessAgeMs: 10_001 }),
			),
	).toBe(false);
	// Evaluated just now, before a forward step: its wall time looks old.
	const behind = { ...readiness(undefined, true), at: NOW - 3_600_000 };
	expect(
		buildStatusScreenSnapshot(
			inputs({ readiness: behind, readinessAgeMs: 2_000 }),
		).ready,
	).toEqual({ ready: true });
	// An age that cannot be measured is no answer.
	for (const age of [-1, Number.NaN, Number.POSITIVE_INFINITY])
		expect(
			"ready" in
				buildStatusScreenSnapshot(
					inputs({ readiness: behind, readinessAgeMs: age }),
				),
		).toBe(false);
});

// ─── File ────────────────────────────────────────────────────────────────────

const temporary: string[] = [];
afterEach(() => {
	for (const dir of temporary.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "status-screen-"));
	temporary.push(dir);
	return dir;
}

test("written atomically as 0644 JSON in a directory nobody else may write", () => {
	const root = tempDir();
	const file = join(root, "status-screen", "snapshot.json");
	const snapshot = buildStatusScreenSnapshot(inputs());
	writeStatusScreenSnapshot(snapshot, file);
	writeStatusScreenSnapshot(snapshot, file);
	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(snapshot);
	expect(lstatSync(file).mode & 0o777).toBe(0o644);
	expect(lstatSync(join(root, "status-screen")).mode & 0o022).toBe(0);
	expect(readdirSync(join(root, "status-screen"))).toEqual(["snapshot.json"]);
});

test("a leftover snapshot with other permissions ends up 0644", () => {
	const root = tempDir();
	const file = join(root, "snapshot.json");
	writeFileSync(file, "{}", { mode: 0o600 });
	chmodSync(file, 0o600);
	writeStatusScreenSnapshot(buildStatusScreenSnapshot(inputs()), file);
	expect(lstatSync(file).mode & 0o777).toBe(0o644);
});

test("refuses a symlinked or shared directory and a symlinked file", () => {
	const root = tempDir();
	const real = join(root, "real");
	mkdirSync(real);
	symlinkSync(real, join(root, "link"));
	const snapshot = buildStatusScreenSnapshot(inputs());
	expect(() =>
		writeStatusScreenSnapshot(snapshot, join(root, "link", "s.json")),
	).toThrow();
	expect(readdirSync(real)).toEqual([]);
	const shared = join(root, "shared");
	mkdirSync(shared);
	chmodSync(shared, 0o777);
	expect(() =>
		writeStatusScreenSnapshot(snapshot, join(shared, "s.json")),
	).toThrow();
	expect(readdirSync(shared)).toEqual([]);
	const own = join(root, "own");
	mkdirSync(own, { mode: 0o755 });
	writeFileSync(join(root, "elsewhere"), "keep");
	symlinkSync(join(root, "elsewhere"), join(own, "s.json"));
	expect(() =>
		writeStatusScreenSnapshot(snapshot, join(own, "s.json")),
	).toThrow();
	expect(readFileSync(join(root, "elsewhere"), "utf8")).toBe("keep");
});

test("an oversized snapshot is refused rather than truncated", () => {
	const root = tempDir();
	const huge = {
		...buildStatusScreenSnapshot(inputs()),
		uplinks: Array.from({ length: 2000 }, () => ({
			kind: "ethernet",
			state: "up",
		})),
	} as StatusScreenSnapshot;
	expect(() => writeStatusScreenSnapshot(huge, join(root, "s.json"))).toThrow(
		/too large/,
	);
	expect(readdirSync(root)).toEqual([]);
});

// ─── Loop ────────────────────────────────────────────────────────────────────

test("rewritten on change and for refresh, not every tick; failures retried", () => {
	let now = NOW;
	let ready = readiness("no_uplink_passes");
	let fail = false;
	const written: StatusScreenSnapshot[] = [];
	setStatusScreenDepsForTest({
		now: () => now,
		monotonic: () => now,
		version: () => "2026.11.21",
		readiness: () => ({ readiness: { ...ready, at: now }, evaluatedAt: now }),
		uplinks: () => [],
		modems: () => ({}),
		lastError: () => undefined,
		write: (snapshot) => {
			if (fail) throw new Error("read-only");
			written.push(snapshot);
		},
	});
	expect(tickStatusScreenSnapshot()).toBe(true);
	now += 2_000;
	expect(tickStatusScreenSnapshot()).toBe(false);
	ready = readiness(undefined, true);
	expect(tickStatusScreenSnapshot()).toBe(true);
	now += STATUS_SCREEN_REFRESH_MS;
	fail = true;
	expect(tickStatusScreenSnapshot()).toBe(false);
	expect(tickStatusScreenSnapshot()).toBe(false);
	fail = false;
	expect(tickStatusScreenSnapshot()).toBe(true);
	expect(written.map((s) => s.ready?.ready)).toEqual([false, true, true]);
	expect(written[2]?.expires).toBeGreaterThan(written[1]?.expires ?? 0);
});

test("a clock step forces a fresh expiry; the refresh interval runs on monotonic time", () => {
	let wall = NOW;
	let mono = 1_000;
	const written: StatusScreenSnapshot[] = [];
	setStatusScreenDepsForTest({
		now: () => wall,
		monotonic: () => mono,
		version: () => "2026.11.21",
		readiness: () => undefined,
		uplinks: () => [],
		modems: () => ({}),
		lastError: () => undefined,
		write: (snapshot) => written.push(snapshot),
	});
	expect(tickStatusScreenSnapshot()).toBe(true);
	// Two hours back: the written expiry is now far beyond the reader's hour.
	wall -= 2 * 3_600_000;
	mono += 2_000;
	expect(tickStatusScreenSnapshot()).toBe(true);
	expect(written[1]?.expires).toBe(Math.floor((wall + 90_000) / 1000));
	// Ten minutes forward: the old expiry would already have passed.
	wall += 600_000;
	mono += 2_000;
	expect(tickStatusScreenSnapshot()).toBe(true);
	// Steady: nothing until 30 s of monotonic time, whatever small jitter the wall clock has.
	wall += 2_500;
	mono += 2_000;
	expect(tickStatusScreenSnapshot()).toBe(false);
	wall += 28_000;
	mono += 28_000;
	expect(tickStatusScreenSnapshot()).toBe(true);
	expect(written).toHaveLength(4);
});

test("a clock step back while readiness evaluation throws does not keep the last verdict alive", () => {
	let wall = NOW;
	let mono = 1_000;
	let failing = false;
	setReadinessDepsForTest({
		now: () => wall,
		monotonic: () => mono,
		live: () => {
			if (failing) throw new Error("readiness source broken");
			return true;
		},
		senderLinks: () => [{ iface: "wwan0", carrying: true }],
	});
	const written: StatusScreenSnapshot[] = [];
	setStatusScreenDepsForTest({
		now: () => wall,
		monotonic: () => mono,
		version: () => "2026.11.21",
		uplinks: () => [],
		modems: () => ({}),
		lastError: () => undefined,
		write: (snapshot) => written.push(snapshot),
	});
	broadcastStreamReadinessIfChanged();
	expect(tickStatusScreenSnapshot()).toBe(true);
	expect(written.at(-1)?.ready).toEqual({ ready: true });
	// Two hours back, and every evaluation from now on throws.
	failing = true;
	wall -= 2 * 3_600_000;
	mono += 2_000;
	expect(() => broadcastStreamReadinessIfChanged()).toThrow();
	expect(tickStatusScreenSnapshot()).toBe(true); // the step forces a write
	expect(written.at(-1)?.ready).toEqual({ ready: true }); // 2 s old: still current
	for (let i = 0; i < 5; i++) {
		wall += 2_000;
		mono += 2_000;
		expect(() => broadcastStreamReadinessIfChanged()).toThrow();
		tickStatusScreenSnapshot();
	}
	// 12 s since the last evaluation that worked: no verdict, not a stale yes.
	expect("ready" in (written.at(-1) ?? {})).toBe(false);
	expect(written.at(-1)?.expires).toBe(Math.floor((wall + 90_000) / 1000));
	failing = false;
	wall += 2_000;
	mono += 2_000;
	broadcastStreamReadinessIfChanged();
	expect(tickStatusScreenSnapshot()).toBe(true);
	expect(written.at(-1)?.ready).toEqual({ ready: true });
});
