/// <reference types="bun" />
/**
 * The coordinated receiver choice against real sockets, routes and DNS.
 *
 * This file re-runs itself inside `unshare -Urn` (no privileges needed) and
 * skips only where user namespaces are unavailable. In the child, this process
 * is the device: two uplinks, wwan0 (10.66.1.2) and wwan1 (10.66.2.2), each
 * reachable only through its own source routing table, into a peer namespace
 * (`unshare -n`) hosting two receivers, H1 (10.66.9.9) and H2 (10.66.9.10),
 * each bound to its own address and answering a REG2 with REG_NGP as the
 * BELABOX receiver does. A DNS stub on 127.0.0.1 answers the receiver name
 * with both addresses, in a fixed order or rotating per query, and the
 * production resolver (c-ares plus the device's well-known check) asks it.
 *
 * A blackholed receiver drops every packet without a reply or ICMP, which is
 * what a dead address looks like to the device. A cut uplink is its veth peer
 * set down. Synthetic addresses only.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createSocket, type Socket } from "node:dgram";
import { Resolver } from "node:dns";
import { readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import { isLocalIp } from "../helpers/ip-addresses.ts";
import {
	setDnsCacheEntryForTest,
	setDnsResolverFactoryForTest,
} from "../modules/network/dns.ts";
import {
	parseIpAddrShow,
	processIfconfigOutput,
} from "../modules/network/network-interfaces.ts";
import type { BondEntry } from "../modules/streaming/bind-map.ts";
import {
	genSrtlaBondEntries,
	genSrtlaBondEntriesForLocalIpAddress,
	resolveSrtla,
} from "../modules/streaming/srtla.ts";
import { prepareSrtlaIpAddresses } from "../modules/streaming/streamloop/srtla-ip-preparation.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const child = process.env.CERALIVE_RECEIVER_TARGET_CHILD === "1";
const support = child
	? undefined
	: await runTestCommand(["unshare", "-Urn", "unshare", "-n", "true"]);
const unavailable = support !== undefined && support.code !== 0;
// The CI namespace lane sets this: there, missing namespaces are a failure.
const required = process.env.CERALIVE_NETNS_ISOLATED === "1";

const NAME = "rec.netns.test.invalid";
const PORT = 16792;
const H1 = "10.66.9.9";
const H2 = "10.66.9.10";

if (!child) {
	const name = "receiver choice in a private namespace";
	(unavailable && !required ? test.skip : test)(
		unavailable ? `${name}: ${support?.stderr.trim()}` : name,
		async () => {
			expect(unavailable, support?.stderr).toBe(false);
			const result = await runTestCommand(
				[
					"unshare",
					"-Urn",
					process.execPath,
					"test",
					fileURLToPath(import.meta.url),
				],
				{
					env: {
						CERALIVE_RECEIVER_TARGET_CHILD: "1",
						// The child starts in its own network namespace with only `lo`.
						CERAUI_TEST_PRIVATE_NETNS: "1",
					},
				},
			);
			expect(result.code, result.stdout + result.stderr).toBe(0);
			expect(result.stderr).toContain(" 0 fail");
			// Every scenario ran in the child.
			expect(result.stderr).toContain(" 5 pass");
		},
		60_000,
	);
}

let peer: Subprocess<"pipe", "pipe", "inherit"> | undefined;
let dns: Socket | undefined;
let dnsMode: "first" | "second" | "rotate" = "first";
let dnsQueries = 0;
let lastOrder: string[] = [];
let peerOut: ReadableStreamDefaultReader<Uint8Array> | undefined;
let peerSeen = "";

async function run(cmd: string[]): Promise<string> {
	const result = await runTestCommand(cmd);
	if (result.code !== 0) throw new Error(`${cmd.join(" ")}: ${result.stderr}`);
	return result.stdout;
}
const ip = (...args: string[]) => run(["ip", ...args]);
const inPeer = (...args: string[]) =>
	run(["nsenter", "-t", String(peer?.pid), "-n", "ip", ...args]);

/** Read the peer's output until it has printed `wanted` on a line. */
async function peerLine(wanted: string): Promise<void> {
	const decoder = new TextDecoder();
	while (!peerSeen.includes(`${wanted}\n`)) {
		const chunk = await peerOut?.read();
		if (!chunk || chunk.done) throw new Error(`peer exited: ${peerSeen}`);
		peerSeen += decoder.decode(chunk.value, { stream: true });
	}
	peerSeen = peerSeen.slice(
		peerSeen.indexOf(`${wanted}\n`) + wanted.length + 1,
	);
}

