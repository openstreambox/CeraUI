import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const mode of ["acquire", "init"] as const) {
	test.skipIf(process.platform !== "linux")(
		`stuck bus keeps timers and watchdog alive during ${mode}`,
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "inhibitor-"));
			const sockets = new Set<import("bun").Socket>();
			const server = Bun.listen({
				unix: join(dir, "bus"),
				socket: {
					open(socket) {
						sockets.add(socket);
					},
					data() {},
					close(socket) {
						sockets.delete(socket);
					},
				},
			});
			const native = new URL(
				"../modules/system/logind-inhibitor.ts",
				import.meta.url,
			).pathname;
			const protection = new URL(
				"../modules/system/shutdown-protection.ts",
				import.meta.url,
			).pathname;
			const watchdog = new URL(
				"../helpers/systemd-watchdog.ts",
				import.meta.url,
			).pathname;
			const program = `import { acquireLogindInhibitor } from ${JSON.stringify(native)};
   import { initShutdownProtection, setShutdownProtection } from ${JSON.stringify(protection)};
   import { startServiceWatchdog } from ${JSON.stringify(watchdog)};
   let ticks=0, pulses=0; const timer=setInterval(()=>ticks++,10);
   const stop=startServiceWatchdog({env:{NODE_ENV:'production',NOTIFY_SOCKET:'/unused',WATCHDOG_USEC:'40000'},notify:()=>pulses++});
   const start=performance.now(); let failed=false;
   if (${JSON.stringify(mode)}==='init') { setShutdownProtection('encoder',true); await initShutdownProtection(); await Bun.sleep(350); }
   else { try { const close=await acquireLogindInhibitor(); close(); } catch { failed=true; } }
   stop(); clearInterval(timer); console.log(JSON.stringify({ticks,pulses,elapsed:performance.now()-start,failed}));`;
			const child = Bun.spawn([process.execPath, "-e", program], {
				env: {
					...process.env,
					DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${dir}/bus`,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			try {
				const outcome = await Promise.race([
					child.exited,
					Bun.sleep(2000).then(() => "timeout"),
				]);
				expect(outcome).toBe(0);
				const result = JSON.parse(
					(await new Response(child.stdout).text()).trim().split("\n").at(-1) ??
						"",
				);
				expect(result.elapsed).toBeLessThan(1000);
				expect(result.ticks).toBeGreaterThan(5);
				expect(result.pulses).toBeGreaterThan(3);
				if (mode === "acquire") expect(result.failed).toBe(true);
			} finally {
				child.kill();
				await child.exited;
				for (const socket of sockets) socket.terminate();
				server.stop(true);
				rmSync(dir, { recursive: true, force: true });
			}
		},
		5000,
	);
}
