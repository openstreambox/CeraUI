/*
  The production wiring of sender address adoption, driven through the real
  session `start` and `stopGeneration` with a fake sender and a fake /proc.

  What it pins, each one because a hand mutant survived without it:
  - a withheld first HUP gets exactly one retry, by the owned PID, and no notice;
  - a source still stale after the retry raises the restart OFFER and nothing
    restarts on its own: no process spawn, no stop, no second start;
  - an unreadable /proc never escalates: no retry and no notice;
  - Stop closes the check at once, before the engine-stop callback runs;
  - the offer belongs to its session: Stop withdraws it and spends its token;
  - after the engine confirms Stop the sender stays up for the 250 ms hold,
    and only while a sender exists;
  - Stop, or a newer publication, landing during the label lookup or the
    restart wiring cancels what the older check would have done;
  - the device's own restart starts with its own origin, and the status says
    the connection is restarting while it runs;
  - a restart whose Start does not run says so once the status has dropped,
    and is never announced as restarted;
  - with both cooldowns running, a stuck link nothing else covers still gets
    the notice, and no second restart.
*/

import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import WebSocket from "ws";

import * as netif from "../modules/network/network-interfaces.ts";
import * as usbScan from "../modules/network/router-cellular-scan.ts";
import type { BindMapPublication } from "../modules/streaming/bind-map-writer.ts";
import * as restart from "../modules/streaming/connection-restart.ts";
import { autoRestart } from "../modules/streaming/connection-restart.ts";
import {
	isConnectionRestarting,
	resetConnectionRestartingForTest,
} from "../modules/streaming/connection-restarting.ts";
import * as labels from "../modules/streaming/link-label.ts";
import * as telemetry from "../modules/streaming/link-telemetry.ts";
import type { LinkTelemetryMessage } from "../modules/streaming/link-telemetry-rows.ts";
import { noteOperatorStopIntent } from "../modules/streaming/operator-stop-intent.ts";
import * as sockets from "../modules/streaming/sender-sockets.ts";
import * as srtla from "../modules/streaming/srtla.ts";
import {
	STALE_LINK_NOTICE,
	staleLinkNotice,
} from "../modules/streaming/stale-link-notice.ts";
import {
	getStreamReconnectStatus,
	resetStreamReconnectForTest,
} from "../modules/streaming/stream-reconnect-wiring.ts";
import * as owner from "../modules/streaming/stream-session-orchestrator.ts";
import * as streaming from "../modules/streaming/streaming.ts";
import { getStreamingBackend } from "../modules/streaming/streaming-engine.ts";
import { srtlaSendExec } from "../modules/streaming/streamloop/exec-paths.ts";
import * as runner from "../modules/streaming/streamloop/process-runner.ts";
import * as session from "../modules/streaming/streamloop/session.ts";
import * as preparation from "../modules/streaming/streamloop/srtla-ip-preparation.ts";
import * as launch from "../modules/streaming/streamloop/start-stream.ts";
import * as notifications from "../modules/ui/notifications.ts";

const GENERATION = 7431;
const OLD = "192.0.2.1";
const NEW = "192.0.2.3";
const WIRED = "198.51.100.7";

type Observer = (delivered: Promise<boolean>) => void;
let observer: Observer | undefined;
let bound: string[] = [];
let kills: string[] = [];
let stops: number[] = [];
let shown: Array<{ name: string; key?: string; action?: unknown }> = [];
/** Whether the status said "restarting" when each notice went out. */
let restartingAtNotice: boolean[] = [];
let removed: string[] = [];
let readFails = false;
let senderPresent = true;

const fakeSender = {
	spawnfile: srtlaSendExec,
	proc: {
		pid: 424242,
		kill: (signal: string) => {
			kills.push(signal);
			if (signal === "SIGHUP" && onHup) onHup();
		},
		exited: new Promise<number>(() => {}),
	},
	exitListeners: [],
} as unknown as runner.StreamingProcess;
let onHup: (() => void) | undefined;

function publish(
	ips: Array<{ ip: string; iface: string }>,
	generation: number,
) {
	const publication = {
		ok: true,
		generation,
		changed: true,
		sidecarPath: "/run/test/map.json",
	} as BindMapPublication;
	return { entries: ips, publication } as unknown as srtla.PublishedBond;
}

