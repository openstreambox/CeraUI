/*
  Sender address adoption against a real SRT session, in a private namespace.

  Topology (synthetic addresses only): two veth uplinks, wan0 (198.51.100.1, the
  "wired" link) and wan1 (192.0.2.x, the "mobile" link), into a peer namespace
  that runs the BELABOX receiver and an SRT listener. An ffmpeg SRT caller
  stands in for the engine and sends into the real standalone sender. The
  listener appends what it receives to sink.ts and restarts after each session,
  so a second session is visible as a second "session" line.

  The production adoption check, /proc reader, carry tracker, offer and restart
  paths run unmodified; only their process hooks point at this rig.

  Scenarios:
    withheld-hup   first HUP withheld; the one retry adopts the new address
    offer          both HUPs withheld, the wired link carrying: the notice only,
                   and nothing restarts on its own
    tap            the offer's tap: a full restart, the session resumes with
                   every link carrying
    single-link    the only link stuck: one automatic restart, announced after
                   the new session started; a repeat is held by the cooldown
    control        replacing only the sender while the caller keeps its SRT
                   session (a sender-only replacement): does the session survive?

  Run as root inside the PID/mount/network gate:
    CERALIVE_NETNS_ISOLATED=1 SRTLA_SEND_BIN=... SRTLA_REC_BIN=... \
      FFMPEG_BIN=... PROOF_OUTPUT=<dir> bun test-harness/sender-reload/netns.ts
*/
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
	type ConnectionRestartDeps,
	createAutoRestart,
	requestConnectionRestart,
} from "../../src/modules/streaming/connection-restart.ts";
import { createCarryTracker } from "../../src/modules/streaming/link-carrying.ts";
import type { LinkTelemetryMessage } from "../../src/modules/streaming/link-telemetry-rows.ts";
import {
	createObservationFailureLog,
	SENDER_STOP_HOLD_MS,
	verifySenderReload,
	waitForReload,
} from "../../src/modules/streaming/sender-reload.ts";
import { senderSocketSources } from "../../src/modules/streaming/sender-sockets.ts";
import {
	createStaleLinkNotice,
	staleSourceResponse,
} from "../../src/modules/streaming/stale-link-notice.ts";

assert.equal(process.env.CERALIVE_NETNS_ISOLATED, "1");
assert.equal(process.getuid?.(), 0);
const SENDER = process.env.SRTLA_SEND_BIN ?? "";
const RECEIVER = process.env.SRTLA_REC_BIN ?? "";
const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const OUT = process.env.PROOF_OUTPUT ?? "";
assert.ok(SENDER && RECEIVER && OUT, "SRTLA_SEND_BIN, SRTLA_REC_BIN, PROOF_OUTPUT");
const only = process.argv[2];

const sh = (...args: string[]) => execFileSync(args[0] ?? "", args.slice(1));
const sleep = (ms: number) => Bun.sleep(ms);
const results: Record<string, unknown> = {};

/** `gateway`: the peer end of the link's veth, in the same documentation range. */
type Link = { id: string; iface: string; ip: string; gateway: string };

class Rig {
	readonly dir: string;
	private peer: Subprocess | undefined;
	private procs: Subprocess[] = [];
	sender: Subprocess | undefined;
	caller: Subprocess | undefined;
	links: Link[] = [];
	generation = 0;
	/** The device's view: the session is owned until Stop, even if SRT broke. */
	active = false;
	readonly log: string[] = [];

	constructor(readonly name: string) {
		this.dir = join(OUT, name);
		mkdirSync(this.dir, { recursive: true });
	}

	private spawn(cmd: string[], logName: string): Subprocess {
		const file = Bun.file(join(this.dir, `${logName}.log`));
		const proc = Bun.spawn(cmd, { stdout: file, stderr: file });
		this.procs.push(proc);
		return proc;
	}

	private inPeer(...cmd: string[]): string[] {
		return ["nsenter", "-t", String(this.peer?.pid), "-n", "--", ...cmd];
	}

