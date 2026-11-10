/// <reference types="bun" />
/**
 * An IPv6-only uplink reaches an IPv4-only receiver, pinned to that uplink.
 *
 * This is the kernel-level proof of the family-aware source selection: a device
 * whose only uplink has NO IPv4 address discovers the carrier's NAT64 prefix
 * over that uplink, synthesizes the receiver's address, and exchanges UDP with
 * a receiver that only speaks IPv4 — while the main routing table gains no
 * default route, so nothing else on the system is steered onto the uplink.
 *
 * Two network namespaces: this process is the device; a helper started with
 * `unshare -n` is the carrier (gateway, DNS64, UDP NAT64, IPv4 receiver).
 */
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
	chooseUplinkSource,
	ipv6SourcesByInterface,
	type KernelInterfaceAddresses,
} from "../modules/network/ipv6-source.ts";
import {
	buildIpv4OnlyArpaQuery,
	formatNat64Prefix,
	parseAaaaResponse,
	pref64FromIpv4OnlyArpa,
} from "../modules/network/nat64.ts";
import { CARRIER } from "./helpers/nat64-carrier-stub.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const child = process.env.CERALIVE_IPV6_UPLINK_CHILD === "1";
const probe = child
	? undefined
	: await runTestCommand(["unshare", "-Urn", "unshare", "-n", "true"]);
const unavailable = probe !== undefined && probe.code !== 0;

const UPLINK = "up0";
const TABLE = "100";
const name = "an IPv6-only uplink carries UDP to an IPv4-only receiver";

async function ip(...args: string[]): Promise<string> {
	const result = await runTestCommand(["ip", ...args]);
	if (result.code !== 0)
		throw new Error(`ip ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

async function readLine(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	wanted: string,
): Promise<void> {
	const decoder = new TextDecoder();
	let seen = "";
	while (!seen.includes(`${wanted}\n`)) {
		const chunk = await reader.read();
		if (chunk.done) throw new Error(`carrier exited before ${wanted}: ${seen}`);
		seen += decoder.decode(chunk.value, { stream: true });
	}
}

/** One datagram out of a socket bound to `source`, and the first reply. */
async function exchange(
	source: string,
	destination: string,
	port: number,
	payload: Uint8Array | string,
): Promise<Uint8Array> {
	const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
	const socket = await Bun.udpSocket({
		hostname: source,
		port: 0,
		socket: {
			data(_socket, data) {
				resolve(new Uint8Array(data));
			},
			error(_socket, error) {
				reject(error);
			},
		},
	});
	const timer = setTimeout(
		() => reject(new Error(`no reply from ${destination}:${port}`)),
		3_000,
	);
	try {
		socket.send(payload, port, destination);
		return await promise;
	} finally {
		clearTimeout(timer);
		socket.close();
	}
}

(unavailable ? test.skip : test)(
	unavailable ? `${name}: ${probe?.stderr}` : name,
	async () => {
		if (!child) {
			const result = await runTestCommand(
				[
					"unshare",
					"-Urn",
					process.execPath,
					"test",
					fileURLToPath(import.meta.url),
				],
				{ env: { CERALIVE_IPV6_UPLINK_CHILD: "1" } },
			);
			expect(result.code, result.stdout + result.stderr).toBe(0);
			return;
		}

		// Given: a carrier namespace on the far end of a veth "modem" link.
		await ip("link", "set", "lo", "up");
		const carrier = Bun.spawn(
			[
				"unshare",
				"-n",
				process.execPath,
				fileURLToPath(
					new URL("./helpers/nat64-carrier-stub.ts", import.meta.url),
				),
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "inherit" },
		);
		const reader = carrier.stdout.getReader();
		try {
			await readLine(reader, "NS_READY");
			await ip(
				"link",
				"add",
				UPLINK,
				"type",
				"veth",
				"peer",
				"name",
				CARRIER.peerInterface,
				"netns",
				String(carrier.pid),
			);
			carrier.stdin.write("go\n");
			await carrier.stdin.flush();
			await readLine(reader, "READY");

			// Given: the uplink has an IPv6 address only, and its default route
			// lives in a table selected by that source address alone.
			await ip(
				"addr",
				"add",
				`${CARRIER.deviceAddress}/64`,
				"dev",
				UPLINK,
				"nodad",
			);
			await ip("link", "set", UPLINK, "up");
			await ip(
				"-6",
				"rule",
				"add",
				"from",
				CARRIER.deviceAddress,
				"lookup",
				TABLE,
			);
			await ip(
				"-6",
				"route",
				"add",
				"default",
				"via",
				CARRIER.gateway,
				"dev",
				UPLINK,
				"table",
				TABLE,
			);

			// When: the source is selected from what the kernel reports.
			const addresses = JSON.parse(
				await ip("-json", "address", "show"),
			) as KernelInterfaceAddresses[];
			const uplinkRecord = addresses.find((entry) => entry.ifname === UPLINK);
			expect(
				uplinkRecord?.addr_info?.some((address) => address.family === "inet"),
			).toBe(false);
			const source = ipv6SourcesByInterface(addresses)[UPLINK];
			expect(source).toBe(CARRIER.deviceAddress);
			if (source === undefined) return;

			// Then: IPv4 has no path at all, and the main tables have no default.
			const direct = await runTestCommand([
				"ip",
				"route",
				"get",
				CARRIER.receiverIpv4,
			]);
			expect(direct.code).not.toBe(0);
			expect(await ip("-6", "route", "show", "default")).toBe("");
			expect(await ip("-4", "route", "show", "default")).toBe("");

			// When: the NAT64 prefix is discovered over this uplink (RFC 7050).
			const queryId = 0x4e36;
			const answers = parseAaaaResponse(
				await exchange(
					source,
					CARRIER.gateway,
					53,
					buildIpv4OnlyArpaQuery(queryId),
				),
				queryId,
			);
			const nat64 = pref64FromIpv4OnlyArpa(answers ?? []);
			expect(nat64 && formatNat64Prefix(nat64)).toBe(CARRIER.prefix);

			// Then: the uplink is given the IPv6 source and a NAT64 destination.
			const chosen = chooseUplinkSource(
				{ ipv6: source, nat64 },
				{ ipv4: CARRIER.receiverIpv4 },
			);
			expect(chosen).toEqual({
				source: CARRIER.deviceAddress,
				destination: "64:ff9b::c000:20a",
				family: "ipv6",
				path: "nat64",
			});
			if (chosen === undefined) return;

			// Then: a datagram reaches the IPv4-only receiver, which saw an IPv4
			// peer, and the reply returns from the address the device sent to.
			const reply = new TextDecoder().decode(
				await exchange(
					chosen.source,
					chosen.destination,
					CARRIER.port,
					"keepalive",
				),
			);
			expect(reply).toMatch(
				new RegExp(
					`^${CARRIER.natPoolIpv4.replaceAll(".", "\\.")}:\\d+ keepalive$`,
				),
			);
		} finally {
			reader.releaseLock();
			carrier.kill();
			await carrier.exited;
		}
	},
	20_000,
);
