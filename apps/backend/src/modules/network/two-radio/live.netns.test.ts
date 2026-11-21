import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { readlinkSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJournal } from "./journal.ts";
import { boundProbe } from "./probe.ts";
import { startLive } from "./runtime.ts";
import { config, state } from "./synthetic.fixture.ts";

const enabled = process.env.TWO_RADIO_NETNS === "1";
test.skipIf(!enabled)(
	"flag true drives real policy flip, bound probes, common-target suppression and crash recovery",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "radio-policy-"));
		const mode = join(dir, "mode");
		await writeFile(mode, "split");
		const child = spawn(
			"unshare",
			[
				"-n",
				"bun",
				"-e",
				`
 const fs=require('node:fs');const crypto=require('node:crypto');
 require('node:child_process').execFileSync('ip',['link','set','lo','up']);
 require('node:child_process').execFileSync('ip',['address','add','${config.target}/32','dev','lo']);
 const s=require('node:dgram').createSocket('udp4');const nonces=new Map();
 s.on('message',(b,p)=>{const text=b.toString();const kind=fs.readFileSync(${JSON.stringify(mode)},'utf8');
 if(text.startsWith('ISSUE ')){const n=crypto.randomBytes(24).toString('hex');nonces.set(p.address+':'+p.port,n);s.send(n,p.port,p.address);}
 else if(text.startsWith('PROBE ') && text.slice(6)===nonces.get(p.address+':'+p.port) && kind!=='fail' && !(kind==='split' && p.address==='198.18.1.2')) s.send('ACK '+text.slice(6),p.port,p.address);
 else if(b.length===1024) s.send(JSON.stringify({bytes:b.length,hash:crypto.createHash('sha256').update(b).digest('hex'),source:p.address}),p.port,p.address);
 });s.bind(${config.port},'${config.target}');
 `,
			],
			{ stdio: ["ignore", "inherit", "inherit"] },
		);
		const ip = (...args: string[]) =>
			execFileSync("ip", args, { encoding: "utf8" });
		const remote = (...args: string[]) =>
			execFileSync("nsenter", ["-t", String(child.pid), "-n", "ip", ...args]);
		const runner = async (bin: string, args: string[]) =>
			execFileSync(bin, args, {
				encoding: "utf8",
				timeout: 4000,
				stdio: ["ignore", "pipe", "pipe"],
			});
		let now = 0,
			claimed = false,
			received = 0;
		let tail: Promise<unknown> = Promise.resolve();
		try {
			// /proc namespace entry is independent of named-netns mount privileges.
			for (let tries = 0; tries < 100; tries++) {
				try {
					if (
						readlinkSync(`/proc/${child.pid}/ns/net`) ===
						readlinkSync("/proc/self/ns/net")
					)
						throw new Error("Namespace not entered yet");
					remote("link", "set", "lo", "up");
					break;
				} catch {
					await Bun.sleep(10);
				}
			}

			for (const [r, n] of [
				["a", 1],
				["b", 2],
			] as const) {
				ip(
					"link",
					"add",
					`radio${r}`,
					"type",
					"veth",
					"peer",
					"name",
					`peer${r}`,
				);
				ip("link", "set", `peer${r}`, "netns", String(child.pid));
				ip("address", "add", `198.18.${n}.2/24`, "dev", `radio${r}`);
				ip("link", "set", `radio${r}`, "up");
				remote("address", "add", `198.18.${n}.1/24`, "dev", `peer${r}`);
				remote("link", "set", `peer${r}`, "up");
			}
			ip("link", "set", "lo", "up");
			for (const name of ["all", "default", "radioa", "radiob"])
				execFileSync("sysctl", ["-qw", `net.ipv4.conf.${name}.rp_filter=0`]);
			const defaults = ip("-j", "route", "show", "default");
			const deps = () => ({
				runner,
				observe: async (r: "a" | "b") => state(r),
				run: <T>(f: () => Promise<T>) => {
					const next = tail.then(f);
					tail = next.catch(() => undefined);
					return next;
				},
				journal: new FileJournal(join(dir, "journal.json")),
				claim: async () => {
					const old = claimed;
					claimed = true;
					return old;
				},
				probe: (s: ReturnType<typeof state>, signal: AbortSignal) =>
					boundProbe(s.ifname, config.target, config.port, signal, runner),
				now: () => now,
				traffic: async () => {
					// Separate carrying data flow: independently returned byte count + digest,
					// routed by SO_MARK without an interface binding. No probe becomes traffic.
					const output = await runner("perl", [
						"-MDigest::SHA=sha256_hex",
						"-MSocket",
						"-e",
						`alarm 2; socket(S,PF_INET,SOCK_DGRAM,0) or die; setsockopt(S,SOL_SOCKET,36,pack('I',${config.mark})) or die; connect(S,sockaddr_in(${config.port},inet_aton('${config.target}'))) or die; my $data='x'x1024;send(S,$data,0) or die;recv(S,my $out,2048,0) or die;print $out;`,
					]);
					const receipt = JSON.parse(output);
					expect(receipt.bytes).toBe(1024);
					expect(receipt.source).toBe("198.18.2.2");
					expect(receipt.hash).toBe(
						new Bun.CryptoHasher("sha256")
							.update("x".repeat(1024))
							.digest("hex"),
					);
					received += receipt.bytes;
					return true;
				},
			});
			expect(
				await startLive(false, {}, () => {
					throw new Error("disabled IO");
				}),
			).toBeNull();
			const live = await startLive(true, config, deps);
			expect(live).not.toBeNull();
			if (!live) throw new Error("missing runtime");
			await live.cycle();
			now = 5000;
			await live.cycle();
			expect(
				ip("-j", "route", "get", config.target, "mark", String(config.mark)),
			).toContain("radiob");
			expect(received).toBe(1024);
			expect(live.coordinator.view().op?.phase).toBe("linger");
			// Crash before release: retained journal restores the original holder.
			const restarted = await startLive(true, config, deps);
			if (!restarted) throw new Error("restart");
			expect(
				ip("-j", "route", "get", config.target, "mark", String(config.mark)),
			).toContain("radioa");
			now = 6000;
			await writeFile(mode, "fail");
			await restarted.cycle();
			expect(restarted.coordinator.view().suspectTargets).toContain(
				config.target,
			);
			now = 11000;
			await restarted.cycle();
			expect(restarted.coordinator.view().op).toBeNull();
			expect(
				ip("-j", "route", "get", config.target, "mark", String(config.mark)),
			).toContain("radioa");
			// A new reconciled session clears the conservative target latch.
			const complete = await startLive(true, config, deps);
			if (!complete) throw new Error("new session");
			await writeFile(mode, "split");
			now = 12000;
			await complete.cycle();
			now = 17000;
			await complete.cycle();
			expect(complete.coordinator.view().op?.phase).toBe("linger");
			await writeFile(mode, "pass");
			now = 20000;
			await complete.cycle();
			expect(complete.coordinator.view().holder).toBe("b");
			expect(complete.coordinator.view().op).toBeNull();
			const committed = await startLive(true, config, deps);
			expect(committed?.coordinator.view().holder).toBe("b");
			expect(
				ip("-j", "route", "get", config.target, "mark", String(config.mark)),
			).toContain("radiob");
			expect(ip("-j", "route", "show", "default")).toBe(defaults);
			expect(
				JSON.parse(ip("-j", "rule", "show")).filter(
					(r: { priority: number }) =>
						r.priority >= 18000 && r.priority <= 18002,
				),
			).toHaveLength(3);
		} finally {
			child.kill("SIGKILL");
			await rm(dir, { recursive: true, force: true });
		}
	},
	45000,
);
