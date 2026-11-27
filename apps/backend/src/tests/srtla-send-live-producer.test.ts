import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

import {
	createControlClient,
	type SenderCapabilityDocument,
	senderStatsToTelemetry,
	supportsStatsSubscription,
	type TelemetryControlClient,
} from "@ceraui/srtla-send/control";
import { readTelemetry } from "@ceraui/srtla-send/telemetry";

/*
  THE LIVE PRODUCER CONTRACT.

  Every other srtla_send test in this repo asserts against a document CeraUI
  itself wrote. That proves the reader is self-consistent; it cannot prove the
  sender and the reader agree, which is the only thing that matters on a device.
  This file closes that gap by running the REAL binary and reading what it
  actually emits — the stats file through the Zod reader, and the control socket
  through the JSON-RPC client.

  It is opt-in via `SRTLA_SEND_BIN`, and SKIPS (never fails) when the variable is
  absent, because a checkout has no sender binary in it. CI exports the path from
  the activated `/usr/bin/srtla_send`; locally, point it at a .deb-extracted
  binary:

      dpkg-deb -x srtla_4.2.0_amd64.deb /tmp/srtla-extract
      SRTLA_SEND_BIN=/tmp/srtla-extract/usr/bin/srtla_send bun test

  Pointed at a PRE-hard-fork binary (3.3.0), the capability assertions are
  expected to fail on `bind_map` — but `getCapabilities()` must still RESOLVE
  (to null), never throw, which is what the "reports no capability support"
  assertion below pins. That is the graceful-downgrade path the whole start
  sequence depends on.
*/

const SENDER_BIN = process.env.SRTLA_SEND_BIN;

// An empty IP list is a legal start (the sender binds its SRT listener, runs
// with an empty uplink pool, and waits for SIGHUP), so no network is needed.
const EMPTY_IPS = "";

// A per-run port and per-run paths: the suite must not collide with a sibling
// run, with a real device sender, or with anything already holding 6000.
const RUN_ID = `${process.pid}-${Date.now() % 100_000}`;
const LISTEN_PORT = 40_000 + (process.pid % 20_000);
const STATS_FILE = `${tmpdir()}/sender-stats-${RUN_ID}.json`;
const CONTROL_SOCKET = `${tmpdir()}/sender-${RUN_ID}.sock`;
const IPS_FILE = `${tmpdir()}/sender-ips-${RUN_ID}.txt`;

const STATS_INTERVAL_MS = 200;
const READY_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
// Every case spawns a real process and waits out real timers; bun's 5 s default
// is tighter than the readiness budget alone.
const TEST_TIMEOUT_MS = 30_000;
// The SIGTERM case waits in sequence for the stats file, the handlers, the exit
// and the unlink; its cap covers all four so a slow sender fails on the step
// that was slow, not on the test timeout.
const SIGTERM_TEST_TIMEOUT_MS =
	READY_TIMEOUT_MS * 2 + SHUTDOWN_TIMEOUT_MS + 2000 + 5000;

type Spawned = ReturnType<typeof Bun.spawn>;

let child: Spawned | null = null;

function rm(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// absent is the desired state
	}
}

async function waitFor(
	predicate: () => Promise<boolean>,
	timeoutMs: number,
	what: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(50);
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/*
  `Bun.file(path).exists()` answers FALSE for a Unix socket inode — it reports
  whether the path names a readable FILE, and a socket is not one. The socket
  readiness check therefore has to be stat-based; only the stats document can use
  Bun.file. Getting this wrong makes every control-socket case hang until the
  test timeout, which is how it was found.
*/
function waitForControlSocket(): Promise<void> {
	return waitFor(
		async () => existsSync(CONTROL_SOCKET),
		READY_TIMEOUT_MS,
		"the control socket to appear",
	);
}

/*
  Feature-detect before touching any other method, exactly as the production
  start path does.

  A pre-hard-fork binary answers `get_capabilities` with -32601, which the client
  REPORTS as null rather than rejecting — that no-throw property is the
  graceful-downgrade contract. This turns the report into one legible failure for
  the whole file, instead of letting every later call surface its own raw
  `ControlRpcError: Method not found` and bury the actual finding.
*/
async function requireCapabilities(
	client: TelemetryControlClient | null,
): Promise<SenderCapabilityDocument> {
	const doc = await client?.getCapabilities();
	if (doc === null || doc === undefined) {
		throw new Error(
			"sender reports no capabilities support (legacy dialect, -32601); " +
				"point SRTLA_SEND_BIN at a hard-forked binary",
		);
	}
	return doc;
}

/*
  The stats file is NOT proof that the sender can take a SIGTERM yet. Released
  senders (4.1.0 and 4.2.0 at least) publish the first snapshot before they
  register their signal handlers, so a SIGTERM sent straight off the file can
  meet the default action: the process dies by signal and the file stays behind.
  That is a sender startup-order bug, not the shutdown contract this file pins,
  and it made the SIGTERM case below fail now and then under CPU load. A sender
  that registers its handlers first passes this wait at once.

  `SigCgt` in /proc/<pid>/status is the kernel's own mask of caught signals, so
  waiting on it closes the gap without a guessed sleep. A set SIGTERM bit alone
  is a few instructions early: tokio turns the OS handler on and only then
  subscribes the stream, and a signal broadcast in between is lost to it. Every
  sender registers SIGHUP, then SIGTERM, then SIGINT, so the wait also requires
  the SIGINT bit, which proves the SIGTERM stream is subscribed. The wait is
  bounded by READY_TIMEOUT_MS; a sender that never catches both fails here,
  which is itself a contract break. Off Linux there is no /proc to read and the
  case signals straight off the stats file, as it did before.
*/
// Bits (signal - 1) in SigCgt: SIGINT is 2, SIGTERM is 15.
const SIGINT_BIT = 1n << 1n;
const SIGTERM_BIT = 1n << 14n;

function caughtMask(pid: number): bigint | null {
	let status: string;
	try {
		status = readFileSync(`/proc/${pid}/status`, "utf8");
	} catch {
		return null;
	}
	const mask = /^SigCgt:\s*([0-9a-f]+)$/m.exec(status)?.[1];
	return mask === undefined ? null : BigInt(`0x${mask}`);
}

async function waitForSigtermHandler(proc: Spawned): Promise<void> {
	if (process.platform !== "linux") return;
	const both = SIGTERM_BIT | SIGINT_BIT;
	await waitFor(
		async () => ((caughtMask(proc.pid) ?? 0n) & both) === both,
		READY_TIMEOUT_MS,
		"the sender to install its SIGTERM and SIGINT handlers",
	);
}

async function startSender(bin: string): Promise<Spawned> {
	await Bun.write(IPS_FILE, EMPTY_IPS);
	rm(STATS_FILE);
	rm(CONTROL_SOCKET);
	const proc = Bun.spawn(
		[
			bin,
			"--stats-file",
			STATS_FILE,
			"--stats-file-interval",
			String(STATS_INTERVAL_MS),
			"--control-socket",
			CONTROL_SOCKET,
			String(LISTEN_PORT),
			"127.0.0.1",
			"5000",
			IPS_FILE,
		],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, RUST_LOG: "info" },
		},
	);
	child = proc;
	await waitFor(
		() => Bun.file(STATS_FILE).exists(),
		READY_TIMEOUT_MS,
		"the sender to publish its stats file",
	);
	return proc;
}