	async up(links: Link[]) {
		sh("ip", "link", "set", "lo", "up");
		const peerProc = this.spawn(["unshare", "-n", "sleep", "600"], "peer");
		this.peer = peerProc;
		await sleep(200);
		const peer = (...a: string[]) => sh(...this.inPeer(...a));
		peer("ip", "link", "set", "lo", "up");
		peer("ip", "addr", "add", "203.0.113.1/32", "dev", "lo");
		for (const [i, link] of links.entries()) {
			const n = link.iface.slice(-1);
			sh("ip", "link", "add", link.iface, "type", "veth", "peer", "name", `srv${n}`);
			sh("ip", "link", "set", `srv${n}`, "netns", String(peerProc.pid));
			sh("ip", "link", "set", link.iface, "up");
			peer("ip", "link", "set", `srv${n}`, "up");
			sh("ip", "addr", "add", `${link.ip}/24`, "dev", link.iface);
			peer("ip", "addr", "add", `${link.gateway}/24`, "dev", `srv${n}`);
			sh("ip", "route", "add", "default", "via", link.gateway, "dev", link.iface, "metric", String(100 + i));
		}
		this.links = links;
		this.spawn(this.inPeer(RECEIVER, "9000", "203.0.113.1", "9002"), "receiver");
		const sink = join(this.dir, "sink.ts");
		writeFileSync(sink, "");
		this.spawn(
			this.inPeer(
				"bash",
				"-c",
				`while true; do echo session >> ${this.dir}/sessions; ${FFMPEG} -hide_banner -loglevel warning -y -i 'srt://203.0.113.1:9002?mode=listener&latency=200000' -c copy -flush_packets 1 -f mpegts pipe:1 >> ${sink}; done`,
			),
			"listener",
		);
		await this.publish();
		await this.startSession();
	}

	/** Write the IP list and its bind map, as the backend's writer does. */
	async publish() {
		this.generation++;
		const bytes = this.links.map((link) => `${link.ip}\n`).join("");
		writeFileSync(join(this.dir, "ips"), bytes);
		writeFileSync(
			join(this.dir, "map.json"),
			JSON.stringify({
				schema_version: 1,
				generation: this.generation,
				ips_file_sha256: createHash("sha256").update(bytes).digest("hex"),
				links: this.links.map((link) => ({ link_id: link.id, ip: link.ip, iface: link.iface })),
			}),
			{ mode: 0o600 },
		);
	}

	startSender() {
		this.sender = this.spawn(
			[
				SENDER,
				"9001",
				"203.0.113.1",
				"9000",
				join(this.dir, "ips"),
				"--bind-map",
				join(this.dir, "map.json"),
				"--stats-file",
				join(this.dir, "stats.json"),
			],
			`sender-${this.procs.length}`,
		);
	}

	startCaller() {
		this.caller = this.spawn(
			[
				FFMPEG,
				"-hide_banner",
				"-loglevel",
				"warning",
				"-re",
				"-f",
				"lavfi",
				"-i",
				"testsrc=size=320x180:rate=25",
				"-c:v",
				"mpeg2video",
				"-b:v",
				"1500k",
				"-f",
				"mpegts",
				"srt://127.0.0.1:9001?mode=caller&latency=200000",
			],
			`caller-${this.procs.length}`,
		);
	}

	/** Engine-first Stop, the forwarding hold, then the sender. */
	async stopSession() {
		this.active = false;
		this.caller?.kill("SIGTERM");
		await this.caller?.exited;
		await sleep(SENDER_STOP_HOLD_MS);
		this.sender?.kill("SIGTERM");
		await this.sender?.exited;
	}

	async startSession() {
		this.startSender();
		const deadline = Date.now() + 5000;
		while (!(await this.bound()).length) {
			assert.ok(Date.now() < deadline, "sender must bind its sources");
			await sleep(50);
		}
		this.startCaller();
		this.active = true;
		await sleep(4000);
	}

	async bound(): Promise<string[]> {
		try {
			return await senderSocketSources(this.sender?.pid ?? -1);
		} catch {
			return [];
		}
	}

	sinkBytes(): number {
		return statSync(join(this.dir, "sink.ts")).size;
	}

	sessions(): number {
		try {
			return readFileSync(join(this.dir, "sessions"), "utf8").trim().split("\n").length;
		} catch {
			return 0;
		}
	}

	/** The sender's own per-link telemetry, as the backend reads it. */
	telemetry(): LinkTelemetryMessage | null {
		try {
			const stats = JSON.parse(readFileSync(join(this.dir, "stats.json"), "utf8"));
			const stale = Date.now() - Number(stats.last_updated_ms) > 2000;
			return {
				links: stats.connections.map((c: Record<string, unknown>) => ({ ...c, stale })),
				measured_bps: 0,
				lastReadMs: 0,
			} as LinkTelemetryMessage;
		} catch {
			return null;
		}
	}

