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
import { acquirePrivateStateLease } from "../helpers/private-state-lease.ts";
import { exchangeSourceBoundDatagram } from "../helpers/source-bound-datagram.ts";
import { readCellularClatAllocation } from "../modules/network/cellular-clat-allocation.ts";
import { CellularClatHost } from "../modules/network/cellular-clat-host.ts";
import { createCellularClatKernelEffects } from "../modules/network/cellular-clat-kernel-effects.ts";
import {
	CellularClatSession,
	parseCellularClatBirthPlan,
} from "../modules/network/cellular-clat-session.ts";
import {
	CellularFirewall,
	cellularFirewallIO,
} from "../modules/network/cellular-firewall.ts";
import { CellularForwardFence } from "../modules/network/cellular-forward-fence.ts";
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
import type { CellularTranslatorState } from "../modules/network/cellular-translator.ts";
import { cellularTranslatorConfigKey } from "../modules/network/cellular-translator.ts";
import { cellularTranslatorConfig } from "../modules/network/cellular-translator-config.ts";
import {
	cellularTunIO,
	createCellularTun,
	inspectCellularTun,
} from "../modules/network/cellular-tun.ts";
import {
	configureCellularTun,
	quiesceCellularTun,
	verifyCellularTunConfiguration,
} from "../modules/network/cellular-tun-configuration.ts";
import {
	cellularTunUnreferenced,
	readCellularTunReferences,
	retireCellularTun,
} from "../modules/network/cellular-tun-retirement.ts";
import { proveCellularUdpZero } from "./helpers/cellular-udp-zero.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const mode = process.env.CERALIVE_CLAT_PACKET_CHILD,
	file = fileURLToPath(import.meta.url),
	binary = process.env.CERALIVE_TAYGA_TEST_BINARY,
	owner = "e".repeat(64),
	grant = {
		owner,
		epoch: "d".repeat(64),
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
async function scoped(
	name: string,
	current: () => Promise<boolean>,
	force = true,
) {
	const link = { ifname: name, current };
	for (const [key, desired] of [
		["accept_ra", "0"],
		["accept_ra_defrtr", "0"],
		["autoconf", "0"],
		["addr_gen_mode", "1"],
		["accept_dad", "0"],
		["disable_ipv6", "0"],
		["forwarding", "1"],
		["force_forwarding", "1"],
		["proxy_ndp", "1"],
	] as const) {
		if (key === "force_forwarding" && !force) continue;
		if (key === "addr_gen_mode" && !name.startsWith("cclat")) continue;
		const before = await readScopedCellularSysctl(link, key);
		if (
			before === undefined ||
			!(await compareAndSetScopedCellularSysctl(link, key, before, desired))
		)
			throw new Error("Fixture per-link IPv6 configuration unavailable");
	}
}
async function startTranslator(
	name: string,
	configuration: string,
	existingConfig?: string,
) {
	if (!binary) throw new Error("Required pinned translator unavailable");
	const root = await mkdtemp(join(tmpdir(), "cellular-packet-translator-")),
		path = existingConfig ?? join(root, "translator.conf");
	if (existingConfig) {
		if ((await Bun.file(path).text()) !== configuration)
			throw new Error("Generated translator configuration changed");
	} else await writeFile(path, configuration, { mode: 0o600 });
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
async function composedHost(physicalIndex: number) {
	const root = await mkdtemp(join(tmpdir(), "cellular-clat-composed-")),
		store = { dir: join(root, "state") },
		lease = await acquirePrivateStateLease(
			{ dir: join(root, "leases") },
			"e".repeat(64),
		);
	if (!lease) throw new Error("Composed fixture lease unavailable");
	let owned = true,
		live = true,
		consumers = false,
		withdrawals = 0,
		child: Awaited<ReturnType<typeof startTranslator>> | undefined;
	const invocation = "f".repeat(32);
	try {
		const physicalBefore: Record<string, string> = {};
		for (const key of [
			"accept_ra",
			"accept_ra_defrtr",
			"forwarding",
			"proxy_ndp",
			"force_forwarding",
		] as const) {
			const value = await readScopedCellularSysctl(
				{ ifname: "wwan6", current: async () => true },
				key,
			);
			if (value === undefined)
				throw new Error("Composed fixture baseline unavailable");
			physicalBefore[key] = value;
		}
		const bootId = (
				await readFile("/proc/sys/kernel/random/boot_id", "utf8")
			).trim(),
			authority = parseCellularClatBirthPlan({
				input: grant,
				physical: {
					ifname: "wwan6",
					ifindex: String(physicalIndex),
					usbDevice: "/sys/devices/fixture-veth",
					netDevice: "/sys/devices/fixture-veth-net",
					generation: "fixture-instance",
				},
				tunEpoch: grant.epoch,
				birth: "1".repeat(32),
				bootId,
				physicalBefore,
				globalForwarding: (
					await readFile("/proc/sys/net/ipv6/conf/all/forwarding", "utf8")
				).trim(),
				dns: [],
			}),
			configPath = join(
				store.dir,
				`${cellularTranslatorConfigKey({ owner, epoch: grant.epoch, slot: 6, birth: authority.birth })}.conf`,
			);
		// Actual kernel effects, private namespace child supervision. PID-1
		// ownership itself remains a separate installed-host qualification gate.
		// Change only the read-only policy observation in this fixture, never the
		// namespace's global forwarding setting.
		let observedForwarding: string = authority.globalForwarding;
		let notified = false;
		const withdraw = () => {
			if (!notified) {
				notified = true;
				withdrawals++;
			}
		};
		const host = new CellularClatSession(authority, {
			store,
			bootId,
			owned: () => owned,
			currentNow: () => live,
			current: async () => live,
			preflight: async () =>
				(await readCellularClatAllocation(
					translated,
					"wwan6",
					async () => live,
				)) === "clear",
			links: cellularTunIO(async () => owned).links,
			createTun: (birth) =>
				createCellularTun(
					birth.input.slot,
					birth.input.owner,
					birth.tunEpoch,
					cellularTunIO(async () => live && host.installingAllowed),
				),
			unreferenced: async (born) =>
				cellularTunUnreferenced(born, await readCellularTunReferences(born)),
			deleteTun: (born) =>
				retireCellularTun(
					{ slot: grant.slot, owner, epoch: authority.tunEpoch },
					born,
					cellularTunIO(async () => owned),
					() => owned,
				),
			withdraw,
			cancelProbe: () => {},
			consumersReleased: async () => consumers,
			release: () => {
				owned = false;
				lease.release();
			},
			child: (childAuthority) =>
				new CellularClatHost(childAuthority, {
					store,
					owned: () => owned,
					currentNow: () => live && host.installingAllowed,
					current: async () => live && host.installingAllowed,
					cancelProbe: () => {},
					withdraw,
					consumersReleased: async () => consumers,
					effects: (captured, routes, guard) =>
						createCellularClatKernelEffects(captured, routes, guard, {
							store,
							bootId,
							forwarding: {
								read: async () => observedForwarding,
								current: () => observedForwarding,
							},
							physicalState: async () => {
								const rows = JSON.parse(await ip("-j", "link", "show"));
								const found = rows.filter(
									(row: { ifindex: number }) => row.ifindex === physicalIndex,
								);
								return found.length === 0
									? "absent"
									: found.length === 1 && found[0].ifname === "wwan6"
										? "present"
										: "foreign";
							},
							translator: {
								inspect: async (expected): Promise<CellularTranslatorState> =>
									!child
										? { kind: "absent" }
										: expected !== undefined && expected !== invocation
											? { kind: "foreign" }
											: {
													kind: "owned",
													running: child.child.exitCode === null,
													invocation,
													pid: child.child.pid,
												},
								start: async () => {
									child = await startTranslator(
										"composed",
										cellularTranslatorConfig(routes),
										configPath,
									);
									return invocation;
								},
								stop: async (expected) => {
									if (expected !== invocation) return false;
									await child?.close();
									child = undefined;
									return true;
								},
							},
						}),
				}),
		});
		await host.install();
		const tun = inspectCellularTun(
			await cellularTunIO(async () => owned).links(),
			grant.slot,
			owner,
			authority.tunEpoch,
		);
		if (typeof tun === "string") throw new Error("Composed TUN birth missing");
		expect(await host.valid()).toBe(true);
		expect(await host.prepareProbe()).toBe(true);
		expect(await host.setReady(true)).toBe(true);
		const packet = {
			device: tun.name,
			ifindex: tun.index,
			source: translated.source,
			remote: "192.0.2.80",
			port: 19000,
			payload: new TextEncoder().encode("composed-clat-return"),
			timeoutMs: 3000,
			maxReplyBytes: 64,
		};
		expect(await exchangeSourceBoundDatagram(packet)).toEqual(packet.payload);
		live = false;
		expect(await host.setReady(true)).toBe(false);
		expect(await host.setReady(false)).toBe(true);
		expect(await host.cleanup()).toBe(false);
		expect(withdrawals).toBe(1);
		expect(
			await exchangeSourceBoundDatagram({ ...packet, timeoutMs: 100 }),
		).toBeUndefined();
		consumers = true;
		await ip("-4", "route", "add", "203.0.113.0/24", "dev", tun.name);
		await expect(host.cleanup()).rejects.toThrow("TUN references retained");
		expect(
			JSON.parse(await ip("-4", "-j", "route", "show", "203.0.113.0/24")),
		).toHaveLength(1);
		expect(owned).toBe(true);
		await ip("-4", "route", "del", "203.0.113.0/24", "dev", tun.name);
		observedForwarding = authority.globalForwarding === "0" ? "1" : "0";
		expect(await host.cleanup()).toBe(false);
		expect(owned).toBe(true);
		// A replacement sharing policy must not inherit an old baseline restoration.
		expect(
			(
				await readFile(
					"/proc/sys/net/ipv6/conf/wwan6/force_forwarding",
					"ascii",
				)
			).trim(),
		).toBe("1");
		observedForwarding = authority.globalForwarding;
		expect(await host.cleanup()).toBe(true);
		expect(owned).toBe(false);
		expect(
			inspectCellularTun(
				await cellularTunIO(async () => true).links(),
				grant.slot,
				owner,
				authority.tunEpoch,
			),
		).toBe("absent");
		expect(withdrawals).toBe(1);
		expect(await readdir(store.dir)).toEqual([]);
		for (const [key, value] of Object.entries(physicalBefore)) {
			expect(
				await readFile(`/proc/sys/net/ipv6/conf/wwan6/${key}`, "utf8"),
			).toBe(`${value}\n`);
		}
	} finally {
		await child?.close();
		owned = false;
		lease.release();
		await rm(root, { recursive: true, force: true });
	}
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
	await ip(
		"-6",
		"route",
		"add",
		"2001:db8:77::/64",
		"via",
		"2001:db8:42::2",
		"dev",
		"provider0",
	);
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
	server.on("message", async (bytes, peer) => {
		count++;
		if (bytes.toString() === "probe-lan6") {
			const index = JSON.parse(
				await ip("-j", "link", "show", "dev", "provider0"),
			)[0].ifindex;
			await exchangeSourceBoundDatagram({
				device: "provider0",
				ifindex: index,
				source: "2001:db8:42::1",
				remote: "2001:db8:77::99",
				port: 19000,
				payload: Uint8Array.of(1),
				timeoutMs: 100,
				maxReplyBytes: 64,
			});
		}
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
			await ip("link", "add", "lan6", "type", "dummy");
			await ip(
				"-6",
				"addr",
				"add",
				"2001:db8:77::2/64",
				"nodad",
				"dev",
				"lan6",
			);
			await ip("link", "set", "lan6", "up");
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
			await scoped("wwan6", async () => true, false);
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
			expect(
				await readCellularClatAllocation(translated, "wwan6", async () => true),
			).toBe("clear");
			await ip("route", "add", "198.18.0.0/15", "dev", "lan0");
			try {
				expect(
					await readCellularClatAllocation(
						translated,
						"wwan6",
						async () => true,
					),
				).toBe("occupied");
			} finally {
				await ip("route", "del", "198.18.0.0/15", "dev", "lan0");
			}
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
			const physical = JSON.parse(
				await ip("-j", "link", "show", "dev", "wwan6"),
			)[0];
			const forward = new CellularForwardFence(
				{
					owner,
					slot: 6,
					tunIndex: tun.index,
					physicalIndex: physical.ifindex,
					mapped: translated.mapped ?? "",
					nat64: translated.nat64 ?? "",
					isolatePhysical: true,
				},
				cellularFirewallIO(current),
			);
			try {
				await forward.create("withdrawn");
			} catch (cause) {
				const raw = await runTestCommand([
					"nft",
					"--numeric",
					"--json",
					"list",
					"table",
					"inet",
					"ceracell_forward_6",
				]);
				throw new Error(`Forward fence did not verify: ${raw.stdout}`, {
					cause,
				});
			}
			const tunConfiguration = {
				slot: 6,
				owner,
				epoch: grant.epoch,
				index: tun.index,
				linkMtu: translated.linkMtu,
			};
			expect(
				await configureCellularTun(tunConfiguration, tunIo, () => true),
			).toBe(true);
			expect(
				await verifyCellularTunConfiguration(
					tunConfiguration,
					tunIo,
					() => true,
				),
			).toBe(true);
			expect(
				JSON.parse(await ip("-j", "addr", "show", "dev", tun.name))[0]
					.addr_info,
			).toEqual([]);
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
			for (const name of ["wwan6"])
				expect(
					await compareAndSetScopedCellularSysctl(
						{ ifname: name, current: async () => true },
						"force_forwarding",
						"0",
						"1",
					),
				).toBe(true);
			await forward.transition("active");
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
			const transit = {
				...packet,
				payload: new TextEncoder().encode("probe-lan6"),
			};
			expect(await exchangeSourceBoundDatagram(transit)).toEqual(
				transit.payload,
			);
			expect(
				JSON.parse(
					await ip(
						"-6",
						"-j",
						"neigh",
						"show",
						"dev",
						"lan6",
						"to",
						"2001:db8:77::99",
					),
				),
			).toEqual([]);
			const forwardRaw = await runTestCommand([
				"nft",
				"--json",
				"list",
				"table",
				"inet",
				"ceracell_forward_6",
			]);
			expect(
				JSON.parse(forwardRaw.stdout)
					.nftables.at(-1)
					?.rule?.expr.find((expr: { counter?: unknown }) => expr.counter)
					?.counter?.packets,
			).toBeGreaterThan(0);
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
			await forward.transition("withdrawn");
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
			expect(
				await changeCellularIndexedIp(
					tun.index,
					{
						kind: "address",
						family: 4,
						address: translated.source,
						prefix: 32,
					},
					"del",
				),
			).toBe(true);
			expect(
				await changeCellularIndexedIp(
					physical.ifindex,
					{ kind: "proxy", family: 6, address: translated.mapped ?? "" },
					"del",
				),
			).toBe(true);
			expect(
				await quiesceCellularTun(tunConfiguration, tunIo, () => true),
			).toBe(true);
			expect(
				await verifyCellularTunConfiguration(
					tunConfiguration,
					tunIo,
					() => true,
				),
			).toBe(false);
			for (const name of ["wwan6"])
				expect(
					await compareAndSetScopedCellularSysctl(
						{ ifname: name, current: async () => true },
						"force_forwarding",
						"1",
						"0",
					),
				).toBe(true);
			expect(await forward.remove()).toBe(true);
			expect(await fence.remove()).toBe(true);
			expect(
				await retireCellularTun(
					{ slot: grant.slot, owner, epoch: grant.epoch },
					tun,
					tunIo,
					() => true,
				),
			).toBe(true);
			await composedHost(physical.ifindex);
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