let bond: srtla.PublishedBond | undefined;
/** Which link the sender's telemetry shows carrying; undefined = no telemetry. */
let carriedBy: string | null | undefined;
let restarts: string[] = [];
/** Whether the status said "restarting" when each Start began. */
let restartingAtStart: boolean[] = [];
/** What `getIsStreaming` answers; a restart's Stop and Start move it. */
let live = false;
/** The results the next restart Starts return, in order; then "started". */
let startResults: string[] = [];
/** The link sources a Start would bond now, for the reconnect window. */
let linkSources: string[] = [];
let sourceListeners: Array<() => void> = [];

function frame(carrier: string | null): LinkTelemetryMessage {
	const links = ["wwan0", "eth0"].map((iface) => ({
		conn_id: iface,
		iface,
		rtt_ms: 40,
		nak_count: 0,
		weight_percent: 50,
		bitrate_bps: iface === carrier ? 4_000_000 : 0,
		stale: false,
	}));
	return { links, measured_bps: 0, lastReadMs: 0 };
}

beforeEach(() => {
	observer = undefined;
	bound = [OLD, WIRED];
	kills = [];
	stops = [];
	shown = [];
	restartingAtNotice = [];
	removed = [];
	readFails = false;
	senderPresent = true;
	onHup = undefined;
	staleLinkNotice.resetForTest();
	session.setSenderReloadTimingForTest({
		windowMs: 60,
		pollMs: 5,
		carryWindowMs: 100,
	});
	autoRestart.resetForTest();
	carriedBy = undefined;
	restarts = [];
	restartingAtStart = [];
	resetConnectionRestartingForTest();
	spyOn(telemetry, "buildLinkTelemetry").mockImplementation(() =>
		carriedBy === undefined ? null : frame(carriedBy),
	);
	live = false;
	startResults = [];
	linkSources = [];
	sourceListeners = [];
	resetStreamReconnectForTest();
	spyOn(owner, "stopStreamSession").mockImplementation(async (cause) => {
		restarts.push(`stop:${cause}`);
		live = false;
		return { result: "stopped" };
	});
	spyOn(owner, "startStreamSession").mockImplementation(async (request) => {
		restarts.push(`start:${request.origin}`);
		restartingAtStart.push(isConnectionRestarting());
		const result = startResults.shift() ?? "started";
		if (result === "started") live = true;
		return { result, attemptId: "auto" } as Awaited<
			ReturnType<typeof owner.startStreamSession>
		>;
	});
	spyOn(srtla, "genSrtlaIpList").mockImplementation(() => [...linkSources]);
	spyOn(netif, "onNetworkInterfaceSourcesChange").mockImplementation(
		(listener) => {
			sourceListeners.push(listener);
			return () => {
				sourceListeners = sourceListeners.filter((l) => l !== listener);
			};
		},
	);
	bond = publish(
		[
			{ ip: OLD, iface: "wwan0" },
			{ ip: WIRED, iface: "eth0" },
		],
		1,
	);
	spyOn(srtla, "getLastPublishedBond").mockImplementation(() => bond);
	spyOn(srtla, "observeSenderReload").mockImplementation((next) => {
		observer = next;
		return () => {
			if (observer === next) observer = undefined;
		};
	});
	spyOn(srtla, "restartSrtla").mockImplementation(() => Promise.resolve(true));
	spyOn(runner, "getStreamingProcesses").mockImplementation(() =>
		senderPresent ? [fakeSender] : [],
	);
	spyOn(runner, "stopProcessAndWait").mockImplementation(async () => {
		stops.push(performance.now());
	});
	spyOn(sockets, "senderSocketSources").mockImplementation(async () => {
		if (readFails) throw new Error("EACCES");
		return [...bound];
	});
	spyOn(labels, "resolveLinkLabel").mockImplementation(async (iface) =>
		iface === "wwan0" ? "Modem 2" : iface,
	);
	spyOn(notifications, "notificationBroadcast").mockImplementation(
		(
			name,
			_type,
			_msg,
			_duration,
			_persistent,
			_dismissable,
			_authed,
			key,
			_params,
			opts,
		) => {
			shown.push({ name, key, action: opts?.action });
			restartingAtNotice.push(isConnectionRestarting());
		},
	);
	spyOn(notifications, "notificationRemove").mockImplementation((name) => {
		removed.push(name);
		return { remove: [] };
	});
	spyOn(preparation, "prepareSrtlaIpAddresses").mockResolvedValue(
		undefined as never,
	);
});

