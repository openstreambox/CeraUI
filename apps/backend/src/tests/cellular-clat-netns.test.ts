import { expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { readlinkSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { changeLinkByIndex } from "../helpers/netlink-link.ts";
import { exchangeSourceBoundDatagram } from "../helpers/source-bound-datagram.ts";
import {
	CellularFirewall,
	cellularFirewallIO,
} from "../modules/network/cellular-firewall.ts";
import { admitCellularForwarding } from "../modules/network/cellular-forwarding-admission.ts";
import {
	compareAndSetScopedCellularSysctl,
	readScopedCellularSysctl,
} from "../modules/network/cellular-host-identity.ts";
import { changeCellularIndexedIp } from "../modules/network/cellular-indexed-ip.ts";
import {
	CellularIpState,
	cellularIpIO,
} from "../modules/network/cellular-ip-state.ts";
import { planCellularRoutes } from "../modules/network/cellular-route-plan.ts";
import { cellularTranslatorConfig } from "../modules/network/cellular-translator-config.ts";
import {
	cellularTunIO,
	createCellularTun,
	inspectCellularTun,
} from "../modules/network/cellular-tun.ts";
import { proveCellularUdpZero } from "./helpers/cellular-udp-zero.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const mode = process.env.CERALIVE_CLAT_PACKET_CHILD,
	file = fileURLToPath(import.meta.url),
	binary = process.env.CERALIVE_TAYGA_TEST_BINARY,
	owner = "e".repeat(64),
	grant = {
		owner,
		epoch: "packet-one",
		slot: 6,
		iface: "wwan6",
		mtu: 1280,
		ipv6: "2001:db8:42::2",
		ipv6PrefixLength: 64,
		ipv6Gateway: "2001:db8:42::1",
		nat64: "2001:db8:64::/96",
	},
	plan = planCellularRoutes(grant);
if (!plan?.mapped || !plan.tun) throw new Error("Missing packet fixture plan");
const translated = plan;
if (mode) {
	const net =
			mode === "provider"
				? process.env.CERALIVE_CLAT_HOST_NS
				: process.env.CELLULAR_PACKET_HOST_NS,
		mount = process.env.CELLULAR_PACKET_HOST_MNTNS;
	if (
		!["host", "provider"].includes(mode) ||
		!net ||
		!mount ||
		readlinkSync("/proc/self/ns/net") === net ||
		readlinkSync("/proc/self/ns/mnt") === mount
	)
		throw new Error("CLAT fixture requires owned network and mount namespaces");
}
const ip = async (...argv: string[]) => {
	const result = await runTestCommand(["ip", ...argv]);
	if (result.code) throw new Error(result.stderr);
	return result.stdout;
};
async function scoped(name: string, current: () => Promise<boolean>) {
	const link = { ifname: name, current };
	for (const [key, desired] of [
		["accept_ra", "0"],
		["accept_ra_defrtr", "0"],
		["autoconf", "0"],
		["accept_dad", "0"],
		["disable_ipv6", "0"],
		["forwarding", "1"],
		["force_forwarding", "1"],
		["proxy_ndp", "1"],
	] as const) {
		const before = await readScopedCellularSysctl(link, key);
		if (
			before === undefined ||
			!(await compareAndSetScopedCellularSysctl(link, key, before, desired))
		)
			throw new Error("Fixture per-link IPv6 configuration unavailable");
	}
}
async function startTranslator(name: string, configuration: string) {
	if (!binary) throw new Error("Required pinned translator unavailable");
	const root = await mkdtemp(join(tmpdir(), "cellular-packet-translator-")),
		path = join(root, "translator.conf");
	await writeFile(path, configuration, { mode: 0o600 });
	const child = Bun.spawn([binary, "--config", path, "--nodetach"], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const tun = /^tun-device (cclat\d+)$/m.exec(configuration)?.[1];
	let attached = false;
	for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt++) {
		const files = await readdir(`/proc/${child.pid}/fdinfo`).catch(() => []);
		for (const file of files.slice(0, 64)) {
			const info = await readFile(
				`/proc/${child.pid}/fdinfo/${file}`,
				"utf8",
			).catch(() => "");
			if (tun && new RegExp(`^iff:\\s*${tun}$`, "m").test(info))
				attached = true;
		}
		if (attached) break;
		await Bun.sleep(10);
	}
	if (!attached) {
		child.kill("SIGKILL");
		await child.exited;
		await rm(root, { recursive: true, force: true });
		throw new Error(
			`${name} translator did not attach: ${await new Response(child.stderr).text()}`,
		);
	}
	return {
		child,
		close: async () => {
			child.kill("SIGTERM");
			await Promise.race([child.exited, Bun.sleep(1000)]);
			if (child.exitCode === null) child.kill("SIGKILL");
			await child.exited;
			const error = await new Response(child.stderr).text();
			await rm(root, { recursive: true, force: true });
			if (child.exitCode && child.exitCode !== 143 && child.exitCode !== 137)
				throw new Error(`${name} translator failed: ${error}`);
		},
	};
}
async function provider() {
	if (readlinkSync("/proc/self/ns/net") === process.env.CERALIVE_CLAT_HOST_NS)
		throw new Error("Provider must own a separate namespace");
	process.stdout.write("CLAT_PROVIDER_READY\n");
	const input = await new Response(Bun.stdin.stream()).text();
	if (input !== "start\n") throw new Error("Invalid fixture handoff");
	await ip("link", "set", "lo", "up");
	await ip("addr", "add", "192.0.2.80/32", "dev", "lo");
	await scoped("provider0", async () => true);
	await ip(
		"-6",
		"addr",
		"add",
		"2001:db8:42::1/64",
		"nodad",
		"dev",
		"provider0",
	);
	await ip("link", "set", "provider0", "up");
	const tun = await createCellularTun(
		31,
		"f".repeat(64),
		"provider-one",
		cellularTunIO(async () => true),
	);
	await scoped(tun.name, async () => true);
	if (!(await changeLinkByIndex(tun.index, { kind: "up", up: true })))
		throw new Error("Provider TUN unavailable");
	await ip("-6", "route", "add", "2001:db8:64::/96", "dev", tun.name);
	await ip("-4", "route", "add", `${translated.source}/32`, "dev", tun.name);
	const translator = await startTranslator(
			"provider",
			`tun-device ${tun.name}\nipv4-addr 192.0.0.201\nipv6-addr fd00:434c::f1\nprefix 2001:db8:64::/96\nmap ${translated.source} ${translated.mapped}\n`,
		),
		server = createSocket("udp4");
	let count = 0;
	server.on("message", (bytes, peer) => {
		count++;
		server.send(bytes, peer.port, peer.address);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.bind(19000, "192.0.2.80", resolve);
	});
	process.stdout.write("CLAT_PROVIDER_RUNNING\n");
	let finish: () => void = () => {};
	const stopped = new Promise<void>((resolve) => {
			finish = resolve;
		}),
		timer = setTimeout(finish, 20_000);
	process.once("SIGTERM", finish);
	try {
		await stopped;
	} finally {
		clearTimeout(timer);
		process.off("SIGTERM", finish);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await translator.close();
		process.stdout.write(`CLAT_PROVIDER_PACKETS=${count}\n`);
		process.stderr.write(
			JSON.stringify({
				packets: count,
				links: JSON.parse(await ip("-s", "-j", "link", "show")),
				routes4: JSON.parse(
					await ip("-4", "-j", "route", "show", "table", "all"),
				),
				routes6: JSON.parse(
					await ip("-6", "-j", "route", "show", "table", "all"),
				),
				neighbours: JSON.parse(await ip("-6", "-j", "neigh", "show")),
				stats: await Bun.file("/proc/net/snmp6").text(),
			}),
		);
	}
}
const missing = ["unshare", "mount", "ip", "nft", "tcpdump"].some(
		(name) => !Bun.which(name),
	),
	privilege =
		mode || missing
			? undefined
			: await runTestCommand(["unshare", "-Urnm", "true"]),
	unavailable = !binary || missing || (!mode && privilege?.code !== 0);
if (unavailable && process.env.CERALIVE_REQUIRE_CELLULAR_TRANSLATOR === "1")
	throw new Error("Required CLAT packet namespace unavailable");
(unavailable ? test.skip : test)(
	"CLAT crosses an independent NAT64 provider and withdraws without a LAN fallback",
	async () => {
		if (mode === "provider") {
			await provider();
			return;
		}
		if (mode !== "host") {
			const refused = await runTestCommand([process.execPath, "test", file], {
				env: {
					CERALIVE_CLAT_PACKET_CHILD: "host",
					CELLULAR_PACKET_HOST_NS: "",
					CELLULAR_PACKET_HOST_MNTNS: "",
				},
			});
			expect(refused.code).not.toBe(0);
			expect(refused.stderr).toContain(
				"requires owned network and mount namespaces",
			);
			const root = await mkdtemp(join(tmpdir(), "cellular-clat-packet-root-"));
			await mkdir(join(root, "tmp"), { mode: 0o700 });
			try {
				const result = await runTestCommand(
					[
						"unshare",
						"-Urnm",
						"sh",
						"-c",
						'mount --make-rprivate / && mount --bind "$1" /var && exec "$2" test "$3"',
						"cellular-clat-packet",
						root,
						process.execPath,
						file,
					],
					{
						cwd: root,
						env: {
							CERALIVE_CLAT_PACKET_CHILD: "host",
							CELLULAR_PACKET_HOST_NS: readlinkSync("/proc/self/ns/net"),
							CELLULAR_PACKET_HOST_MNTNS: readlinkSync("/proc/self/ns/mnt"),
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
		if (
			readlinkSync("/proc/self/ns/net") ===
				process.env.CELLULAR_PACKET_HOST_NS ||
			readlinkSync("/proc/self/ns/mnt") ===
				process.env.CELLULAR_PACKET_HOST_MNTNS
		)
			throw new Error("CLAT fixture must own network and mount namespaces");
		const providerProcess = Bun.spawn(
			["unshare", "-n", process.execPath, "test", file],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					CERALIVE_CLAT_PACKET_CHILD: "provider",
					CERALIVE_CLAT_HOST_NS: readlinkSync("/proc/self/ns/net"),
				},
			},
		);
		const reader = providerProcess.stdout.getReader();
		let output = "",
			packetFailed = false,
			translator: Awaited<ReturnType<typeof startTranslator>> | undefined,
			providerFailure: string | undefined;
		const waitFor = async (marker: string) => {
			while (!output.includes(marker)) {
				const next = await Promise.race([
					reader.read(),
					Bun.sleep(5000).then(() => {
						throw new Error("Provider readiness timeout");
					}),
				]);
				if (next.done)
					throw new Error(
						`Provider ended: ${output}\n${await new Response(providerProcess.stderr).text()}`,
					);
				output += new TextDecoder().decode(next.value);
				if (output.length > 4096)
					throw new Error("Provider output exceeded bound");
			}
		};
		try {
			await waitFor("CLAT_PROVIDER_READY\n");
			await ip("link", "set", "lo", "up");
			await ip("link", "add", "lan0", "type", "dummy");
			const lan = { ifname: "lan0", current: async () => true },
				lanIpv6 = await readScopedCellularSysctl(lan, "disable_ipv6");
			if (
				lanIpv6 === undefined ||
				!(await compareAndSetScopedCellularSysctl(
					lan,
					"disable_ipv6",
					lanIpv6,
					"1",
				))
			)
				throw new Error("Fixture LAN IPv6 isolation unavailable");
			await ip("addr", "add", "192.0.2.2/24", "dev", "lan0");
			await ip("link", "set", "lan0", "up");
			await ip("route", "add", "default", "via", "192.0.2.1", "dev", "lan0");
			const mainBefore = await ip("-j", "-4", "route", "show", "table", "main"),
				forwardBefore = await Bun.file(
					"/proc/sys/net/ipv6/conf/all/forwarding",
				).text();
			await ip(
				"link",
				"add",
				"wwan6",
				"type",
				"veth",
				"peer",
				"name",
				"provider0",
			);
			await ip(
				"link",
				"set",
				"provider0",
				"netns",
				String(providerProcess.pid),
			);
			await ip("link", "set", "wwan6", "mtu", String(grant.mtu));
			await scoped("wwan6", async () => true);
			await ip(
				"-6",
				"addr",
				"add",
				`${grant.ipv6}/64`,
				"nodad",
				"dev",
				"wwan6",
			);
			await ip("link", "set", "wwan6", "up");
			providerProcess.stdin.write("start\n");
			providerProcess.stdin.end();
			await waitFor("CLAT_PROVIDER_RUNNING\n");
			const tunIo = cellularTunIO(async () => true),
				tun = await createCellularTun(6, owner, grant.epoch, tunIo),
				current = async () => {
					const row = inspectCellularTun(
						await tunIo.links(),
						6,
						owner,
						grant.epoch,
					);
					return typeof row !== "string" && row.index === tun.index;
				};
			await scoped(tun.name, current);
			const rpfBefore = await Bun.file(
					"/proc/sys/net/ipv4/conf/all/rp_filter",
				).text(),
				tunRpfBefore = await Bun.file(
					`/proc/sys/net/ipv4/conf/${tun.name}/rp_filter`,
				).text();
			expect(Math.max(Number(rpfBefore), Number(tunRpfBefore))).toBeGreaterThan(
				0,
			);
			expect(
				await admitCellularForwarding(
					{ ifname: "wwan6", current: async () => true },
					{ ifname: tun.name, current },
				),
			).toMatchObject({ ok: true, mode: "per-link" });
			expect(
				await changeLinkByIndex(tun.index, {
					kind: "mtu",
					mtu: translated.linkMtu,
				}),
			).toBe(true);
			expect(await changeLinkByIndex(tun.index, { kind: "up", up: true })).toBe(
				true,
			);
			const fence = new CellularFirewall(
				{
					owner,
					slot: 6,
					source: translated.source,
					ifindex: tun.index,
					dns: [],
					translated: true,
				},
				cellularFirewallIO(current),
			);
			await fence.create("withdrawn");
			expect(
				await changeCellularIndexedIp(
					tun.index,
					{
						kind: "address",
						family: 4,
						address: translated.source,
						prefix: 32,
					},
					"add",
				),
			).toBe(true);
			const physical = JSON.parse(
				await ip("-j", "link", "show", "dev", "wwan6"),
			)[0];
			expect(
				await changeCellularIndexedIp(
					physical.ifindex,
					{ kind: "proxy", family: 6, address: translated.mapped ?? "" },
					"add",
				),
			).toBe(true);
			const state = new CellularIpState(translated, cellularIpIO(current));
			for (const effect of translated.effects.filter((row) => row.terminal))
				await state.apply(effect);
			translator = await startTranslator(
				"clat",
				cellularTranslatorConfig(translated),
			);
			for (const effect of translated.effects.filter((row) => !row.terminal)) {
				try {
					await state.apply(effect);
				} catch (cause) {
					throw new Error(
						JSON.stringify({
							effect,
							routes: JSON.parse(
								await ip(
									`-${effect.family}`,
									"-N",
									"-j",
									"route",
									"show",
									"table",
									"all",
								),
							),
							rules: JSON.parse(
								await ip(`-${effect.family}`, "-N", "-j", "rule", "show"),
							),
						}),
						{ cause },
					);
				}
			}
			await fence.transition("ready");
			const packet = {
				device: tun.name,
				ifindex: tun.index,
				source: translated.source,
				remote: "192.0.2.80",
				port: 19000,
				payload: new TextEncoder().encode("cellular-clat-return"),
				maxReplyBytes: 64,
				timeoutMs: 3000,
			};
			const reply = await exchangeSourceBoundDatagram(packet);
			packetFailed = !reply;
			expect(
				reply,
				JSON.stringify({
					links: JSON.parse(await ip("-s", "-j", "link", "show")),
					rules6: JSON.parse(await ip("-6", "-j", "rule", "show")),
					neighbours: JSON.parse(await ip("-6", "-j", "neigh", "show")),
					stats: await Bun.file("/proc/net/snmp6").text(),
				}),
			).toEqual(packet.payload);
			for (const name of [tun.name, "wwan6"]) {
				const link = { ifname: name, current: async () => true };
				expect(
					await compareAndSetScopedCellularSysctl(
						link,
						"force_forwarding",
						"1",
						"0",
					),
				).toBe(true);
				expect(
					await exchangeSourceBoundDatagram({ ...packet, timeoutMs: 100 }),
				).toBeUndefined();
				expect(
					await compareAndSetScopedCellularSysctl(
						link,
						"force_forwarding",
						"0",
						"1",
					),
				).toBe(true);
			}
			expect(await exchangeSourceBoundDatagram(packet)).toEqual(packet.payload);
			const lanTx = async () => {
					const rows = JSON.parse(
						await ip("-s", "-j", "link", "show", "dev", "lan0"),
					);
					const count = rows[0]?.stats64?.tx?.packets;
					if (rows.length !== 1 || !Number.isSafeInteger(count))
						throw new Error("Fixture LAN counters unavailable");
					return count as number;
				},
				lanBefore = await lanTx();
			await proveCellularUdpZero({
				index: tun.index,
				tun: tun.name,
				physical: "wwan6",
				source: translated.source,
				remote: packet.remote,
				mapped: translated.mapped ?? "",
				nat64: translated.nat64 ?? "",
			});
			const lanIndex = JSON.parse(
					await ip("-j", "link", "show", "dev", "lan0"),
				)[0].ifindex,
				alias = {
					kind: "address",
					family: 4,
					address: translated.source,
					prefix: 32,
				} as const;
			// A deliberate collision lets the wrong-device socket bind. The ready
			// fence must still stop IPv4's explicit-oif on-link fallback.
			expect(await changeCellularIndexedIp(lanIndex, alias, "add")).toBe(true);
			try {
				expect(
					await exchangeSourceBoundDatagram({
						...packet,
						device: "lan0",
						ifindex: lanIndex,
						timeoutMs: 100,
					}),
				).toBeUndefined();
				expect(await lanTx()).toBe(lanBefore);
				const raw = await runTestCommand([
					"nft",
					"--json",
					"list",
					"table",
					"inet",
					"ceracell_6",
				]);
				const drop = JSON.parse(raw.stdout)
					.nftables.at(-1)
					?.rule?.expr.find(
						(expr: { counter?: { packets: number } }) => expr.counter,
					)?.counter?.packets;
				expect(drop).toBeGreaterThan(0);
			} finally {
				expect(await changeCellularIndexedIp(lanIndex, alias, "del")).toBe(
					true,
				);
			}
			await fence.transition("withdrawn");
			expect(
				await exchangeSourceBoundDatagram({ ...packet, timeoutMs: 100 }),
			).toBeUndefined();
			for (const effect of [...translated.effects].reverse())
				expect(await state.remove(effect)).toBe(true);
			expect(
				await exchangeSourceBoundDatagram({ ...packet, timeoutMs: 100 }),
			).toBeUndefined();
			expect(await lanTx()).toBe(lanBefore);
			expect(await ip("-j", "-4", "route", "show", "table", "main")).toBe(
				mainBefore,
			);
			expect(
				await Bun.file("/proc/sys/net/ipv6/conf/all/forwarding").text(),
			).toBe(forwardBefore);
			expect(
				await Bun.file("/proc/sys/net/ipv4/conf/all/rp_filter").text(),
			).toBe(rpfBefore);
			expect(
				await Bun.file(`/proc/sys/net/ipv4/conf/${tun.name}/rp_filter`).text(),
			).toBe(tunRpfBefore);
			await translator.close();
			translator = undefined;
			expect(await fence.remove()).toBe(true);
		} finally {
			await translator?.close();
			providerProcess.kill("SIGTERM");
			await Promise.race([providerProcess.exited, Bun.sleep(1500)]);
			if (providerProcess.exitCode === null) providerProcess.kill("SIGKILL");
			await providerProcess.exited;
			reader.releaseLock();
			if (packetFailed)
				process.stderr.write(await new Response(providerProcess.stderr).text());
			if (providerProcess.exitCode !== 0)
				providerFailure = await new Response(providerProcess.stderr).text();
		}
		if (providerFailure !== undefined)
			throw new Error(`Provider failed: ${providerFailure}`);
	},
	30_000,
);
