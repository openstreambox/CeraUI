import { afterEach, describe, expect, test } from "bun:test";
import { createSocket, type Socket } from "node:dgram";

import {
	canonicalIp,
	chooseReceiverTarget,
	isReceiverProbeReply,
	type ReceiverProbe,
	receiverProbePacket,
	SRTLA_ID_LEN,
	SRTLA_TYPE_REG_NGP,
	SRTLA_TYPE_REG2,
	udpReceiverProbe,
} from "./receiver-target.ts";

/** A scripted probe: `live` maps "address|source" (or "address") to a reply delay. */
function scripted(live: Record<string, number>) {
	const calls: { address: string; source: string | undefined }[] = [];
	const probe: ReceiverProbe = ({ address, source, signal }) => {
		calls.push({ address, source });
		const delay = live[`${address}|${source}`] ?? live[address];
		return new Promise((resolve) => {
			if (delay === undefined) {
				signal.addEventListener("abort", () => resolve(false));
				return;
			}
			const timer = setTimeout(() => resolve(true), delay);
			signal.addEventListener("abort", () => {
				clearTimeout(timer);
				resolve(false);
			});
		});
	};
	return { probe, calls };
}

describe("chooseReceiverTarget", () => {
	test("a dead first answer gives the bond the second", async () => {
		const { probe } = scripted({ "192.0.2.20": 5 });
		const choice = await chooseReceiverTarget(
			["192.0.2.10", "192.0.2.20"],
			5000,
			["198.51.100.1", "203.0.113.1"],
			{ probe, deadlineMs: 200 },
		);
		expect(choice.target).toBe("192.0.2.20");
		expect(choice.answers[0].answeredVia).toEqual([]);
		expect(choice.answers[1].answeredVia.sort()).toEqual([
			"198.51.100.1",
			"203.0.113.1",
		]);
	});

	test("DNS order wins when both answer, even if the second is faster", async () => {
		const { probe } = scripted({ "192.0.2.10": 30, "192.0.2.20": 1 });
		const choice = await chooseReceiverTarget(
			["192.0.2.10", "192.0.2.20"],
			5000,
			["198.51.100.1"],
			{ probe, deadlineMs: 500 },
		);
		expect(choice.target).toBe("192.0.2.10");
	});

	test("a live first answer decides without waiting out the deadline", async () => {
		const { probe } = scripted({ "192.0.2.10": 1 });
		const started = performance.now();
		const choice = await chooseReceiverTarget(
			["192.0.2.10", "192.0.2.20"],
			5000,
			["198.51.100.1"],
			{ probe, deadlineMs: 5_000 },
		);
		expect(choice.target).toBe("192.0.2.10");
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	test("one viable uplink is enough to choose its address", async () => {
		// Only the second uplink reaches the second receiver; nothing reaches the first.
		const { probe } = scripted({ "192.0.2.20|203.0.113.1": 2 });
		const choice = await chooseReceiverTarget(
			["192.0.2.10", "192.0.2.20"],
			5000,
			["198.51.100.1", "203.0.113.1"],
			{ probe, deadlineMs: 200 },
		);
		expect(choice.target).toBe("192.0.2.20");
		expect(choice.answers[1].answeredVia).toEqual(["203.0.113.1"]);
	});

	test("silence everywhere chooses nothing at the deadline", async () => {
		const { probe } = scripted({});
		const started = performance.now();
		const choice = await chooseReceiverTarget(
			["192.0.2.10", "192.0.2.20"],
			5000,
			["198.51.100.1"],
			{ probe, deadlineMs: 80 },
		);
		expect(choice.target).toBeUndefined();
		expect(performance.now() - started).toBeGreaterThanOrEqual(70);
	});

	test("each address is asked only over sources of its own family", async () => {
		const { probe, calls } = scripted({ "fd51::2": 1 });
		await chooseReceiverTarget(
			["192.0.2.10", "fd51::2"],
			5000,
			["198.51.100.1", "fd51::9"],
			{ probe, deadlineMs: 100 },
		);
		expect(calls).toContainEqual({
			address: "192.0.2.10",
			source: "198.51.100.1",
		});
		expect(calls).toContainEqual({ address: "fd51::2", source: "fd51::9" });
		expect(calls).toHaveLength(2);
	});

	test("an address with no source of its family is asked once, unbound", async () => {
		const { probe, calls } = scripted({ "192.0.2.10": 1 });
		await chooseReceiverTarget(["192.0.2.10", "192.0.2.20"], 5000, [], {
			probe,
			deadlineMs: 100,
		});
		expect(calls.map((c) => c.source)).toEqual([undefined, undefined]);
	});

	test("a throwing probe counts as no answer", async () => {
		const probe: ReceiverProbe = async ({ address }) => {
			if (address === "192.0.2.10") throw new Error("EPERM");
			return true;
		};
		const choice = await chooseReceiverTarget(
			["192.0.2.10", "192.0.2.20"],
			5000,
			["198.51.100.1"],
			{ probe, deadlineMs: 100 },
		);
		expect(choice.target).toBe("192.0.2.20");
	});
});

describe("chooseReceiverTarget with a synchronously failing probe", () => {
	test("a later address is still waited for", async () => {
		// A plain function that throws before returning a promise.
		const probe = (({ address }: { address: string }) => {
			if (address === "192.0.2.10") throw new Error("EADDRNOTAVAIL");
			return new Promise<boolean>((resolve) =>
				setTimeout(() => resolve(true), 5),
			);
		}) as ReceiverProbe;
		const choice = await chooseReceiverTarget(
			["192.0.2.10", "192.0.2.20"],
			5000,
			["198.51.100.1"],
			{ probe, deadlineMs: 500 },
		);
		expect(choice.target).toBe("192.0.2.20");
	});
});

test("equivalent IPv6 spellings compare equal; IPv4 is untouched", () => {
	expect(canonicalIp("0:0:0:0:0:0:0:1")).toBe(canonicalIp("::1"));
	expect(canonicalIp("FD51:0::0010")).toBe(canonicalIp("fd51::10"));
	expect(canonicalIp("192.0.2.10")).toBe("192.0.2.10");
});

describe("probe packet", () => {
	test("is a REG2 with a fresh 256-byte id each time", () => {
		const a = receiverProbePacket();
		const b = receiverProbePacket();
		expect(a.length).toBe(2 + SRTLA_ID_LEN);
		expect((a[0] << 8) | a[1]).toBe(SRTLA_TYPE_REG2);
		expect(Buffer.from(a.subarray(2)).equals(Buffer.from(b.subarray(2)))).toBe(
			false,
		);
	});

	test("only registration replies count", () => {
		expect(isReceiverProbeReply(new Uint8Array([0x92, 0x11]))).toBe(true);
		expect(isReceiverProbeReply(new Uint8Array([0x92, 0x10]))).toBe(true);
		expect(isReceiverProbeReply(new Uint8Array([0x90, 0x00]))).toBe(false); // keepalive
		expect(isReceiverProbeReply(new Uint8Array([0x91, 0x00]))).toBe(false); // ack
		expect(isReceiverProbeReply(new Uint8Array([0x92]))).toBe(false);
		// An echo of the REG2 itself, or a longer packet, is not an answer.
		expect(isReceiverProbeReply(receiverProbePacket())).toBe(false);
		expect(isReceiverProbeReply(new Uint8Array([0x92, 0x11, 0]))).toBe(false);
		expect(isReceiverProbeReply(new Uint8Array([0x92, 0x02]))).toBe(false);
	});
});

describe("udpReceiverProbe on loopback", () => {
	const sockets: Socket[] = [];
	afterEach(() => {
		for (const s of sockets.splice(0)) s.close();
	});

	/** A receiver stand-in: answers REG_NGP to a REG2, or stays silent. */
	async function receiver(answer: boolean, reply = SRTLA_TYPE_REG_NGP) {
		const socket = createSocket("udp4");
		sockets.push(socket);
		const seen: number[] = [];
		socket.on("message", (msg, rinfo) => {
			seen.push(msg.length);
			if (
				answer &&
				msg.length === 2 + SRTLA_ID_LEN &&
				msg.readUInt16BE(0) === SRTLA_TYPE_REG2
			)
				socket.send(
					Buffer.from([reply >> 8, reply & 0xff]),
					rinfo.port,
					rinfo.address,
				);
		});
		await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
		return { port: socket.address().port, seen };
	}

	test("a receiver that answers REG_NGP is reachable", async () => {
		const live = await receiver(true);
		const ok = await udpReceiverProbe({
			address: "127.0.0.1",
			port: live.port,
			source: "127.0.0.1",
			signal: new AbortController().signal,
		});
		expect(ok).toBe(true);
		expect(live.seen[0]).toBe(2 + SRTLA_ID_LEN);
	});

	test("a silent receiver is not, and the abort ends the probe", async () => {
		const dead = await receiver(false);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 600);
		const ok = await udpReceiverProbe({
			address: "127.0.0.1",
			port: dead.port,
			source: undefined,
			signal: controller.signal,
		});
		expect(ok).toBe(false);
		// The first REG2 and the one resend.
		expect(dead.seen).toHaveLength(2);
	});

	test("a reply that is not a registration reply does not count", async () => {
		const wrong = await receiver(true, 0x9000);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 150);
		expect(
			await udpReceiverProbe({
				address: "127.0.0.1",
				port: wrong.port,
				source: undefined,
				signal: controller.signal,
			}),
		).toBe(false);
	});

	test("a registration reply from another port on the same address does not count", async () => {
		const dead = await receiver(false);
		const other = createSocket("udp4");
		sockets.push(other);
		await new Promise<void>((resolve) => other.bind(0, "127.0.0.1", resolve));
		// Whoever hears the REG2 on the probed port, the answer comes from elsewhere.
		const dead2 = createSocket("udp4");
		sockets.push(dead2);
		dead2.on("message", (_msg, rinfo) =>
			other.send(Buffer.from([0x92, 0x11]), rinfo.port, rinfo.address),
		);
		await new Promise<void>((resolve) => dead2.bind(0, "127.0.0.1", resolve));
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		expect(
			await udpReceiverProbe({
				address: "127.0.0.1",
				port: dead2.address().port,
				source: undefined,
				signal: controller.signal,
			}),
		).toBe(false);
		expect(dead.seen).toHaveLength(0);
	});

	test("an endpoint that echoes the REG2 does not count", async () => {
		const echo = createSocket("udp4");
		sockets.push(echo);
		echo.on("message", (msg, rinfo) =>
			echo.send(msg, rinfo.port, rinfo.address),
		);
		await new Promise<void>((resolve) => echo.bind(0, "127.0.0.1", resolve));
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		expect(
			await udpReceiverProbe({
				address: "127.0.0.1",
				port: echo.address().port,
				source: undefined,
				signal: controller.signal,
			}),
		).toBe(false);
	});

	test("an IPv6 receiver answers over udp6", async () => {
		const v6 = createSocket("udp6");
		sockets.push(v6);
		v6.on("message", (msg, rinfo) => {
			if (msg.length === 2 + SRTLA_ID_LEN)
				v6.send(Buffer.from([0x92, 0x11]), rinfo.port, rinfo.address);
		});
		const bound = await new Promise<boolean>((resolve) => {
			v6.once("error", () => resolve(false));
			v6.bind(0, "::1", () => resolve(true));
		});
		// A host without IPv6 loopback cannot run this case; the IPv4 cases
		// above cover the same code path.
		if (!bound) return;
		expect(
			await udpReceiverProbe({
				address: "::1",
				port: v6.address().port,
				source: undefined,
				signal: new AbortController().signal,
			}),
		).toBe(true);
	});

	test("a source address the host does not own fails at once without throwing", async () => {
		const live = await receiver(true);
		const started = performance.now();
		expect(
			await udpReceiverProbe({
				address: "127.0.0.1",
				port: live.port,
				source: "192.0.2.77",
				signal: new AbortController().signal,
			}),
		).toBe(false);
		expect(performance.now() - started).toBeLessThan(300);
		expect(live.seen).toHaveLength(0);
	});

	test("an abort before the socket is bound sends nothing", async () => {
		const dead = await receiver(false);
		const controller = new AbortController();
		const result = udpReceiverProbe({
			address: "127.0.0.1",
			port: dead.port,
			source: "127.0.0.1",
			signal: controller.signal,
		});
		controller.abort();
		expect(await result).toBe(false);
		await Bun.sleep(500);
		expect(dead.seen).toHaveLength(0);
	});

	test("the real probe picks the live one of two loopback receivers", async () => {
		const dead = await receiver(false);
		const live = await receiver(true);
		// Same address, different ports: model two receivers by a probe that
		// maps each answer to its own port.
		const byAddress: Record<string, number> = {
			"192.0.2.10": dead.port,
			"192.0.2.20": live.port,
		};
		const probe: ReceiverProbe = (request) =>
			udpReceiverProbe({
				...request,
				address: "127.0.0.1",
				port: byAddress[request.address],
			});
		const choice = await chooseReceiverTarget(
			["192.0.2.10", "192.0.2.20"],
			0,
			[],
			{
				probe,
				deadlineMs: 700,
			},
		);
		expect(choice.target).toBe("192.0.2.20");
	});
});