afterEach(async () => {
	spyOn(getStreamingBackend(), "stop").mockImplementation((complete) => {
		complete();
		return true;
	});
	await session.stopGeneration(GENERATION);
	jest.restoreAllMocks();
	session.setSenderReloadTimingForTest(null);
	staleLinkNotice.resetForTest();
	autoRestart.resetForTest();
	resetStreamReconnectForTest();
});

let launches = 0;
async function startLive() {
	live = false;
	launches = 0;
	spyOn(streaming, "getIsStreaming").mockImplementation(() => live);
	spyOn(streaming, "updateConfig").mockResolvedValue({
		pipeline: {
			source: "hdmi",
			name: "Constructed",
			hardware: "generic",
			description: "Constructed",
			supportsAudio: false,
			supportsResolutionOverride: false,
			supportsFramerateOverride: false,
			audio_kind: "none",
		},
		srtlaAddr: "203.0.113.1",
		srtlaPort: 5000,
		streamid: "constructed",
	});
	spyOn(launch, "startStream").mockImplementation(async () => {
		launches++;
		return { success: true };
	});
	expect(await session.start(WebSocket.prototype, {}, GENERATION)).toEqual({
		success: true,
	});
	live = true;
	expect(observer).toBeDefined();
}

/** The link renumbered: publish the new address and report the reload. */
function renumber(delivered = true) {
	bond = publish(
		[
			{ ip: NEW, iface: "wwan0" },
			{ ip: WIRED, iface: "eth0" },
		],
		2,
	);
	observer?.(Promise.resolve(delivered));
}

const settle = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

test("a withheld HUP gets one retry by the owned PID and stays quiet", async () => {
	await startLive();
	onHup = () => {
		bound = [NEW, WIRED];
	};
	renumber();
	await settle(200);
	expect(kills).toEqual(["SIGHUP"]);
	expect(shown).toEqual([]);
	expect(launches).toBe(1);
	expect(stops).toEqual([]);
});

test("a source still stale after the retry offers a restart and restarts nothing", async () => {
	await startLive();
	renumber();
	await settle(300);
	expect(kills).toEqual(["SIGHUP"]);
	expect(shown).toHaveLength(1);
	expect(shown[0]?.name).toBe(STALE_LINK_NOTICE);
	expect(shown[0]?.key).toBe("notifications.staleLinkAddress");
	expect(shown[0]?.action).toMatchObject({
		kind: "command",
		command: "restart-connection",
		token: staleLinkNotice.current()?.token,
	});
	expect(staleLinkNotice.current()?.generation).toBe(GENERATION);
	// Nothing restarted on its own: no stop of any process, no second start.
	expect(stops).toEqual([]);
	expect(launches).toBe(1);
	expect(restarts).toEqual([]);
});

test("an unreadable /proc never escalates", async () => {
	await startLive();
	readFails = true;
	renumber();
	await settle(300);
	expect(kills).toEqual([]);
	expect(shown).toEqual([]);
	expect(stops).toEqual([]);
});

test("Stop closes the check before the engine has stopped", async () => {
	await startLive();
	renumber();
	await settle(20);
	// The engine acknowledges Stop only later; the check must already be closed.
	const engineStop = Promise.withResolvers<() => void>();
	spyOn(getStreamingBackend(), "stop").mockImplementation((complete) => {
		engineStop.resolve(complete);
		return true;
	});
	const stopping = session.stopGeneration(GENERATION);
	await settle(300);
	expect(kills).toEqual([]);
	expect(shown).toEqual([]);
	(await engineStop.promise)();
	await stopping;
	expect(observer).toBeUndefined();
});

test("Stop keeps the interface and USB listeners until the engine has stopped", async () => {
	const listening = { netif: 0, usb: 0 };
	spyOn(netif, "onNetworkInterfaceSourcesChange").mockImplementation(() => {
		listening.netif++;
		return () => {
			listening.netif--;
		};
	});
	spyOn(usbScan, "onUsbNetScanCommitted").mockImplementation(() => {
		listening.usb++;
		return () => {
			listening.usb--;
		};
	});
	await startLive();
	expect(listening).toEqual({ netif: 1, usb: 1 });
	const engineStop = Promise.withResolvers<() => void>();
	spyOn(getStreamingBackend(), "stop").mockImplementation((complete) => {
		engineStop.resolve(complete);
		return true;
	});
	const stopping = session.stopGeneration(GENERATION);
	// The adoption check is closed at once; a Stop that never completes still
	// leaves address changes published to the stream that is still up.
	expect(observer).toBeUndefined();
	expect(listening).toEqual({ netif: 1, usb: 1 });
	(await engineStop.promise)();
	await stopping;
	expect(listening).toEqual({ netif: 0, usb: 0 });
});

