/**
 * The real default OS surface of the Tailscale module, against fakes of the
 * outside world: a fake tailscaled local API on a unix socket (real `fetch`),
 * recorded argv for every command, and a temporary state directory for the
 * image enrolment hand-off.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as commands from "../helpers/run.ts";
import {
	ENROLL_UNIT,
	getDefaultTailscaleDepsForTest,
} from "../modules/system/tailscale.ts";

const KEY = "tskey-auth-kDEFAULTS0000-0123456789abcdefDEFAULTS";

type Seen = { method: string; path: string; headers: Headers; body: string };

let dir = "";
let server: ReturnType<typeof Bun.serve> | undefined;
const env = { ...process.env };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ts-defaults-"));
	process.env.CERALIVE_TAILSCALE_SOCKET = join(dir, "ts.sock");
	process.env.CERALIVE_TAILSCALE_STATE_DIR = join(dir, "state");
});
afterEach(() => {
	server?.stop(true);
	server = undefined;
	for (const key of [
		"CERALIVE_TAILSCALE_SOCKET",
		"CERALIVE_TAILSCALE_STATE_DIR",
	]) {
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}
	rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake local API. `prefs` is what GET prefs returns; after login-interactive
 * the bus emits `answer` (one notification).
 */
function fakeLocalApi(
	prefs: Record<string, unknown>,
	answer: Record<string, unknown>,
) {
	const seen: Seen[] = [];
	let emit: ((line: string) => void) | undefined;
	server = Bun.serve({
		unix: process.env.CERALIVE_TAILSCALE_SOCKET as string,
		async fetch(request) {
			const url = new URL(request.url);
			const body = request.method === "POST" ? await request.text() : "";
			seen.push({
				method: request.method,
				path: `${url.pathname}${url.search}`,
				headers: request.headers,
				body,
			});
			if (url.pathname === "/localapi/v0/prefs") return Response.json(prefs);
			if (url.pathname === "/localapi/v0/watch-ipn-bus") {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						const enc = new TextEncoder();
						controller.enqueue(enc.encode(`${JSON.stringify({ State: 2 })}\n`));
						emit = (line) => controller.enqueue(enc.encode(`${line}\n`));
					},
				});
				return new Response(stream);
			}
			if (url.pathname === "/localapi/v0/start")
				return new Response(null, { status: 204 });
			if (url.pathname === "/localapi/v0/login-interactive") {
				setTimeout(() => emit?.(JSON.stringify(answer)), 5);
				return new Response(null, { status: 204 });
			}
			return new Response("not found", { status: 404 });
		},
	});
	return seen;
}

function startBody(seen: Seen[]) {
	const start = seen.find((s) => s.path === "/localapi/v0/start");
	if (!start) throw new Error("no start request");
	return JSON.parse(start.body) as {
		AuthKey: string;
		UpdatePrefs: Record<string, unknown>;
	};
}

const CONFIGURED = {
	ControlURL: "https://control.example",
	Hostname: "box1",
	RunSSH: true,
	CorpDNS: false,
	WantRunning: false,
	LoggedOut: false,
	AdvertiseTags: ["tag:box"],
};