let drops = 0;
/** Tell the peer which receivers drop everything ("none", "h1" or "h1 h2"),
 *  and wait until it has applied it. */
async function blackhole(spec: string): Promise<void> {
	const id = ++drops;
	peer?.stdin.write(`${id} ${spec}\n`);
	await peer?.stdin.flush();
	await peerLine(`ACK ${id}`);
}

function answerOrder(): string[] {
	if (dnsMode === "second") lastOrder = [H2, H1];
	else if (dnsMode === "rotate")
		lastOrder = dnsQueries++ % 2 === 0 ? [H1, H2] : [H2, H1];
	else lastOrder = [H1, H2];
	return lastOrder;
}

/** A two-name authoritative stub: A answers only, TTL 0. */
function startDnsStub(): Promise<Socket> {
	const socket = createSocket("udp4");
	socket.on("message", (q, rinfo) => {
		let off = 12;
		const labels: string[] = [];
		while (q[off]) {
			labels.push(q.subarray(off + 1, off + 1 + q[off]).toString());
			off += q[off] + 1;
		}
		const qname = labels.join(".").toLowerCase();
		const qtype = q.readUInt16BE(off + 1);
		const known = qname === NAME || qname === "wellknown.belabox.net";
		const addrs =
			qtype !== 1 || !known
				? []
				: qname === NAME
					? answerOrder()
					: ["127.1.33.7"];
		const header = Buffer.alloc(12);
		header.writeUInt16BE(q.readUInt16BE(0), 0);
		header.writeUInt16BE(
			0x8400 | (q.readUInt16BE(2) & 0x0100) | (known ? 0 : 3),
			2,
		);
		header.writeUInt16BE(1, 4);
		header.writeUInt16BE(addrs.length, 6);
		const answers = addrs.map((a) => {
			const rr = Buffer.alloc(16);
			rr.writeUInt16BE(0xc00c, 0);
			rr.writeUInt16BE(1, 2);
			rr.writeUInt16BE(1, 4);
			rr.writeUInt32BE(0, 6);
			rr.writeUInt16BE(4, 10);
			a.split(".").forEach((octet, i) => {
				rr.writeUInt8(Number(octet), 12 + i);
			});
			return rr;
		});
		socket.send(
			Buffer.concat([header, q.subarray(12, off + 5), ...answers]),
			rinfo.port,
			rinfo.address,
		);
	});
	return new Promise((resolve) =>
		socket.bind(53, "127.0.0.1", () => resolve(socket)),
	);
}

const PEER_SCRIPT = `
const cp = require('node:child_process');
cp.execFileSync('ip', ['link', 'set', 'lo', 'up']);
let drop = new Set();
let bound = 0;
for (const [tag, a] of [['h1', '${H1}'], ['h2', '${H2}']]) {
  cp.execFileSync('ip', ['address', 'add', a + '/32', 'dev', 'lo']);
  const s = require('node:dgram').createSocket('udp4');
  // A reply to a probe socket that already closed comes back as ICMP.
  s.on('error', () => {});
  s.on('message', (b, p) => {
    if (drop.has(tag)) return;
    if (b.length === 258 && b.readUInt16BE(0) === 0x9201) s.send(Buffer.from([0x92, 0x11]), p.port, p.address);
  });
  s.bind(${PORT}, a, () => { if (++bound === 2) console.log('NS_READY'); });
}
process.stdin.setEncoding('utf8');
let pending = '';
process.stdin.on('data', (d) => {
  pending += d;
  let i;
  while ((i = pending.indexOf('\\n')) >= 0) {
    const [id, ...spec] = pending.slice(0, i).split(' ');
    pending = pending.slice(i + 1);
    drop = new Set(spec.filter((x) => x !== 'none'));
    console.log('ACK ' + id);
  }
});
`;

