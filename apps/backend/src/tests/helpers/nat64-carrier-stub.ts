/// <reference types="bun" />
/*
  The carrier side of an IPv6-only uplink, for kernel tests.

  Runs in its OWN network namespace (start it with `unshare -n`) and plays the
  three roles a NAT64 carrier has toward a device:

  - the IPv6 gateway on the far end of the uplink;
  - a DNS64 resolver, which is how a device discovers the NAT64 prefix;
  - a stateful UDP NAT64: datagrams sent to a synthesized IPv6 address leave
    from an IPv4 pool address toward the embedded IPv4 destination, and replies
    come back from the address the device sent to.

  An IPv4-only receiver that reports the peer it saw lives here as well, so a
  test can prove the far end was reached over IPv4.

  Protocol with the parent: prints `NS_READY`, waits for one line on stdin (the
  parent moves the uplink's peer interface in before sending it), configures
  the namespace, prints `READY`, then serves until stdin closes.
*/
import {
	parseIpv6,
	parseNat64Prefix,
	synthesizeNat64,
} from "../../modules/network/nat64.ts";
import { runTestCommand } from "./run-test-command.ts";

export const CARRIER = {
	peerInterface: "cr0",
	gateway: "2001:db8:64::1",
	deviceAddress: "2001:db8:64::2",
	prefix: "64:ff9b::/96",
	receiverIpv4: "192.0.2.10",
	natPoolIpv4: "198.51.100.1",
	port: 5000,
} as const;

async function ip(...args: string[]): Promise<void> {
	const result = await runTestCommand(["ip", ...args]);
	if (result.code !== 0)
		throw new Error(`ip ${args.join(" ")}: ${result.stderr}`);
}

function dnsAnswer(query: Uint8Array, addresses: string[]): Uint8Array {
	// Header + the echoed question, then one compressed-name AAAA per address.
	const questionEnd = query.length;
	const records = addresses.flatMap((address) => [
		0xc0,
		0x0c,
		0x00,
		0x1c,
		0x00,
		0x01,
		0x00,
		0x00,
		0x00,
		0x3c,
		0x00,
		0x10,
		...(parseIpv6(address) ?? new Uint8Array(16)),
	]);
	const message = new Uint8Array(questionEnd + records.length);
	message.set(query);
	message[2] = 0x81;
	message[3] = 0x80;
	message[6] = 0x00;
	message[7] = addresses.length;
	message.set(records, questionEnd);
	return message;
}

async function serve(): Promise<void> {
	const prefix = parseNat64Prefix(CARRIER.prefix);
	const synthesized = prefix && synthesizeNat64(prefix, CARRIER.receiverIpv4);
	if (!prefix || !synthesized) throw new Error("bad stub prefix");

	await ip("link", "set", "lo", "up");
	await ip("link", "set", CARRIER.peerInterface, "up");
	await ip(
		"addr",
		"add",
		`${CARRIER.gateway}/64`,
		"dev",
		CARRIER.peerInterface,
		"nodad",
	);
	await ip("link", "add", "v4net", "type", "dummy");
	await ip("link", "set", "v4net", "up");
	await ip("addr", "add", `${CARRIER.receiverIpv4}/32`, "dev", "v4net");
	await ip("addr", "add", `${CARRIER.natPoolIpv4}/32`, "dev", "v4net");
	await ip("addr", "add", `${synthesized}/128`, "dev", "lo", "nodad");

	// The IPv4-only receiver: answers with the peer it saw.
	await Bun.udpSocket({
		hostname: CARRIER.receiverIpv4,
		port: CARRIER.port,
		socket: {
			data(socket, data, port, address) {
				socket.send(`${address}:${port} ${data.toString()}`, port, address);
			},
		},
	});

	// The translator. One IPv4 socket per device flow, as a NAT keeps state.
	const flows = new Map<string, Bun.udp.Socket<"buffer">>();
	const translator = await Bun.udpSocket({
		hostname: synthesized,
		port: CARRIER.port,
		socket: {
			async data(_socket, data, port, address) {
				const key = `${address}|${port}`;
				let flow = flows.get(key);
				if (flow === undefined) {
					flow = await Bun.udpSocket({
						hostname: CARRIER.natPoolIpv4,
						port: 0,
						socket: {
							data(_flow, reply) {
								translator.send(reply, port, address);
							},
						},
					});
					flows.set(key, flow);
				}
				flow.send(data, CARRIER.port, CARRIER.receiverIpv4);
			},
		},
	});

	// DNS64: `ipv4only.arpa` has no AAAA, so the answer is pure synthesis.
	const wellKnown = ["192.0.0.170", "192.0.0.171"].map(
		(v4) => synthesizeNat64(prefix, v4) ?? "",
	);
	await Bun.udpSocket({
		hostname: CARRIER.gateway,
		port: 53,
		socket: {
			data(socket, data, port, address) {
				socket.send(dnsAnswer(new Uint8Array(data), wellKnown), port, address);
			},
		},
	});
}

if (import.meta.main) {
	process.stdout.write("NS_READY\n");
	const reader = Bun.stdin.stream().getReader();
	await reader.read();
	await serve();
	process.stdout.write("READY\n");
	// Serve until the parent closes stdin or kills us.
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
	}
	process.exit(0);
}
