import { expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { readlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePrivateStateLease } from "../helpers/private-state-lease.ts";
import { CellularHostRecovery } from "../modules/modems/cellular-host-recovery.ts";
import { inventoryCellularHosts } from "../modules/network/cellular-host-inventory.ts";
import { CellularIpv6Bootstrap } from "../modules/network/cellular-ipv6-bootstrap.ts";
import { parseCellularIpv6BootstrapPlan } from "../modules/network/cellular-ipv6-bootstrap-plan.ts";
import { cellularUplinkSlotKey } from "../modules/network/cellular-native-host-plan.ts";
import { probeCellularDns } from "../modules/network/cellular-path-probe.ts";
import { buildIpv4OnlyArpaQuery, parseIpv6 } from "../modules/network/nat64.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const file = fileURLToPath(import.meta.url),
	mode = process.env.CERALIVE_BOOTSTRAP_CHILD;
async function command(...argv: string[]) {
	const result = await runTestCommand(argv);
	if (result.code) throw new Error(result.stderr);
	return result.stdout;
}
const ip = (...argv: string[]) => command("ip", ...argv);
function requireNamespace(network: string | undefined, mount?: string) {
	if (
		!network ||
		readlinkSync("/proc/self/ns/net") === network ||
		(mount !== undefined && readlinkSync("/proc/self/ns/mnt") === mount)
	)
		throw new Error("Bootstrap fixture requires owned namespaces");
}
async function provider() {
	requireNamespace(process.env.BOOTSTRAP_PROVIDER_PARENT_NS);
	console.log("PROVIDER_READY");
	if ((await Bun.stdin.text()).trim() !== "start")
		throw new Error("Provider start missing");
	await ip("link", "set", "lo", "up");
	await ip("link", "set", "provider0", "up");
	await ip("-6", "addr", "add", "fe80::1/64", "nodad", "dev", "provider0");
	await ip(
		"-6",
		"addr",
		"add",
		"2001:db8:1::1/64",
		"nodad",
		"dev",
		"provider0",
	);
	await ip("-6", "addr", "add", "2001:db8::53/128", "nodad", "dev", "lo");
	const socket = createSocket("udp6");
	socket.on("message", (bytes, remote) => {
		if (
			!bytes.equals(Buffer.from(buildIpv4OnlyArpaQuery(bytes.readUInt16BE(0))))
		)
			throw new Error("Unexpected DNS question");
		const header = Buffer.from(bytes);
		header.writeUInt16BE(0x8180, 2);
		header.writeUInt16BE(2, 6);
		const answers = ["64:ff9b::c000:aa", "64:ff9b::c000:ab"].map((address) => {
			const data = parseIpv6(address);
			if (!data) throw new Error("Synthetic DNS answer invalid");
			const answer = Buffer.alloc(28);
			answer.writeUInt16BE(0xc00c, 0);
			answer.writeUInt16BE(28, 2);
			answer.writeUInt16BE(1, 4);
			answer.writeUInt32BE(60, 6);
			answer.writeUInt16BE(16, 10);
			answer.set(data, 12);
			return answer;
		});
		socket.send(
			Buffer.concat([header, ...answers]),
			remote.port,
			remote.address,
		);
		console.log("QUERY_ANSWERED");
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("error", reject);
		socket.bind(53, "2001:db8::53", resolve);
	});
	console.log("PROVIDER_RUNNING");
	await new Promise<void>((resolve) =>
		process.once("SIGTERM", () => {
			socket.close();
			resolve();
		}),
	);
}
const missing = ["unshare", "mount", "ip", "nft"].some(
		(binary) => !Bun.which(binary),
	),
	privilege =
		!mode && !missing
			? await runTestCommand(["unshare", "-Urnm", "true"])
			: undefined,
	unavailable = missing || (!mode && privilege?.code !== 0);
if (unavailable && process.env.CERALIVE_REQUIRE_CELLULAR_NETNS === "1")
	throw new Error("Required bootstrap namespace unavailable");
(unavailable ? test.skip : test)(
	"grant DNS bootstrap is routed before discovery and never falls through to the LAN",
	async () => {
		if (mode === "provider") {
			await provider();
			return;
		}
		if (mode !== "host") {
			const root = await mkdtemp(join(tmpdir(), "cellular-bootstrap-root-"));
			await mkdir(join(root, "tmp"), { mode: 0o700 });
			try {
				const result = await runTestCommand(
					[
						"unshare",
						"-Urnm",
						"sh",
						"-c",
						'mount --make-rprivate / && mount --bind "$1" /var && exec "$2" test "$3"',
						"cellular-bootstrap",
						root,
						process.execPath,
						file,
					],
					{
						cwd: root,
						env: {
							CERALIVE_BOOTSTRAP_CHILD: "host",
							BOOTSTRAP_PARENT_NET: readlinkSync("/proc/self/ns/net"),
							BOOTSTRAP_PARENT_MNT: readlinkSync("/proc/self/ns/mnt"),
							TMPDIR: "/var/tmp",
						},
					},
				);
				expect(result.code, result.stdout + result.stderr).toBe(0);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
			return;
		}
		if (!process.env.BOOTSTRAP_PARENT_MNT)
			throw new Error("Bootstrap mount namespace proof missing");
		requireNamespace(
			process.env.BOOTSTRAP_PARENT_NET,
			process.env.BOOTSTRAP_PARENT_MNT,
		);
		const remote = Bun.spawn(
			["unshare", "-n", process.execPath, "test", file],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					CERALIVE_BOOTSTRAP_CHILD: "provider",
					BOOTSTRAP_PROVIDER_PARENT_NS: readlinkSync("/proc/self/ns/net"),
				},
			},
		);
		const reader = remote.stdout.getReader();
		let output = "";
		const waitFor = async (marker: string) => {
			while (!output.includes(marker)) {
				const next = await Promise.race([
					reader.read(),
					Bun.sleep(5000).then(() => {
						throw new Error("DNS provider readiness timeout");
					}),
				]);
				if (next.done)
					throw new Error(
						`DNS provider ended: ${output}\n${await remote.stderr.text()}`,
					);
				output += new TextDecoder().decode(next.value);
				if (output.length > 4096)
					throw new Error("DNS provider output exceeds bound");
			}
		};
		const root = await mkdtemp(join(tmpdir(), "cellular-bootstrap-state-")),
			store = { dir: join(root, "state") };
		let lease: Awaited<ReturnType<typeof acquirePrivateStateLease>>,
			owned = true,
			current = true,
			consumers = true;
		try {
			await waitFor("PROVIDER_READY\n");
			await ip("link", "set", "lo", "up");
			await ip("link", "add", "lan0", "type", "dummy");
			await ip("link", "set", "lan0", "up");
			await ip("-6", "addr", "add", "2001:db8:2::2/64", "nodad", "dev", "lan0");
			await ip(
				"-6",
				"route",
				"add",
				"default",
				"via",
				"fe80::dead",
				"dev",
				"lan0",
				"onlink",
			);
			await ip(
				"link",
				"add",
				"wwan0",
				"type",
				"veth",
				"peer",
				"name",
				"provider0",
			);
			await ip("link", "set", "provider0", "netns", String(remote.pid));
			await ip(
				"-6",
				"addr",
				"add",
				"2001:db8:1::2/64",
				"nodad",
				"dev",
				"wwan0",
			);
			await ip("link", "set", "wwan0", "up");
			remote.stdin.write("start\n");
			remote.stdin.end();
			await waitFor("PROVIDER_RUNNING\n");
			const row = JSON.parse(await ip("-j", "link", "show", "dev", "wwan0"))[0],
				bootId = (
					await readFile("/proc/sys/kernel/random/boot_id", "ascii")
				).trim(),
				plan = parseCellularIpv6BootstrapPlan({
					owner: "a".repeat(64),
					epoch: "grant-one",
					slot: 1,
					physical: {
						ifname: "wwan0",
						ifindex: String(row.ifindex),
						usbDevice: "synthetic-usb",
						netDevice: "synthetic-net",
						generation: "one",
					},
					bootId,
					source: "2001:db8:1::2",
					gateway: "fe80::1",
					mtu: 1280,
					dns: ["2001:db8::53"],
				}),
				mainBefore = await ip("-6", "-j", "route", "show", "table", "main"),
				forwardingBefore = await readFile(
					"/proc/sys/net/ipv6/conf/all/forwarding",
					"ascii",
				);
			await command("nft", "add", "table", "inet", "fixturetrap");
			await command(
				"nft",
				"add",
				"chain",
				"inet",
				"fixturetrap",
				"output",
				"{ type filter hook output priority -140; policy accept; }",
			);
			await command(
				"nft",
				"add",
				"rule",
				"inet",
				"fixturetrap",
				"output",
				"meta",
				"oif",
				"lan0",
				"udp",
				"dport",
				"53",
				"counter",
			);
			const trap = () =>
				command(
					"nft",
					"--numeric",
					"--json",
					"list",
					"table",
					"inet",
					"fixturetrap",
				);
			const trapBefore = await trap();
			lease = await acquirePrivateStateLease(store, cellularUplinkSlotKey(1));
			if (!lease) throw new Error("Bootstrap fixture slot unavailable");
			const deps = {
					store,
					bootId,
					owned: () => owned,
					currentNow: () => current,
					current: async () => current,
					reserve: async (bytes: number) => bytes === 32768,
					consumersReleased: async () => consumers,
				},
				host = new CellularIpv6Bootstrap(plan, deps);
			try {
				await host.install();
			} catch (cause) {
				throw new Error(
					`Bootstrap kernel install failed: ${await command("nft", "--numeric", "--json", "list", "ruleset")}`,
					{ cause },
				);
			}
			expect(await host.discover()).toBe("64:ff9b::/96");
			await waitFor("QUERY_ANSWERED\n");
			expect(remote.exitCode).toBeNull();
			// Lose only the owned DNS route while leaving lookup+terminal guards intact.
			// The actual source/device socket must neither use the competing main default
			// nor deliver another query through a cross-uplink resolver.
			await ip("-6", "route", "del", "table", "260001", "2001:db8::53/128");
			expect(
				await probeCellularDns({
					source: plan.source,
					device: "wwan0",
					ifindex: row.ifindex,
					dns: plan.dns,
				}),
			).toEqual({ ok: false });
			expect(remote.exitCode).toBeNull();
			expect(await trap()).toBe(trapBefore);
			expect(await host.cleanup()).toBe(true);
			expect(await inventoryCellularHosts(store)).toEqual([]);
			expect(await ip("-6", "-j", "route", "show", "table", "main")).toBe(
				mainBefore,
			);
			expect(
				await readFile("/proc/sys/net/ipv6/conf/all/forwarding", "ascii"),
			).toBe(forwardingBefore);
			// Reconstruct a fresh interrupted discovery from its actual inventory.
			const next = { ...plan, epoch: "grant-two" },
				interrupted = new CellularIpv6Bootstrap(next, deps);
			await interrupted.install();
			current = false;
			consumers = false;
			let retained = 0;
			const recovery = new CellularHostRecovery({
				store,
				bootId: async () => bootId,
				retain: async (authority) => {
					if (authority.kind !== "bootstrap")
						throw new Error("Bootstrap recovery expected");
					retained++;
					return new CellularIpv6Bootstrap(authority.inverse.plan, deps);
				},
			});
			await expect(recovery.replay()).rejects.toThrow("withdrawal incomplete");
			consumers = true;
			await recovery.replay();
			expect(retained).toBe(1);
			expect(await inventoryCellularHosts(store)).toEqual([]);
			expect(await trap()).toBe(trapBefore);
			expect(await ip("-6", "-j", "route", "show", "table", "main")).toBe(
				mainBefore,
			);
		} finally {
			owned = false;
			lease?.release();
			remote.kill("SIGTERM");
			await Promise.race([remote.exited, Bun.sleep(1000)]);
			if (remote.exitCode === null) remote.kill("SIGKILL");
			await remote.exited;
			await reader.cancel();
			await remote.stderr.text();
			await rm(root, { recursive: true, force: true });
		}
	},
	30000,
);