afterEach(async () => {
	if (child) {
		child.kill("SIGKILL");
		await child.exited.catch(() => {});
		child = null;
	}
	rm(STATS_FILE);
	rm(`${STATS_FILE}.tmp`);
	rm(CONTROL_SOCKET);
	rm(IPS_FILE);
});

describe.skipIf(!SENDER_BIN)(
	"srtla_send live producer (SRTLA_SEND_BIN)",
	() => {
		test(
			"publishes a stats file the Zod reader parses",
			async () => {
				await startSender(SENDER_BIN as string);

				const snapshot = await readTelemetry(STATS_FILE);
				expect(snapshot).not.toBeNull();
				expect(snapshot?.schema_version).toBe(1);
				// An empty IP list is "running but idle", which is a populated document
				// with zero connections — distinct from an absent file.
				expect(Array.isArray(snapshot?.connections)).toBe(true);
				expect(typeof snapshot?.last_updated_ms).toBe("number");
				// The document is younger than the publish cadence allows it to be old.
				expect(Date.now() - (snapshot?.last_updated_ms ?? 0)).toBeLessThan(
					READY_TIMEOUT_MS,
				);
			},
			TEST_TIMEOUT_MS,
		);

		test(
			"get_capabilities over the control socket reports bind_map support",
			async () => {
				await startSender(SENDER_BIN as string);
				await waitForControlSocket();

				const client = await createControlClient({
					socketPath: CONTROL_SOCKET,
					timeoutMs: 5000,
				});
				expect(client).not.toBeNull();
				try {
					const doc = await requireCapabilities(client);
					expect(doc.capabilities.bind_map).toBe(true);
					expect(doc.binary).toBe("srtla_send");
					expect(supportsStatsSubscription(doc)).toBe(true);
				} finally {
					client?.close();
				}
			},
			TEST_TIMEOUT_MS,
		);

		test(
			"the stats topic pushes snapshots that project into the file's shape",
			async () => {
				await startSender(SENDER_BIN as string);
				await waitForControlSocket();

				const client = await createControlClient({
					socketPath: CONTROL_SOCKET,
					timeoutMs: 5000,
				});
				expect(client).not.toBeNull();
				try {
					await requireCapabilities(client);
					const stats = await client?.getStats();
					expect(stats).not.toBeNull();
					const projected = senderStatsToTelemetry(
						stats as NonNullable<typeof stats>,
					);
					// The projection has to satisfy the SAME frozen schema the file poll
					// does — that equivalence is the only reason the subscription may
					// replace the poll.
					expect(projected).not.toBeNull();
					expect(projected?.schema_version).toBe(1);
					expect(projected?.connections).toEqual([]);
				} finally {
					client?.close();
				}
			},
			TEST_TIMEOUT_MS,
		);

		test(
			"SIGTERM exits cleanly and unlinks the live stats file",
			async () => {
				const proc = await startSender(SENDER_BIN as string);
				expect(await Bun.file(STATS_FILE).exists()).toBe(true);
				await waitForSigtermHandler(proc);

				proc.kill("SIGTERM");
				const exited = await Promise.race([
					proc.exited,
					Bun.sleep(SHUTDOWN_TIMEOUT_MS).then(() => "timeout" as const),
				]);
				expect(exited).not.toBe("timeout");
				child = null;
				// Clean means the sender's own handler ran: exit 0, not a death by
				// the signal's default action.
				expect(proc.signalCode).toBeNull();
				expect(proc.exitCode).toBe(0);

				await waitFor(
					async () => !(await Bun.file(STATS_FILE).exists()),
					2000,
					"the stats file to be unlinked on clean shutdown",
				);
				expect(await Bun.file(STATS_FILE).exists()).toBe(false);
				expect(await Bun.file(`${STATS_FILE}.tmp`).exists()).toBe(false);
			},
			SIGTERM_TEST_TIMEOUT_MS,
		);
	},
);
