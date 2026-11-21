import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real sd_notify into a fake NOTIFY_SOCKET while the owner's loop is blocked.
// WATCHDOG_USEC=3 s pulses every second. The stall starts 1.45 s in, just before
// a half-interval pulse would have been due, and lasts 1.7 s: with half-interval
// pulses the gap would be about 3.15 s and systemd would kill the owner.
// The kernel stamps each datagram when it is queued (SO_TIMESTAMP), so a slow
// sink process cannot widen the measured gaps. The logind tests already need
// python3 on Linux.
const SINK = `
import os, socket, struct, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, getattr(socket, "SO_TIMESTAMP", 29), 1)
s.bind(sys.argv[1])
print("ready", flush=True)
s.settimeout(0.2)
while True:
    try:
        message, ancillary, _, _ = s.recvmsg(4096, socket.CMSG_SPACE(16))
    except socket.timeout:
        if os.path.exists(sys.argv[1] + ".stop"):
            break
        continue
    if not message.startswith(b"WATCHDOG=1"):
        continue
    for level, kind, data in ancillary:
        if level == socket.SOL_SOCKET and len(data) >= 16:
            seconds, micros = struct.unpack("qq", data[:16])
            print(seconds * 1000 + micros // 1000, flush=True)
`;

test.skipIf(process.platform !== "linux")(
	"a 1.7 s loop stall just before a due pulse stays inside a 3 s watchdog",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "watchdog-"));
		const socket = join(dir, "notify");
		const sink = Bun.spawn(["python3", "-c", SINK, socket], {
			stdout: "pipe",
			stderr: "inherit",
		});
		let owner:
			| import("bun").Subprocess<"ignore", "pipe", "inherit">
			| undefined;
		try {
			const reader = sink.stdout.getReader();
			let output = "";
			while (!output.includes("ready\n")) {
				const { value, done } = await reader.read();
				if (done) throw Error("notify sink exited");
				output += new TextDecoder().decode(value);
			}
			const helper = new URL("../helpers/systemd-watchdog.ts", import.meta.url)
				.pathname;
			const program = `const { startServiceWatchdog } = await import(${JSON.stringify(helper)});
   startServiceWatchdog();
   await Bun.sleep(1450);
   const start = performance.now();
   while (performance.now() - start < 1700) {}
   await Bun.sleep(1500);
   console.log(Math.round(performance.now() - start));`;
			const { WATCHDOG_PID: _inherited, ...env } = process.env;
			owner = Bun.spawn([process.execPath, "-e", program], {
				env: {
					...env,
					NODE_ENV: "production",
					NOTIFY_SOCKET: socket,
					WATCHDOG_USEC: "3000000",
				},
				stdout: "pipe",
				stderr: "inherit",
			});
			const exited = await Promise.race([
				owner.exited,
				Bun.sleep(10_000).then(() => "timeout"),
			]);
			expect(exited).toBe(0);
			expect(
				Number((await new Response(owner.stdout).text()).trim()),
			).toBeGreaterThanOrEqual(1700);
			await Bun.write(`${socket}.stop`, "");
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				output += new TextDecoder().decode(value);
			}
			const pulses = output
				.split("\n")
				.filter((line) => /^\d+$/.test(line))
				.map(Number);
			expect(pulses.length).toBeGreaterThanOrEqual(2);
			const gaps = pulses.slice(1).map((at, i) => at - (pulses[i] ?? at));
			// About 2.15 s here; half-interval pulses would give about 3.15 s,
			// past the 3 s deadline. 2.8 s leaves scheduler slack below it.
			expect(Math.max(...gaps)).toBeLessThan(2800);
			expect(Math.max(...gaps)).toBeGreaterThan(1700);
			// The loop resumed pulsing every second after the stall.
			expect(pulses.length).toBeGreaterThanOrEqual(4);
		} finally {
			owner?.kill();
			await owner?.exited;
			sink.kill();
			await sink.exited;
			rmSync(dir, { recursive: true, force: true });
		}
	},
	15000,
);
