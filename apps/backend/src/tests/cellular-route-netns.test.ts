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
import { setLinkUpByIndex } from "../helpers/link-up-by-index.ts";
import { changeLinkByIndex } from "../helpers/netlink-link.ts";
import { acquirePrivateStateLease } from "../helpers/private-state-lease.ts";
import { exchangeSourceBoundDatagram } from "../helpers/source-bound-datagram.ts";
import { CellularHostRecovery } from "../modules/modems/cellular-host-recovery.ts";
import {
	CellularFirewall,
	cellularFirewallIO,
} from "../modules/network/cellular-firewall.ts";
import {
	compareAndSetScopedCellularSysctl,
	readScopedCellularSysctl,
} from "../modules/network/cellular-host-identity.ts";
import { changeCellularIndexedIp } from "../modules/network/cellular-indexed-ip.ts";
import {
	CellularIndexedIpState,
	cellularIndexedIpIO,
} from "../modules/network/cellular-indexed-ip-state.ts";
import {
	CellularIpState,
	cellularIpIO,
} from "../modules/network/cellular-ip-state.ts";
import { CellularNativeHost } from "../modules/network/cellular-native-host.ts";
import {
	cellularFenceDefinition,
	inspectCellularFence,
} from "../modules/network/cellular-packet-fence.ts";
import {
	type CellularIpEffect,
	cellularIpArgv,
	planCellularRoutes,
} from "../modules/network/cellular-route-plan.ts";
import { cellularTranslatorConfig } from "../modules/network/cellular-translator-config.ts";
import {
	cellularTunIO,
	createCellularTun,
	inspectCellularTun,
} from "../modules/network/cellular-tun.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const child = process.env.CERALIVE_CELLULAR_ROUTE_CHILD === "1";
const translatorBinary = process.env.CERALIVE_TAYGA_TEST_BINARY;
if (
	!translatorBinary &&
	process.env.CERALIVE_REQUIRE_CELLULAR_TRANSLATOR === "1"
)
	throw new Error("Required pinned translator unavailable");
const missing = ["unshare", "mount", "ip", "nft"].some(
	(binary) => !Bun.which(binary),
);
const privilege =
	child || missing
		? undefined
		: await runTestCommand(["unshare", "-Urnm", "true"]);
const unavailable = missing || (privilege?.code !== 0 && !child);
if (unavailable && process.env.CERALIVE_REQUIRE_CELLULAR_NETNS === "1")
	throw new Error("Required cellular routing namespace unavailable");