beforeAll(async () => {
	if (!child) return;
	await ip("link", "set", "lo", "up");
	peer = Bun.spawn(["unshare", "-n", process.execPath, "-e", PEER_SCRIPT], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
	});
	peerOut = peer.stdout.getReader();
	await peerLine("NS_READY");
	expect(readlinkSync(`/proc/${peer.pid}/ns/net`)).not.toBe(
		readlinkSync("/proc/self/ns/net"),
	);
	for (const [link, n] of [
		["a", 1],
		["b", 2],
	] as const) {
		await ip(
			"link",
			"add",
			`${link}0`,
			"type",
			"veth",
			"peer",
			"name",
			`r${link}`,
			"netns",
			String(peer.pid),
		);
		await ip("address", "add", `10.66.${n}.2/24`, "dev", `${link}0`);
		await ip("link", "set", `${link}0`, "up");
		await ip("rule", "add", "from", `10.66.${n}.2`, "table", `10${n}`);
		await ip(
			"route",
			"add",
			"default",
			"via",
			`10.66.${n}.1`,
			"dev",
			`${link}0`,
			"table",
			`10${n}`,
		);
		await inPeer("address", "add", `10.66.${n}.1/24`, "dev", `r${link}`);
		await inPeer("link", "set", `r${link}`, "up");
	}
	dns = await startDnsStub();
	setDnsResolverFactoryForTest(() => {
		const resolver = new Resolver({ timeout: 500, tries: 1 });
		resolver.setServers(["127.0.0.1"]);
		return resolver;
	});
	processIfconfigOutput(
		"wwan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n\n" +
			"wwan1: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n",
		parseIpAddrShow(
			"2: wwan0: <UP,LOWER_UP> mtu 1500\n    inet 10.66.1.2/24 scope global\n" +
				"3: wwan1: <UP,LOWER_UP> mtu 1500\n    inet 10.66.2.2/24 scope global\n",
		),
	);
});

afterAll(() => {
	if (!child) return;
	setDnsResolverFactoryForTest(null);
	setDnsCacheEntryForTest(NAME, null);
	dns?.close();
	peer?.kill("SIGKILL");
});

async function choose(): Promise<{ address: string; ms: number }> {
	const started = performance.now();
	const address = await resolveSrtla(NAME, PORT);
	return { address, ms: Math.round(performance.now() - started) };
}

// The scenarios exist only in the child; the parent runs the child.
const childTest = (child ? test : () => {}) as typeof test;

childTest("both receivers answering: the sender keeps the name", async () => {
	await blackhole("none");
	for (const mode of ["first", "second", "rotate", "rotate"] as const) {
		dnsMode = mode;
		expect((await choose()).address).toBe(NAME);
	}
});

childTest(
	"first target blackholed: ten starts in varied order all reach H2",
	async () => {
		await blackhole("h1");
		const modes = ["first", "second", "rotate"] as const;
		const results: {
			mode: string;
			first: string;
			address: string;
			ms: number;
		}[] = [];
		dnsQueries = 0;
		for (let run = 0; run < 10; run++) {
			dnsMode = modes[run % 3];
			const chosen = await choose();
			results.push({ mode: dnsMode, first: lastOrder[0] ?? "", ...chosen });
		}
		console.log(JSON.stringify(results));
		for (const r of results) {
			// H1 listed first: the live H2 is pinned. H2 listed first: the name,
			// which the sender resolves to H2 itself.
			expect(r.address).toBe(r.first === H1 ? H2 : NAME);
			// A silent first answer costs at most the probe deadline (1.2 s).
			expect(r.ms).toBeLessThan(2_000);
		}
	},
	30_000,
);

childTest(
	"nothing reachable hands the sender the name, as before",
	async () => {
		await blackhole("h1 h2");
		dnsMode = "first";
		const { address, ms } = await choose();
		expect(address).toBe(NAME);
		expect(ms).toBeLessThan(2_500);
	},
);

childTest(
	"the pinned private receiver is admitted over both uplinks",
	async () => {
		// 10.66.9.10 is private but on no local subnet: it is reached over the bond.
		await blackhole("h1");
		dnsMode = "first";
		const { address } = await choose();
		expect(address).toBe(H2);
		const written: (readonly BondEntry[])[] = [];
		await prepareSrtlaIpAddresses(address, {
			isLocal: isLocalIp,
			localList: genSrtlaBondEntriesForLocalIpAddress,
			bondedList: genSrtlaBondEntries,
			writeList: async (entries) => {
				written.push(entries);
				return { ok: true, changed: false } as never;
			},
		});
		expect(written[0]?.map((e) => e.ip).sort()).toEqual([
			"10.66.1.2",
			"10.66.2.2",
		]);
	},
);

childTest("a single viable uplink still finds the live receiver", async () => {
	await blackhole("h1");
	await inPeer("link", "set", "ra", "down");
	try {
		dnsMode = "first";
		expect((await choose()).address).toBe(H2);
	} finally {
		await inPeer("link", "set", "ra", "up");
	}
});