	linkBytes(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const row of this.telemetry()?.links ?? []) out[row.iface] = row.bytes_sent_total ?? 0;
		return out;
	}

	/** Same interface, new address: the field's modem renumbering. */
	async renumber(iface: string, next: string) {
		const link = this.links.find((l) => l.iface === iface);
		assert.ok(link);
		sh("ip", "addr", "del", `${link.ip}/24`, "dev", iface);
		sh("ip", "addr", "add", `${next}/24`, "dev", iface);
		link.ip = next;
		await this.publish();
	}

	/** The production check with this rig's sender; `retry` says whether HUP #2 is sent. */
	async check(retry: boolean) {
		const controller = new AbortController();
		const carrying = createCarryTracker(Date.now);
		const failures = createObservationFailureLog();
		let signals = 0;
		const log = (_e: string, meta: Record<string, unknown>) => this.log.push(JSON.stringify(meta));
		const before = Date.now();
		const result = await verifySenderReload(this.generation, this.links.map((l) => l.ip), {
			signal: controller.signal,
			now: Date.now,
			wait: (ms) => waitForReload(ms, controller.signal),
			hup: async () => {
				signals++;
				// The first HUP is always withheld while reporting delivery.
				if (signals > 1 && retry) this.sender?.kill("SIGHUP");
				return true;
			},
			read: async () => {
				carrying.sample(this.telemetry());
				return { sources: await senderSocketSources(this.sender?.pid ?? -1) };
			},
			log,
			observationFailed: (error) => failures.report(error, log),
		});
		const stuck = result.outcome === "stale" ? result.stale.map((ip) => this.ifaceOfOld(ip)) : [];
		return {
			result,
			signals,
			ms: Date.now() - before,
			verdict: carrying.judge(stuck, this.links.map((l) => l.iface)),
		};
	}

	private oldAddresses = new Map<string, string>([
		["192.0.2.1", "wan1"],
		["198.51.100.1", "wan0"],
	]);
	ifaceOfOld(ip: string) {
		return this.oldAddresses.get(ip);
	}

	restartDeps(calls: string[], take: ConnectionRestartDeps["take"]): ConnectionRestartDeps {
		return {
			generation: () => 1,
			take,
			isStreaming: () => this.active,
			captureStopIntent: () => () => true,
			beginRestart: () => {
				calls.push("restarting");
				return () => calls.push("restarted");
			},
			stop: async () => {
				calls.push("stop");
				await this.stopSession();
				return { result: "stopped" };
			},
			start: async () => {
				calls.push("start");
				await this.startSession();
				return { result: "started" };
			},
			announce: () => calls.push("announce"),
			log: (event, meta) => this.log.push(`${event} ${JSON.stringify(meta)}`),
		};
	}

	async down() {
		for (const proc of this.procs.reverse()) proc.kill("SIGKILL");
		for (const proc of this.procs) await proc.exited;
		for (const iface of ["wan0", "wan1"])
			try {
				sh("ip", "link", "del", iface);
			} catch {}
		writeFileSync(join(this.dir, "check.log"), this.log.join("\n"));
	}
}

const WIRED: Link = { id: "wired", iface: "wan0", ip: "198.51.100.1", gateway: "198.51.100.2" };
const MOBILE: Link = { id: "mobile", iface: "wan1", ip: "192.0.2.1", gateway: "192.0.2.2" };

async function growth(rig: Rig, ms: number) {
	const before = rig.sinkBytes();
	await sleep(ms);
	return rig.sinkBytes() - before;
}

async function scenario(name: string, run: (rig: Rig) => Promise<void>) {
	if (only && only !== name) return;
	const rig = new Rig(name);
	try {
		await run(rig);
		console.log("PASS", name, JSON.stringify(results[name]));
	} finally {
		await rig.down();
	}
}

await scenario("withheld-hup", async (rig) => {
	await rig.up([{ ...WIRED }, { ...MOBILE }]);
	const pid = rig.sender?.pid;
	const caller = rig.caller?.pid;
	await rig.renumber("wan1", "192.0.2.3");
	const check = await rig.check(true);
	assert.deepEqual(check.result, { outcome: "adopted" });
	assert.equal(check.signals, 2);
	assert.equal(rig.sender?.pid, pid, "same sender PID");
	assert.equal(rig.caller?.pid, caller, "same SRT session");
	// The re-added socket starts a fresh counter; stock 4.1.0 needs a while to
	// register it with the existing group, so allow it time.
	const bytes = rig.linkBytes();
	const grew = await growth(rig, 25_000);
	const after = rig.linkBytes();
	assert.ok(grew > 100_000, "the SRT session keeps delivering");
	assert.ok((after.wan1 ?? 0) > (bytes.wan1 ?? 0), "the renumbered link carries again");
	assert.equal(rig.sessions(), 1);
	results["withheld-hup"] = { ...check, bound: await rig.bound(), sinkGrowth25s: grew, wan1: [bytes.wan1, after.wan1] };
});