(unavailable ? test.skip : test)(
	"cellular source routes survive duplicate grants and fail closed without changing the LAN default",
	async () => {
		if (!child) {
			const root = await mkdtemp(join(tmpdir(), "cellular-route-root-"));
			await mkdir(join(root, "tmp"), { mode: 0o700 });
			try {
				const result = await runTestCommand(
					[
						"unshare",
						"-Urnm",
						"sh",
						"-c",
						'mount --make-rprivate / && mount --bind "$1" /var && exec "$2" test "$3"',
						"cellular-route",
						root,
						process.execPath,
						fileURLToPath(import.meta.url),
					],
					{
						cwd: root,
						env: {
							CERALIVE_CELLULAR_ROUTE_CHILD: "1",
							CELLULAR_HOST_NETNS: readlinkSync("/proc/self/ns/net"),
							CELLULAR_HOST_MNTNS: readlinkSync("/proc/self/ns/mnt"),
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
			!process.env.CELLULAR_HOST_NETNS ||
			readlinkSync("/proc/self/ns/net") === process.env.CELLULAR_HOST_NETNS
		)
			throw new Error("Routing fixture must not use the host namespace");
		if (
			!process.env.CELLULAR_HOST_MNTNS ||
			readlinkSync("/proc/self/ns/mnt") === process.env.CELLULAR_HOST_MNTNS
		)
			throw new Error("Routing fixture must not use the host mount namespace");
		const ip = async (...argv: string[]) => {
			const result = await runTestCommand(["ip", ...argv]);
			if (result.code) throw new Error(result.stderr);
			return result.stdout;
		};
		const apply = async (state: CellularIpState, effect: CellularIpEffect) => {
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
		};
		await ip("link", "set", "lo", "up");
		const tunOwner = "c".repeat(64),
			tunIo = cellularTunIO(async () => true);
		const born = await createCellularTun(3, tunOwner, "one", tunIo);
		expect(born.persistent).toBe(true);
		const allForwarding = await Bun.file(
			"/proc/sys/net/ipv6/conf/all/forwarding",
		).text();
		const scopedTun = {
			ifname: born.name,
			current: async () => {
				const observed = inspectCellularTun(
					await tunIo.links(),
					3,
					tunOwner,
					"one",
				);
				return (
					typeof observed !== "string" &&
					observed.index === born.index &&
					observed.alias === born.alias &&
					observed.persistent
				);
			},
		};
		for (const [key, desired] of [
			["accept_ra", "0"],
			["accept_ra_defrtr", "0"],
			["autoconf", "0"],
			["accept_dad", "0"],
			["disable_ipv6", "0"],
			["forwarding", "1"],
		] as const) {
			const original = await readScopedCellularSysctl(scopedTun, key);
			if (original === undefined)
				throw new Error(
					`Owned TUN sysctl unavailable: ${key}=${await Bun.file(`/proc/sys/net/ipv6/conf/${born.name}/${key}`).text()}`,
				);
			expect(
				await compareAndSetScopedCellularSysctl(
					scopedTun,
					key,
					original,
					desired,
				),
			).toBe(true);
		}
		expect(
			await Bun.file("/proc/sys/net/ipv6/conf/all/forwarding").text(),
		).toBe(allForwarding);
		if (translatorBinary) {
			const configPlan = planCellularRoutes({
				owner: tunOwner,
				epoch: "one",
				slot: 3,
				iface: "wwan0",
				mtu: 1428,
				ipv6: "2001:db8:1::2",
				ipv6PrefixLength: 64,
				ipv6Gateway: "fe80::1",
				nat64: "2001:db8:64::/96",
			});
			if (!configPlan) throw new Error("Missing real translator config");
			const root = await mkdtemp(join(tmpdir(), "cellular-translator-attach-")),
				config = join(root, "translator.conf");
			await writeFile(config, cellularTranslatorConfig(configPlan), {
				mode: 0o600,
			});
			await using translatorProcess = Bun.spawn(
				[translatorBinary, "--config", config, "--nodetach"],
				{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
			);
			try {
				let attached = false;
				for (let attempt = 0; attempt < 40; attempt++) {
					if (translatorProcess.exitCode !== null) break;
					const files = await readdir(
						`/proc/${translatorProcess.pid}/fdinfo`,
					).catch(() => []);
					for (const file of files.slice(0, 64)) {
						const info = await readFile(
							`/proc/${translatorProcess.pid}/fdinfo/${file}`,
							"utf8",
						).catch(() => "");
						if (/^iff:\s*cclat3$/m.test(info)) attached = true;
					}
					if (attached) break;
					await Bun.sleep(25);
				}
				expect(
					attached,
					"Pinned translator must attach the owned PI-framed TUN",
				).toBe(true);
				expect(
					inspectCellularTun(await tunIo.links(), 3, tunOwner, "one"),
				).toEqual(born);
			} finally {
				translatorProcess.kill("SIGTERM");
				await Promise.race([translatorProcess.exited, Bun.sleep(1500)]);
				if (translatorProcess.exitCode === null)
					translatorProcess.kill("SIGKILL");
				await translatorProcess.exited;
				await rm(root, { recursive: true, force: true });
			}
		}

		await expect(createCellularTun(3, tunOwner, "one", tunIo)).rejects.toThrow(
			"occupied",
		);
		const indexed4 = {
				kind: "address",
				family: 4,
				address: "198.18.255.3",
				prefix: 32,
			} as const,
			indexed6 = {
				kind: "address",
				family: 6,
				address: "fd00:434c::3",
				prefix: 128,
			} as const,
			proxy6 = {
				kind: "proxy",
				family: 6,
				address: "2001:db8:1::1234",
			} as const,
			mainBeforeAddresses = await ip(
				"-j",
				"-4",
				"route",
				"show",
				"table",
				"main",
			);
		expect(
			await changeLinkByIndex(born.index, { kind: "mtu", mtu: 1408 }),
		).toBe(true);
		expect(await changeCellularIndexedIp(born.index, indexed4, "add")).toBe(
			true,
		);
		expect(await changeCellularIndexedIp(born.index, indexed6, "add")).toBe(
			true,
		);
		expect(await changeCellularIndexedIp(born.index, proxy6, "add")).toBe(true);
		expect(await changeCellularIndexedIp(born.index, indexed4, "add")).toBe(
			false,
		);
		const indexedState = new CellularIndexedIpState(
			{ name: born.name, index: born.index },
			[indexed4, indexed6, proxy6],
			cellularIndexedIpIO(
				async () => ((await scopedTun.current()) ? "present" : "foreign"),
				() => true,
			),
		);
		for (const effect of [indexed4, indexed6, proxy6]) {
			expect(
				await indexedState.inspect(effect),
				JSON.stringify({
					effect,
					addresses: JSON.parse(
						await ip("-j", "addr", "show", "dev", born.name),
					),
					proxy: JSON.parse(
						await ip("-6", "-j", "neigh", "show", "proxy", "dev", born.name),
					),
				}),
			).toBe("owned");
			await expect(indexedState.apply(effect)).rejects.toThrow("birth changed");
		}
		const indexedAddresses = JSON.parse(
			await ip("-j", "addr", "show", "dev", born.name),
		);
		expect(indexedAddresses[0].mtu).toBe(1408);
		expect(indexedAddresses[0].addr_info).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					family: "inet",
					local: indexed4.address,
					prefixlen: 32,
					noprefixroute: true,
				}),
				expect.objectContaining({
					family: "inet6",
					local: indexed6.address,
					prefixlen: 128,
					nodad: true,
					noprefixroute: true,
				}),
			]),
		);
		expect(
			JSON.parse(
				await ip("-6", "-j", "neigh", "show", "proxy", "dev", born.name),
			),
		).toEqual([expect.objectContaining({ dst: proxy6.address, proxy: null })]);
		expect(await ip("-j", "-4", "route", "show", "table", "main")).toBe(
			mainBeforeAddresses,
		);
		await ip("link", "set", "dev", born.name, "name", "retiredtun");
		await ip("link", "add", born.name, "type", "dummy");
		await ip("addr", "add", "192.0.2.123/32", "dev", born.name);
		for (const effect of [indexed4, indexed6, proxy6])
			expect(await changeCellularIndexedIp(born.index, effect, "del")).toBe(
				true,
			);
		expect(
			JSON.parse(await ip("-j", "addr", "show", "dev", born.name))[0].addr_info,
		).toEqual([expect.objectContaining({ local: "192.0.2.123" })]);
		expect(await changeLinkByIndex(born.index, { kind: "delete" })).toBe(true);
		expect(await changeCellularIndexedIp(born.index, indexed4, "add")).toBe(
			false,
		);
		await ip("link", "delete", "dev", born.name);
		expect(inspectCellularTun(await tunIo.links(), 3, tunOwner, "one")).toBe(
			"absent",
		);
		let current = true;
		await expect(
			createCellularTun(4, tunOwner, "one", {
				current: async () => current,
				links: async () => {
					const raw = await tunIo.links();
					if (Array.isArray(raw) && raw.some((row) => row.ifname === "cclat4"))
						current = false;
					return raw;
				},
			}),
		).rejects.toThrow("identity changed");
		expect(inspectCellularTun(await tunIo.links(), 4, tunOwner, "one")).toBe(
			"absent",
		);

		for (const name of ["wwan0", "wwan1", "lan0", "cclat1"]) {
			await ip("link", "add", name, "type", "dummy");
			// Keep IPv4 packet counters free of asynchronous IPv6 DAD/RS traffic.
			// The IPv6 routing phase assigns its own explicit, non-tentative address.
			await ip("link", "set", "dev", name, "addrgenmode", "none");
			await ip("link", "set", name, "up");
		}
		await ip("addr", "add", "198.51.100.1/24", "dev", "lan0");
		await ip("route", "add", "default", "dev", "lan0");
		const server = createSocket("udp4");
		let received = 0,
			observedSource = "";
		server.on("message", (message, remote) => {
			received++;
			observedSource = remote.address;
			server.send(
				message[0] === 2 ? Buffer.alloc(4097) : message,
				remote.port,
				remote.address,
			);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.bind(0, "127.0.0.1", resolve);
		});
		try {
			const endpoint = server.address();
			if (typeof endpoint === "string")
				throw new Error("Missing UDP fixture address");
			const packet = {
				device: "lo",
				source: "127.0.0.2",
				remote: "127.0.0.1",
				port: endpoint.port,
				payload: Uint8Array.of(1),
				timeoutMs: 200,
				maxReplyBytes: 4096,
			};
			expect(await exchangeSourceBoundDatagram(packet)).toEqual(
				Uint8Array.of(1),
			);
			expect(observedSource).toBe("127.0.0.2");
			expect(
				await exchangeSourceBoundDatagram({
					...packet,
					payload: Uint8Array.of(2),
				}),
			).toBeUndefined();
			expect(
				await exchangeSourceBoundDatagram({ ...packet, device: "wwan0" }),
			).toBeUndefined();
			expect(received).toBe(2);
		} finally {
			server.close();
		}

		const index = Number(
			JSON.parse(await ip("-j", "link", "show", "dev", "wwan0"))[0].ifindex,
		);
		expect(await setLinkUpByIndex(index, false)).toBe(true);
		expect(
			JSON.parse(await ip("-j", "link", "show", "dev", "wwan0"))[0].flags,
		).not.toContain("UP");
		expect(await setLinkUpByIndex(index, true)).toBe(true);
		expect(
			JSON.parse(await ip("-j", "link", "show", "dev", "wwan0"))[0].flags,
		).toContain("UP");
		expect(await setLinkUpByIndex(0x7fffffff, false)).toBe(false);
		const fence = {
			owner: "a".repeat(64),
			slot: 1,
			source: "192.0.2.2",
			ifindex: index,
			translated: false,
			dns: [],
		};
		const nft = async (text: string) => {
			const child = Bun.spawn(["nft", "-f", "-"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			child.stdin.write(text);
			await child.stdin.end();
			const [code, error] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
			]);
			if (code !== 0) throw new Error(error);
		};
		const firewallIo = cellularFirewallIO(async () => true);
		let firewallReadback = "";
		const firewall = new CellularFirewall(fence, {
			...firewallIo,
			read: async (argv) => {
				firewallReadback = await firewallIo.read(argv);
				return firewallReadback;
			},
		});
		try {
			await firewall.create("probe");
		} catch (cause) {
			throw new Error(firewallReadback, { cause });
		}
		expect(await firewall.inspect()).toBe("probe");
		await firewall.transition("ready");
		expect(await firewall.inspect()).toBe("ready");
		const mainBefore = await ip("-j", "-4", "route", "show", "table", "main");
		const lanBefore = await ip(
			"-j",
			"route",
			"get",
			"203.0.113.1",
			"from",
			"198.51.100.99",
			"iif",
			"lan0",
		);
		const a = planCellularRoutes({
			owner: "a".repeat(64),
			epoch: "one",
			slot: 1,
			iface: "wwan0",
			mtu: 1428,
			ipv4: "192.0.2.2",
		});
		const b = planCellularRoutes({
			owner: "b".repeat(64),
			epoch: "one",
			slot: 2,
			iface: "wwan1",
			mtu: 1428,
			ipv4: "192.0.2.2",
		});
		if (!a || !b) throw new Error("Missing native plans");
		for (const plan of [a, b]) {
			await ip(
				"addr",
				"add",
				`${plan.source}/32`,
				"dev",
				plan.device,
				"noprefixroute",
			);
			const state = new CellularIpState(
				plan,
				cellularIpIO(async () => true),
			);
			for (const effect of plan.effects) await apply(state, effect);
		}
		const tx = async (name: string) =>
			Number(
				JSON.parse(await ip("-s", "-j", "link", "show", "dev", name))[0].stats64
					.tx.packets,
			);
		const packet = {
			device: "wwan0",
			source: "192.0.2.2",
			remote: "203.0.113.1",
			port: 53,
			payload: Uint8Array.of(1),
			timeoutMs: 30,
			maxReplyBytes: 4096,
		};
		for (const name of ["wwan0", "wwan1"]) {
			const before = await tx(name);
			await exchangeSourceBoundDatagram({ ...packet, device: name });
			expect(await tx(name)).toBeGreaterThan(before);
		}

		expect(await ip("-j", "-4", "route", "show", "table", "main")).toBe(
			mainBefore,
		);
		expect(
			await ip(
				"-j",
				"route",
				"get",
				"203.0.113.1",
				"from",
				"198.51.100.99",
				"iif",
				"lan0",
			),
		).toBe(lanBefore);
		// Withdraw the data-plane fence BEFORE routing teardown. A FIB error alone
		// does not stop Linux's explicit-device on-link output fallback.
		await firewall.transition("withdrawn");
		for (const effect of a.effects
			.filter((effect) => !effect.terminal)
			.reverse())
			await ip(...cellularIpArgv(effect, "del"));
		const blockedBefore = await tx("wwan0"),
			goodBefore = await tx("wwan1"),
			lanTxBefore = await tx("lan0");
		await exchangeSourceBoundDatagram(packet);
		const fenceState = await runTestCommand([
			"nft",
			"--numeric",
			"--json",
			"list",
			"table",
			"inet",
			"ceracell_1",
		]);
		expect(fenceState.code, fenceState.stderr).toBe(0);
		expect(
			inspectCellularFence(fence, JSON.parse(fenceState.stdout), {
				wwan0: index,
			}),
			fenceState.stdout,
		).toBe("withdrawn");
		const rules = JSON.parse(fenceState.stdout).nftables.flatMap(
			(entry: { rule?: { expr: Array<{ counter?: { packets: number } }> } }) =>
				entry.rule?.expr ?? [],
		);
		expect(
			rules.reduce(
				(sum: number, entry: { counter?: { packets: number } }) =>
					sum + (entry.counter?.packets ?? 0),
				0,
			),
			fenceState.stdout,
		).toBeGreaterThan(0);
		expect(await tx("wwan0"), fenceState.stdout).toBe(blockedBefore);
		expect(await tx("lan0")).toBe(lanTxBefore);
		await exchangeSourceBoundDatagram({ ...packet, device: "wwan1" });
		expect(await tx("wwan1")).toBeGreaterThan(goodBefore);
		// An unrelated device may share a carrier-NAT address. Native guards
		// require the bound device and must leave that device's traffic intact.
		await ip("addr", "add", "192.0.2.2/32", "dev", "lan0", "noprefixroute");
		await exchangeSourceBoundDatagram({ ...packet, device: "lan0" });
		expect(await tx("lan0")).toBeGreaterThan(lanTxBefore);
		await ip("addr", "del", "192.0.2.2/32", "dev", "lan0");

		for (const plan of [a, b])
			for (const effect of [...plan.effects].reverse()) {
				if (plan === a && !effect.terminal) continue;
				await ip(...cellularIpArgv(effect, "del"));
			}
		const c = planCellularRoutes({
			owner: "a".repeat(64),
			epoch: "two",
			slot: 1,
			iface: "wwan0",
			mtu: 1428,
			ipv6: "2001:db8:1::2",
			ipv6PrefixLength: 64,
			ipv6Gateway: "fe80::1",
			nat64: "2001:db8:64::/96",
		});
		if (!c?.mapped) throw new Error("Missing translated plan");
		await ip(
			"-6",
			"addr",
			"add",
			"2001:db8:1::2/64",
			"dev",
			"wwan0",
			"nodad",
			"noprefixroute",
		);
		expect(await firewall.remove()).toBe(true);
		const tunIndex = Number(
			JSON.parse(await ip("-j", "link", "show", "dev", "cclat1"))[0].ifindex,
		);
		await nft(
			cellularFenceDefinition(
				{ ...fence, source: c.source, ifindex: tunIndex, translated: true },
				"probe",
			),
		);
		const translatedState = new CellularIpState(
			c,
			cellularIpIO(async () => true),
		);
		for (const effect of c.effects.filter((effect) => effect.terminal))
			await apply(translatedState, effect);
		await ip(
			"-4",
			"addr",
			"add",
			`${c.source}/32`,
			"dev",
			"cclat1",
			"noprefixroute",
		);
		for (const effect of c.effects.filter((effect) => !effect.terminal))
			await apply(translatedState, effect);
		expect(
			JSON.parse(
				await ip(
					"-j",
					"-6",
					"route",
					"get",
					c.mapped,
					"from",
					"2001:db8:64::c000:201",
					"iif",
					"wwan0",
				),
			)[0].dev,
		).toBe("cclat1");
		expect(
			JSON.parse(
				await ip(
					"-j",
					"-6",
					"route",
					"get",
					"2001:db8:64::c000:201",
					"from",
					c.mapped,
					"iif",
					"cclat1",
				),
			)[0].dev,
		).toBe("wwan0");
		expect(await ip("-6", "route", "show", "table", "main")).not.toContain(
			c.mapped,
		);
		expect(await ip("-j", "-4", "route", "show", "table", "main")).toBe(
			mainBefore,
		);
		for (const effect of [...c.effects].reverse())
			expect(await translatedState.remove(effect)).toBe(true);

		// Exercise the composed native host against the actual kernel, with its
		// durable inverse and lifetime flock. NM's native address stays untouched.
		const stateRoot = await mkdtemp(
				join(tmpdir(), "cellular-native-composed-"),
			),
			lease = await acquirePrivateStateLease(
				{ dir: join(stateRoot, "leases") },
				"d".repeat(64),
			);
		if (!lease) throw new Error("Native fixture lease unavailable");
		let owned = true,
			consumers = false,
			withdrawn = 0;
		const nativeAuthority = {
			bootId: "11111111-1111-1111-1111-111111111111",
			input: {
				owner: "d".repeat(64),
				epoch: "native-one",
				slot: 5,
				iface: "wwan0",
				mtu: 1428,
				ipv4: "192.0.2.2",
			},
			ifindex: index,
			dns: [],
		};
		const nativeDeps = {
			bootId: nativeAuthority.bootId,
			store: { dir: join(stateRoot, "state") },
			owned: () => owned,
			currentNow: () => owned,
			current: async () => {
				const rows = JSON.parse(
					await ip("-4", "-j", "addr", "show", "dev", "wwan0"),
				);
				return (
					rows.length === 1 &&
					rows[0].ifindex === index &&
					rows[0].addr_info.some(
						(address: { local: string }) => address.local === "192.0.2.2",
					)
				);
			},
			withdraw: () => {
				withdrawn++;
			},
			consumersReleased: async () => consumers,
			cancelProbe: () => {
				/* No ongoing socket in this finite fixture. */
			},
		};
		try {
			const native = new CellularNativeHost(nativeAuthority, nativeDeps);
			await native.install();
			expect(await native.valid()).toBe(true);
			expect(await native.setReady(true)).toBe(true);
			const beforeReady = await tx("wwan0");
			await exchangeSourceBoundDatagram(packet);
			expect(await tx("wwan0")).toBeGreaterThan(beforeReady);
			expect(await native.cleanup()).toBe(false);
			expect(withdrawn).toBe(1);
			const beforeDenied = await tx("wwan0");
			await exchangeSourceBoundDatagram(packet);
			expect(await tx("wwan0")).toBe(beforeDenied);
			consumers = true;
			expect(await native.cleanup()).toBe(true);
			expect(withdrawn).toBe(1); // Retries retain the original withdrawal boundary.
			const successor = new CellularNativeHost(
				{
					...nativeAuthority,
					input: { ...nativeAuthority.input, epoch: "native-two" },
				},
				nativeDeps,
			);
			await successor.install();
			expect(await successor.setReady(true)).toBe(true);
			expect(await native.cleanup()).toBe(true);
			expect(await native.setReady(false)).toBe(false);
			expect(await successor.valid()).toBe(true);
			expect(await nativeDeps.current()).toBe(true);
			// Reconstruct from the actual closed on-disk inventory. The original slot
			// lease still excludes other owners; recovery reuses that fixture ownership.
			let recovered = 0;
			const recovery = new CellularHostRecovery({
				store: nativeDeps.store,
				bootId: async () => nativeAuthority.bootId,
				retain: async (authority) => {
					if (authority.kind !== "native")
						throw new Error("Native recovery fixture expected");
					recovered++;
					return new CellularNativeHost(authority.inverse.plan, {
						...nativeDeps,
						currentNow: () => false,
						current: async () => false,
					});
				},
			});
			consumers = false;
			await expect(recovery.replay()).rejects.toThrow("withdrawal incomplete");
			const beforeRecoveryDeny = await tx("wwan0");
			await exchangeSourceBoundDatagram(packet);
			expect(await tx("wwan0")).toBe(beforeRecoveryDeny);
			consumers = true;
			await recovery.replay();
			expect(recovered).toBe(1);
			expect(await nativeDeps.current()).toBe(true);
			// Reinstall a fresh generation to retain the vanished-device cleanup gate.
			const final = new CellularNativeHost(
				{
					...nativeAuthority,
					input: { ...nativeAuthority.input, epoch: "native-final" },
				},
				nativeDeps,
			);
			await final.install();
			await ip("link", "delete", "dev", "wwan0");
			try {
				expect(await final.cleanup()).toBe(true);
			} catch (cause) {
				const fence = await runTestCommand([
					"nft",
					"--numeric",
					"--json",
					"list",
					"table",
					"inet",
					"ceracell_5",
				]);
				throw new Error(
					JSON.stringify({
						fence: fence.stdout,
						rules: await ip("-4", "-N", "-j", "rule", "show"),
					}),
					{ cause },
				);
			}
			expect(await ip("-j", "-4", "route", "show", "table", "main")).toBe(
				mainBefore,
			);
		} finally {
			owned = false;
			lease.release();
			await rm(stateRoot, { recursive: true, force: true });
		}
	},
	30_000,
);