test("Stop withdraws the offer and spends its token", async () => {
	await startLive();
	renumber();
	await settle(300);
	const offer = staleLinkNotice.current();
	expect(offer?.generation).toBe(GENERATION);
	spyOn(getStreamingBackend(), "stop").mockImplementation((complete) => {
		complete();
		return true;
	});
	await session.stopGeneration(GENERATION);
	expect(removed).toContain(STALE_LINK_NOTICE);
	expect(staleLinkNotice.current()).toBeUndefined();
	expect(
		staleLinkNotice.take(
			offer?.token ?? "",
			session.currentSessionGeneration(),
		),
	).toBeUndefined();
});

test("a later adoption withdraws an offer that is on screen", async () => {
	await startLive();
	renumber();
	await settle(300);
	expect(staleLinkNotice.current()).toBeDefined();
	bound = [NEW, WIRED];
	bond = publish(
		[
			{ ip: NEW, iface: "wwan0" },
			{ ip: WIRED, iface: "eth0" },
		],
		3,
	);
	observer?.(Promise.resolve(true));
	await settle(100);
	expect(staleLinkNotice.current()).toBeUndefined();
	expect(removed).toContain(STALE_LINK_NOTICE);
});

test("the sender stays up for the hold after the engine confirms Stop", async () => {
	await startLive();
	spyOn(getStreamingBackend(), "stop").mockImplementation((complete) => {
		complete();
		return true;
	});
	const before = performance.now();
	await session.stopGeneration(GENERATION);
	expect(stops).toHaveLength(1);
	expect((stops[0] ?? 0) - before).toBeGreaterThanOrEqual(
		session.SENDER_STOP_HOLD_MS - 5,
	);
	expect(session.SENDER_STOP_HOLD_MS).toBe(250);
});

test("no hold without a sender, and none when the engine is missing", async () => {
	await startLive();
	senderPresent = false;
	spyOn(getStreamingBackend(), "stop").mockImplementation((complete) => {
		complete();
		return true;
	});
	let before = performance.now();
	await session.stopGeneration(GENERATION);
	expect(performance.now() - before).toBeLessThan(100);

	await startLive();
	senderPresent = true;
	spyOn(getStreamingBackend(), "stop").mockImplementation(() => false);
	// No engine session: the stop is confirmed out of band, not by the engine.
	spyOn(getStreamingBackend(), "confirmStop").mockResolvedValue(undefined);
	before = performance.now();
	await session.stopGeneration(GENERATION, true);
	// The missing-engine path sweeps the sender without the forwarding hold.
	expect(stops).toHaveLength(1);
	expect((stops[0] ?? 0) - before).toBeLessThan(200);
});

/** The only link renumbered: the bond holds nothing else. */
function renumberOnlyLink() {
	bond = publish([{ ip: NEW, iface: "wwan0" }], 2);
	observer?.(Promise.resolve(true));
}

test("several links, the others carrying: the notice only, saying so", async () => {
	await startLive();
	carriedBy = "eth0";
	renumber();
	await settle(300);
	expect(shown.map((n) => n.key)).toEqual([
		"notifications.staleLinkAddressCarrying",
	]);
	expect(restarts).toEqual([]);
	expect(stops).toEqual([]);
	expect(launches).toBe(1);
});

test("several links, no telemetry: can't tell, so the plain notice and no restart", async () => {
	await startLive();
	carriedBy = undefined;
	renumber();
	await settle(300);
	expect(shown.map((n) => n.key)).toEqual(["notifications.staleLinkAddress"]);
	expect(restarts).toEqual([]);
});

test("several links, none carried for the window: restart on its own", async () => {
	await startLive();
	carriedBy = null;
	renumber();
	await settle(400);
	expect(restarts).toEqual(["stop:reconfigure", "start:link-recovery"]);
	expect(shown.map((n) => n.name)).toEqual(["connection_restarted"]);
});