let tapToken: string | undefined;
await scenario("offer", async (rig) => {
	await rig.up([{ ...WIRED }, { ...MOBILE }]);
	const pid = rig.sender?.pid;
	const caller = rig.caller?.pid;
	await rig.renumber("wan1", "192.0.2.3");
	const check = await rig.check(false);
	assert.deepEqual(check.result, { outcome: "stale", stale: ["192.0.2.1"] });
	assert.equal(check.verdict, "others_carrying");
	assert.equal(staleSourceResponse(check.verdict), "offer");
	const shown: unknown[] = [];
	const notice = createStaleLinkNotice({
		now: Date.now,
		token: () => "proof-token",
		show: (n) => shown.push(n),
		remove: () => {},
		log: () => {},
	});
	notice.offer(1, { count: 1, name: "mobile", othersCarrying: true });
	// Nothing restarts on its own: same processes, one session, still delivering.
	const grew = await growth(rig, 15_000);
	assert.equal(rig.sender?.pid, pid);
	assert.equal(rig.caller?.pid, caller);
	assert.equal(rig.sessions(), 1);
	assert.ok(grew > 100_000, "the wired link carries the stream");
	results.offer = { ...check, shown, sinkGrowth15s: grew, sessions: rig.sessions() };

	// The tap, on the same rig: a full, supervised restart.
	tapToken = "proof-token";
	const calls: string[] = [];
	const before = rig.linkBytes();
	const request = requestConnectionRestart(tapToken, rig.restartDeps(calls, notice.take));
	assert.deepEqual(request.output, { success: true, result: "restarting" });
	assert.equal(await request.done, "started");
	assert.deepEqual(calls, ["restarting", "stop", "start", "restarted"]);
	const first = rig.linkBytes();
	const resumed = await growth(rig, 8000);
	const later = rig.linkBytes();
	assert.ok(resumed > 100_000, "the new session delivers");
	// The first SRT session ended and the listener took the new one.
	assert.equal(rig.sessions(), 2);
	assert.deepEqual((await rig.bound()).sort(), ["192.0.2.3", "198.51.100.1"]);
	for (const iface of ["wan0", "wan1"])
		assert.ok((later[iface] ?? 0) > (first[iface] ?? 0), `${iface} carries after the restart`);
	assert.deepEqual(requestConnectionRestart(tapToken, rig.restartDeps(calls, notice.take)).output, {
		success: false,
		result: "refused",
		error: "offer_not_current",
	});
	results.tap = { calls, sinkGrowth8s: resumed, sessions: rig.sessions(), before, first, later, bound: await rig.bound() };
});

await scenario("single-link", async (rig) => {
	await rig.up([{ ...MOBILE }]);
	await rig.renumber("wan1", "192.0.2.3");
	const check = await rig.check(false);
	assert.deepEqual(check.result, { outcome: "stale", stale: ["192.0.2.1"] });
	assert.equal(check.verdict, "none_carrying");
	assert.equal(staleSourceResponse(check.verdict), "restart");
	const stalled = await growth(rig, 3000);
	const restarts = createAutoRestart(Date.now);
	const calls: string[] = [];
	const deps = rig.restartDeps(calls, () => undefined);
	const request = restarts.request(1, deps);
	assert.equal(request.result, "restarting");
	assert.equal(await request.done, "started");
	assert.deepEqual(calls, ["restarting", "stop", "start", "restarted", "announce"]);
	const resumed = await growth(rig, 8000);
	assert.ok(resumed > 100_000, "the restarted session delivers");
	assert.equal(rig.sessions(), 2);
	assert.equal(restarts.request(1, deps).result, "held", "cooldown");
	assert.deepEqual(calls, ["restarting", "stop", "start", "restarted", "announce"]);
	results["single-link"] = { ...check, stalledGrowth3s: stalled, calls, sinkGrowth8s: resumed, bound: await rig.bound() };
});

/** Sink growth per second, and when the SRT caller exited (ms from start). */
async function trace(rig: Rig, seconds: number) {
	const perSecond: number[] = [];
	const start = Date.now();
	let callerExitMs: number | undefined;
	void rig.caller?.exited.then(() => {
		callerExitMs = Date.now() - start;
	});
	for (let i = 0; i < seconds; i++) perSecond.push(await growth(rig, 1000));
	return { perSecond, callerExitMs };
}

await scenario("control", async (rig) => {
	await rig.up([{ ...WIRED }, { ...MOBILE }]);
	const before = await trace(rig, 8);
	// What the earlier draft did: a new sender process, the caller untouched.
	rig.sender?.kill("SIGTERM");
	await rig.sender?.exited;
	rig.startSender();
	const after = await trace(rig, 15);
	results.control = {
		before,
		afterReplacement: after,
		listenerSessions: rig.sessions(),
		sessionSurvived:
			after.callerExitMs === undefined && after.perSecond.slice(-5).every((b) => b > 0),
	};
});

writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