describe("join through the local API", () => {
	test("keeps every current pref and sends the key only in the start body", async () => {
		const seen = fakeLocalApi(CONFIGURED, { State: 6 });
		const outcome = await getDefaultTailscaleDepsForTest().apiJoin(KEY, {
			Hostname: "other",
		});
		expect(outcome).toBe("joined");
		const body = startBody(seen);
		expect(body.AuthKey).toBe(KEY);
		// A logged-in device keeps its prefs as they are, remembered or not.
		expect(body.UpdatePrefs).toEqual({ ...CONFIGURED, WantRunning: true });
		expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
			"GET /localapi/v0/prefs",
			"GET /localapi/v0/watch-ipn-bus?mask=0",
			"POST /localapi/v0/start",
			"POST /localapi/v0/login-interactive",
		]);
		for (const s of seen) {
			expect(s.headers.get("sec-tailscale")).toBe("localapi");
			expect(s.path).not.toContain(KEY);
			if (!s.path.endsWith("/start")) expect(s.body).not.toContain(KEY);
		}
	});

	test("a logged-out device gets the remembered prefs back", async () => {
		const seen = fakeLocalApi(
			{
				ControlURL: "",
				Hostname: "",
				RunSSH: false,
				CorpDNS: true,
				LoggedOut: true,
			},
			{ State: 3 },
		);
		const outcome = await getDefaultTailscaleDepsForTest().apiJoin(KEY, {
			ControlURL: "https://control.example",
			Hostname: "box1",
			RunSSH: true,
			CorpDNS: true,
		});
		expect(outcome).toBe("approval");
		expect(startBody(seen).UpdatePrefs).toEqual({
			ControlURL: "https://control.example",
			Hostname: "box1",
			RunSSH: true,
			CorpDNS: true,
			LoggedOut: false,
			WantRunning: true,
		});
	});

	test("a first join leaves the box's DNS alone", async () => {
		const seen = fakeLocalApi({ CorpDNS: true, LoggedOut: true }, { State: 6 });
		await getDefaultTailscaleDepsForTest().apiJoin(KEY, undefined);
		expect(startBody(seen).UpdatePrefs.CorpDNS).toBe(false);
	});

	test("an error from the control server is a refusal", async () => {
		fakeLocalApi(CONFIGURED, {
			ErrMessage: "invalid key: unable to validate API key",
		});
		expect(await getDefaultTailscaleDepsForTest().apiJoin(KEY, undefined)).toBe(
			"refused",
		);
	});

	test("a login URL is never followed, and counts as a refusal", async () => {
		fakeLocalApi(CONFIGURED, { BrowseToURL: "https://login.example/a/abc" });
		expect(await getDefaultTailscaleDepsForTest().apiJoin(KEY, undefined)).toBe(
			"refused",
		);
	});
});

describe("CLI calls", () => {
	test("reconnect is a flag-less up, so the device's prefs are kept", async () => {
		const runs: string[][] = [];
		const spy = spyOn(commands, "run").mockImplementation(async (bin, args) => {
			runs.push([bin, ...args]);
			return "";
		});
		try {
			const deps = getDefaultTailscaleDepsForTest();
			await deps.reconnect();
			await deps.down();
			await deps.logout();
			await deps.statusJson();
		} finally {
			spy.mockRestore();
		}
		const socket = `--socket=${process.env.CERALIVE_TAILSCALE_SOCKET}`;
		expect(runs).toEqual([
			["tailscale", socket, "up"],
			["tailscale", socket, "down"],
			["tailscale", socket, "logout"],
			["tailscale", socket, "status", "--json", "--peers=false"],
		]);
	});
});

describe("image enrolment hand-off", () => {
	test("writes the pending key and name privately, resets the back-off, starts the unit", async () => {
		const runs: string[][] = [];
		const spy = spyOn(commands, "run").mockImplementation(async (bin, args) => {
			runs.push([bin, ...args]);
			return "";
		});
		try {
			await getDefaultTailscaleDepsForTest().enrollSubmit(KEY, "box1");
		} finally {
			spy.mockRestore();
		}
		const state = process.env.CERALIVE_TAILSCALE_STATE_DIR as string;
		expect(readFileSync(join(state, "pending-authkey"), "utf8")).toBe(KEY);
		expect(readFileSync(join(state, "pending-hostname"), "utf8")).toBe("box1");
		expect(readFileSync(join(state, "enroll-status"), "utf8")).toBe(
			"pending 0 0 new-key\n",
		);
		for (const name of [
			"pending-authkey",
			"pending-hostname",
			"enroll-status",
		]) {
			expect(statSync(join(state, name)).mode & 0o777).toBe(0o600);
		}
		expect(runs).toEqual([
			["systemctl", "enable", "tailscaled.service"],
			["systemctl", "start", "--no-block", ENROLL_UNIT],
		]);
		for (const argv of runs) expect(argv.join(" ")).not.toContain(KEY);
		const deps = getDefaultTailscaleDepsForTest();
		expect(await deps.enrollPending()).toBe(true);
		expect(await deps.enrollLastStatus()).toBe("pending 0 0 new-key");
	});
});