test("the only link stuck: restart on its own, exactly once, then announce it", async () => {
	await startLive();
	bond = publish([{ ip: OLD, iface: "wwan0" }], 1);
	bound = [OLD];
	renumberOnlyLink();
	await settle(400);
	expect(restarts).toEqual(["stop:reconfigure", "start:link-recovery"]);
	// Announced after the new session started, and never as "still live".
	expect(shown).toHaveLength(1);
	expect(shown[0]?.name).toBe("connection_restarted");
	expect(shown[0]?.key).toBe("notifications.connectionRestartedNewAddress");
	// No offer stands beside the restart.
	expect(staleLinkNotice.current()).toBeUndefined();
	// No sender replacement: the restart went through the session supervisor.
	expect(stops).toEqual([]);
	// The status said "restarting" through Start, and stops saying it after.
	expect(restartingAtStart).toEqual([true]);
	expect(isConnectionRestarting()).toBe(false);
});

test("the only link stuck and the restart's Start refused: the stream keeps reconnecting, with no gap and no failure notice", async () => {
	startResults = ["busy"];
	await startLive();
	bond = publish([{ ip: OLD, iface: "wwan0" }], 1);
	bound = [OLD];
	renumberOnlyLink();
	await settle(400);
	expect(restarts).toEqual(["stop:reconfigure", "start:link-recovery"]);
	// Not "Restarted the connection", and not "couldn't restart" while the
	// window still tries.
	expect(shown).toEqual([]);
	expect(isConnectionRestarting()).toBe(true);
	expect(getStreamReconnectStatus()?.state).toBe("reconnecting");
	noteOperatorStopIntent();
	expect(isConnectionRestarting()).toBe(false);
});

/** Every link gone: the publication withdraws the last one. */
function withdrawLastLink() {
	bond = publish([], 2);
	observer?.(Promise.resolve(true));
}

function linkBack(ip: string) {
	// The stopped session's own listener refreshes too: an unchanged bond.
	spyOn(preparation, "prepareSrtlaIpAddresses").mockResolvedValue({
		changed: false,
	} as never);
	linkSources = [ip];
	for (const listener of [...sourceListeners]) listener();
}

test("every link gone (gonepinF): the restart's Start fails, the window holds the stream reconnecting, and a returning link brings it back", async () => {
	await startLive();
	bond = publish([{ ip: OLD, iface: "wlan0" }], 1);
	bound = [OLD];
	startResults = ["failed"];
	withdrawLastLink();
	await settle(400);
	expect(restarts).toEqual(["stop:reconfigure", "start:link-recovery"]);
	// No gap between the restart and the window: the status never dropped.
	expect(isConnectionRestarting()).toBe(true);
	expect(getStreamReconnectStatus()).toMatchObject({ state: "reconnecting" });
	expect(shown).toEqual([]);
	// The link comes back after the edge spacing: one Start, and it says so.
	await settle(2_100);
	linkBack(NEW);
	await settle(100);
	expect(restarts).toEqual([
		"stop:reconfigure",
		"start:link-recovery",
		"start:link-recovery",
	]);
	expect(shown.map((n) => n.key)).toEqual(["notifications.streamReconnected"]);
	expect(isConnectionRestarting()).toBe(false);
	expect(getStreamReconnectStatus()).toBeNull();
});

test("every link gone, then Stop during the window: a returning link starts nothing", async () => {
	await startLive();
	bond = publish([{ ip: OLD, iface: "wlan0" }], 1);
	bound = [OLD];
	startResults = ["failed"];
	withdrawLastLink();
	await settle(400);
	expect(getStreamReconnectStatus()?.state).toBe("reconnecting");
	// What the orchestrator does first on an operator Stop.
	noteOperatorStopIntent();
	expect(isConnectionRestarting()).toBe(false);
	expect(getStreamReconnectStatus()).toBeNull();
	await settle(2_100);
	linkBack(NEW);
	await settle(100);
	expect(restarts).toEqual(["stop:reconfigure", "start:link-recovery"]);
	expect(shown).toEqual([]);
});

test("a stale-address restart whose Start fails while another link is up does not retry on its own: the end state with Keep trying", async () => {
	await startLive();
	carriedBy = null;
	startResults = ["failed"];
	linkSources = [WIRED];
	renumber();
	await settle(400);
	expect(restarts).toEqual(["stop:reconfigure", "start:link-recovery"]);
	expect(getStreamReconnectStatus()).toMatchObject({
		state: "expired",
		reason: "start_failed",
	});
	expect(isConnectionRestarting()).toBe(false);
	expect(shown.map((n) => n.key)).toEqual([
		"notifications.reconnectExpiredStartFailed",
	]);
	expect(shown[0]?.action).toMatchObject({
		kind: "command",
		command: "keep-reconnecting",
	});
	// The end state was published while the session was still held.
	expect(restartingAtNotice).toEqual([true]);
	await settle(2_100);
	linkBack(NEW);
	await settle(100);
	expect(restarts).toHaveLength(2);
	noteOperatorStopIntent();
	expect(getStreamReconnectStatus()).toBeNull();
});

