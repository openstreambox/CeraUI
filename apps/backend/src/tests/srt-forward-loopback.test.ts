import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSrtForwardController,
	forwardUrls,
} from "../modules/ingest/srt-forward-core.ts";

// Opt-in native fixture: the gate runner supplies tools inside an isolated net/PID namespace.
test.skipIf(!process.env.SRT_FORWARD_LOOPBACK)(
	"phone SRT terminates locally and reaches a loopback bonded relay unchanged",
	async () => {
		const tool = process.env.SRT_FORWARD_TRANSMIT ?? "";
		const receiver = process.env.SRT_FORWARD_RECEIVER ?? "";
		const sender = process.env.SRT_FORWARD_SENDER ?? "";
		const dir = await mkdtemp(join(tmpdir(), "srt-forward-"));
		const procs: Bun.Subprocess[] = [];
		const spawn = (args: string[]) => {
			const p = Bun.spawn(args, {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			procs.push(p);
			return p;
		};
		const states: unknown[] = [];
		let relayAccepted = false;
		let got = 0;
		let invalidPayload = false;
		const marker = Buffer.alloc(1316, 0x47);
		const urls = forwardUrls(
			{ host: "127.0.0.1", port: 19401, passphrase: "phone-secret" },
			{ port: 19402, streamid: "relay&identity", latency: 200 },
		);
		const controller = createSrtForwardController({
			report: (s) => states.push(s),
			admit: async () => () => {},
			start: async () => {
				const p = spawn([
					sender,
					"19402",
					"127.0.0.1",
					"19403",
					join(dir, "ips"),
					"--stats-file",
					join(dir, "stats"),
				]);
				void new Response(p.stderr).text();
				return {
					stop: async () => {
						p.kill();
						await p.exited;
					},
				};
			},
		});
		try {
			await Bun.write(join(dir, "ips"), "127.0.0.1\n127.0.0.2\n");
			const rec = spawn([receiver, "19403", "127.0.0.1", "19404"]);
			void new Response(rec.stderr).text();
			const sink = spawn([
				process.env.SRT_FORWARD_SINK ?? "",
				"19404",
				"relay&identity",
			]);
			void new Response(sink.stderr).text();
			void (async () => {
				for await (const chunk of sink.stdout) {
					if (![...chunk].every((b) => b === 0x47)) invalidPayload = true;
					got += chunk.length;
				}
			})();
			const bridge = spawn([tool, urls.input, urls.output]);
			let logs = "";
			void (async () => {
				const decoder = new TextDecoder();
				for await (const chunk of bridge.stderr) {
					logs += decoder.decode(chunk);
					if (logs.includes("SRT target connected")) relayAccepted = true;
					if (logs.includes("Accepted SRT source connection")) {
						logs = "";
						await controller.publisher(true);
					}
					if (logs.includes("SRT source disconnected")) {
						logs = "";
						await controller.publisher(false);
					}
				}
			})();
			controller.listening();
			const wrong = spawn([
				tool,
				"file://con",
				"srt://127.0.0.1:19401?mode=caller&passphrase=wrong-secret&conntimeo=300",
			]);
			let rejected = "";
			void (async () => {
				for await (const chunk of wrong.stderr)
					rejected += new TextDecoder().decode(chunk);
			})();
			wrong.stdin.write(marker);
			await wrong.stdin.flush();
			await Bun.sleep(500);
			expect(rejected).toMatch(/BADSECRET|[Rr]eject|[Pp]assphrase/);
			expect(states).not.toContain(true);
			wrong.kill("SIGKILL");
			await wrong.exited;
			const pub = spawn([
				tool,
				"file://con",
				"srt://127.0.0.1:19401?mode=caller&passphrase=phone-secret&latency=120",
			]);
			void new Response(pub.stderr).text();
			for (let i = 0; i < 200; i++) {
				for (let burst = 0; burst < 10; burst++) pub.stdin.write(marker);
				await pub.stdin.flush();
				await Bun.sleep(30);
			}
			expect(got).toBeGreaterThanOrEqual(13160);
			expect(invalidPayload).toBe(false);
			expect(relayAccepted).toBe(true);
			expect(states).toContain(true);
			// Wait for a telemetry flush, then prove both local links carried data.
			await Bun.sleep(1100);
			const telemetry = await Bun.file(join(dir, "stats")).json();
			expect(telemetry.connections).toHaveLength(2);
			for (const link of telemetry.connections)
				expect(link.bytes_sent_total).toBeGreaterThan(0);
			pub.kill("SIGKILL");
			await pub.exited;
			// An abruptly killed caller is detected by SRT's 5 s peer-idle timeout.
			for (let i = 0; i < 350 && states.at(-1) !== false; i++)
				await Bun.sleep(20);
			expect(states.at(-1)).toBe(false);
		} finally {
			await controller.stop();
			for (const p of procs) {
				if (p.exitCode === null) p.kill("SIGKILL");
			}
			await Promise.all(procs.map((p) => p.exited));
			await rm(dir, { recursive: true, force: true });
		}
	},
	20000,
);