test("every link gone within the stale-address cooldown still restarts: the cooldown is for stale addresses", async () => {
	await startLive();
	bound = [OLD];
	renumberOnlyLink();
	await settle(400);
	expect(restarts).toHaveLength(2);
	// Inside the five minutes, the last link is withdrawn and still bound.
	bound = [NEW];
	withdrawLastLink();
	await settle(400);
	expect(restarts).toEqual([
		"stop:reconfigure",
		"start:link-recovery",
		"stop:reconfigure",
		"start:link-recovery",
	]);
	expect(shown.map((n) => n.key)).toEqual([
		"notifications.connectionRestartedNewAddress",
		"notifications.streamReconnected",
	]);
});

test("the only link stuck again within the cooldown: the offer, not a second restart", async () => {
	await startLive();
	bound = [OLD];
	renumberOnlyLink();
	await settle(400);
	expect(restarts).toHaveLength(2);
	bond = publish([{ ip: "192.0.2.9", iface: "wwan0" }], 3);
	observer?.(Promise.resolve(true));
	await settle(400);
	expect(restarts).toHaveLength(2);
	expect(shown.map((n) => n.key)).toEqual([
		"notifications.connectionRestartedNewAddress",
		"notifications.staleLinkAddress",
	]);
});

test("Stop during the link-name lookup: no offer for the stopped session", async () => {
	await startLive();
	const lookup = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	spyOn(labels, "resolveLinkLabel").mockImplementation(async () => {
		lookup.resolve();
		await release.promise;
		return "Modem 2";
	});
	renumber();
	await lookup.promise;
	spyOn(getStreamingBackend(), "stop").mockImplementation((complete) => {
		complete();
		return true;
	});
	await session.stopGeneration(GENERATION);
	release.resolve();
	await settle(50);
	expect(shown).toEqual([]);
	expect(staleLinkNotice.current()).toBeUndefined();
});

test("a newer publication during the restart wiring: the older check restarts nothing", async () => {
	await startLive();
	bound = [OLD];
	carriedBy = null;
	const wiring = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const real = restart.connectionRestartDeps;
	spyOn(restart, "connectionRestartDeps").mockImplementation(
		async (conn, origin) => {
			wiring.resolve();
			await release.promise;
			return real(conn, origin);
		},
	);
	renumberOnlyLink();
	await wiring.promise;
	// The link adopts a newer address while the older check is still waiting.
	bound = ["192.0.2.9"];
	bond = publish([{ ip: "192.0.2.9", iface: "wwan0" }], 3);
	observer?.(Promise.resolve(true));
	release.resolve();
	await settle(300);
	expect(restarts).toEqual([]);
	expect(shown).toEqual([]);
});

test("both cooldowns running: a stuck link nothing else covers still gets the notice, and no second restart", async () => {
	await startLive();
	// 1. Another link carries: the offer, which starts the notice cooldown.
	carriedBy = "eth0";
	renumber();
	await settle(300);
	// 2. Nothing carries: the automatic restart, which starts its own cooldown.
	carriedBy = null;
	bond = publish(
		[
			{ ip: "192.0.2.9", iface: "wwan0" },
			{ ip: WIRED, iface: "eth0" },
		],
		3,
	);
	observer?.(Promise.resolve(true));
	await settle(400);
	expect(restarts).toEqual(["stop:reconfigure", "start:link-recovery"]);
	// 3. Stuck again, nothing carries, both cooldowns running: the calm notice,
	// not silence, and not a second restart.
	bond = publish(
		[
			{ ip: "192.0.2.20", iface: "wwan0" },
			{ ip: WIRED, iface: "eth0" },
		],
		4,
	);
	observer?.(Promise.resolve(true));
	await settle(400);
	expect(restarts).toHaveLength(2);
	expect(shown.map((n) => n.key)).toEqual([
		"notifications.staleLinkAddressCarrying",
		"notifications.connectionRestartedNewAddress",
		"notifications.staleLinkAddress",
	]);
	expect(staleLinkNotice.current()?.generation).toBe(GENERATION);
});
