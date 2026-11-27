import { describe, expect, test } from "bun:test";
import type {
	SenderCapabilityDocument,
	SenderLinkStats,
	SenderStats,
} from "@ceraui/srtla-send/control";
import type { OwnedSender } from "../../streaming/continuity-observer.ts";
import {
	createSenderPort,
	interfaceAddressesOf,
	isOwnedSenderSocket,
	linkMapping,
	type OwnerCheckIo,
	type SenderPortDeps,
	startTimeOf,
} from "./sender-port.ts";

const OWNER: OwnedSender = {
	lifetime: "11111111-1111-4111-8111-111111111111",
	pid: 4242,
	startTime: "987654",
	controlSocket: "/tmp/srtla-send-control-5000.sock",
};

const link = (over: Partial<SenderLinkStats> = {}): SenderLinkStats => ({
	conn_id: 0,
	ip: "192.168.1.10",
	connected: true,
	timed_out: false,
	window: 8192,
	in_flight: 0,
	rtt_ms: 30,
	nak_count: 0,
	bitrate_bytes_per_sec: 0,
	base_score: 0,
	quality_multiplier: 1,
	data_packets_queued_total: 100,
	srtla_ack_entries_total: 90,
	last_srtla_ack_age_ms: 200,
	srtla_ack_epoch: 3,
	...over,
});

const stats = (links: SenderLinkStats[]): SenderStats =>
	({ mode: "enhanced", links }) as SenderStats;

const doc = (methods?: string[]): SenderCapabilityDocument =>
	({ capabilities: {}, ...(methods ? { methods } : {}) }) as never;

/** A fake sender behind the control socket. Records every call it gets. */
function fake() {
	const state = {
		now: 1_000,
		replies: [] as (SenderStats | null | Error)[],
		capabilities: doc([
			"get_stats",
			"get_capabilities",
		]) as SenderCapabilityDocument | null,
		reachable: true,
		owner: OWNER as OwnedSender | null,
		connectGate: null as Promise<void> | null,
		connectedTo: [] as string[],
		connects: 0,
		closes: 0,
		calls: [] as string[],
	};
	const deps: SenderPortDeps = {
		now: () => state.now,
		owner: () => state.owner,
		connect: async (owner) => {
			state.connects++;
			state.connectedTo.push(owner.lifetime);
			if (state.connectGate) await state.connectGate;
			if (!state.reachable) return null;
			return {
				getStats: async () => {
					state.calls.push("getStats");
					const next = state.replies.shift() ?? null;
					if (next instanceof Error) throw next;
					return next;
				},
				getCapabilities: async () => {
					state.calls.push("getCapabilities");
					return state.capabilities;
				},
				close: () => {
					state.closes++;
				},
			};
		},
		interfaces: () => [
			{ ifname: "wlan1", addresses: ["192.168.1.10"] },
			{ ifname: "wwan0", addresses: ["100.64.0.2"] },
		],
	};
	return { state, port: createSenderPort(deps) };
}

describe("the sender read port", () => {
	test("maps a get_stats reply onto the interfaces, stamped on the caller's clock", async () => {
		const { state, port } = fake();
		expect(port.snapshot()).toBeUndefined();
		state.replies.push(stats([link(), link({ conn_id: 1, ip: "100.64.0.2" })]));
		await port.poll();
		const snap = port.snapshot();
		expect(snap?.at).toBe(1_000);
		expect(snap?.radios.get("wlan1")?.queued).toBe(100);
		expect(snap?.radios.get("wwan0")).toBeDefined();
		expect(snap?.others.size).toBe(0);
	});

	test("a link that leaves from no known interface stays visible as unmapped", async () => {
		const { state, port } = fake();
		state.replies.push(stats([link({ ip: "198.51.100.7" })]));
		await port.poll();
		expect(port.snapshot()?.others.size).toBe(1);
	});

	test("a reply with the same state is the same sample: its time does not advance", async () => {
		const { state, port } = fake();
		state.replies.push(stats([link()]));
		await port.poll();
		state.now = 2_000;
		state.replies.push(stats([link()]));
		await port.poll();
		expect(port.snapshot()?.at).toBe(1_000);
		state.now = 3_000;
		state.replies.push(stats([link({ data_packets_queued_total: 160 })]));
		await port.poll();
		expect(port.snapshot()?.at).toBe(3_000);
	});

	test("a failed read gives no snapshot, marks the sender unreachable and reconnects", async () => {
		const { state, port } = fake();
		state.replies.push(stats([link()]));
		await port.poll();
		expect(port.view().reachable).toBe(true);
		state.replies.push(null);
		await port.poll();
		expect(port.snapshot()).toBeUndefined();
		expect(port.view().reachable).toBe(false);
		expect(state.closes).toBe(1);
		state.replies.push(stats([link()]));
		await port.poll();
		expect(state.connects).toBe(2);
		expect(port.snapshot()).toBeDefined();
	});

	test("a read that throws gives no snapshot and never throws", async () => {
		const { state, port } = fake();
		state.replies.push(new Error("socket closed"));
		await port.poll();
		expect(port.snapshot()).toBeUndefined();
	});

	test("one read at a time: overlapping polls share it", async () => {
		const { state, port } = fake();
		state.replies.push(stats([link()]));
		await Promise.all([port.poll(), port.poll(), port.poll()]);
		expect(state.connects).toBe(1);
		expect(state.calls.filter((c) => c === "getStats")).toHaveLength(1);
	});

	test("an unreachable sender gives no snapshot and an unknown capability", async () => {
		const { state, port } = fake();
		state.reachable = false;
		await port.poll();
		expect(port.snapshot()).toBeUndefined();
		expect(port.view()).toMatchObject({
			reachable: false,
			arrivalReports: null,
			standby: null,
		});
	});
});

describe("only the sender this backend launched", () => {
	test("no owned sender: nothing connects, nothing is read", async () => {
		const { state, port } = fake();
		state.owner = null;
		await port.poll();
		expect(state.connects).toBe(0);
		expect(port.snapshot()).toBeUndefined();
		expect(port.view().reachable).toBe(false);
	});

	test("the owned sender going away drops the client and its snapshot", async () => {
		const { state, port } = fake();
		state.replies.push(stats([link()]));
		await port.poll();
		expect(port.snapshot()).toBeDefined();
		state.owner = null;
		await port.poll();
		expect(state.closes).toBe(1);
		expect(port.snapshot()).toBeUndefined();
	});

	test("a new owned sender (another lifetime) gets a new client", async () => {
		const { state, port } = fake();
		state.replies.push(stats([link()]));
		await port.poll();
		state.owner = {
			...OWNER,
			lifetime: "22222222-2222-4222-8222-222222222222",
		};
		state.replies.push(stats([link()]));
		await port.poll();
		expect(state.connectedTo).toEqual([
			OWNER.lifetime,
			"22222222-2222-4222-8222-222222222222",
		]);
		expect(state.closes).toBe(1);
	});

	test("a connect that resolves after close is closed at once and reads nothing", async () => {
		const { state, port } = fake();
		const gate = Promise.withResolvers<void>();
		state.connectGate = gate.promise;
		state.replies.push(stats([link()]));
		const polling = port.poll();
		port.close();
		gate.resolve();
		await polling;
		expect(state.calls).toEqual([]);
		expect(state.closes).toBe(1);
		await port.poll();
		expect(state.connects).toBe(1);
	});
});

describe("how every link maps", () => {
	const ifs = [
		{ ifname: "wlan1", addresses: ["192.0.2.1"] },
		{ ifname: "wlan2", addresses: ["192.0.2.1", "192.0.2.2"] },
		{ ifname: "wwan0", addresses: ["100.64.0.2"] },
	];
	test("a link without counters is counted, and still mapped", () => {
		expect(
			linkMapping(
				[
					link({
						ip: "100.64.0.2",
						data_packets_queued_total: undefined,
						srtla_ack_entries_total: undefined,
						srtla_ack_epoch: undefined,
					}),
				],
				ifs,
			),
		).toEqual({ unmapped: 0, ambiguous: 0, uncounted: 1 });
	});
	test("an address two interfaces share is ambiguous even when both have links of their own", () => {
		expect(
			linkMapping(
				[
					link({ conn_id: 0, iface: "wlan1", ip: "192.0.2.1" }),
					link({ conn_id: 1, iface: "wlan2", ip: "192.0.2.2" }),
					link({ conn_id: 2, ip: "192.0.2.1" }),
				],
				ifs,
			),
		).toEqual({ unmapped: 0, ambiguous: 1, uncounted: 0 });
	});
	test("two links on one interface are both ambiguous; a link from nowhere is unmapped", () => {
		expect(
			linkMapping(
				[
					link({ conn_id: 0, iface: "wwan0" }),
					link({ conn_id: 1, iface: "wwan0" }),
					link({ conn_id: 2, ip: "198.51.100.9" }),
				],
				ifs,
			),
		).toEqual({ unmapped: 1, ambiguous: 2, uncounted: 0 });
	});
	test("the view carries the mapping of the last reply", async () => {
		const { state, port } = fake();
		state.replies.push(
			stats([link(), link({ conn_id: 1, ip: "203.0.113.5" })]),
		);
		await port.poll();
		expect(port.view().mapping).toEqual({
			unmapped: 1,
			ambiguous: 0,
			uncounted: 0,
		});
	});
});

describe("the owned sender's socket", () => {
	const STAT = `4242 (srtla_send) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 ${OWNER.startTime} 1000 100`;
	const io = (over: Partial<OwnerCheckIo> = {}): OwnerCheckIo => ({
		readText: async () => STAT,
		socketOwner: async () => ({ socket: true, uid: 0 }),
		uid: () => 0,
		...over,
	});
	test("the start time field is read past the command name", () => {
		expect(startTimeOf(STAT)).toBe(OWNER.startTime);
		expect(
			startTimeOf(
				"1 (a b) c) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 777 9",
			),
		).toBe("777");
	});
	test("the same process and a socket of ours: yes", async () => {
		expect(await isOwnedSenderSocket(OWNER, io())).toBe(true);
	});
	test("another process under the pid, a socket of another user, a plain file, or a failed read: no", async () => {
		expect(
			await isOwnedSenderSocket(
				OWNER,
				io({ readText: async () => STAT.replace(OWNER.startTime, "1") }),
			),
		).toBe(false);
		expect(
			await isOwnedSenderSocket(
				OWNER,
				io({ socketOwner: async () => ({ socket: true, uid: 1000 }) }),
			),
		).toBe(false);
		expect(
			await isOwnedSenderSocket(
				OWNER,
				io({ socketOwner: async () => ({ socket: false, uid: 0 }) }),
			),
		).toBe(false);
		expect(
			await isOwnedSenderSocket(
				OWNER,
				io({
					readText: async () => {
						throw new Error("ENOENT");
					},
				}),
			),
		).toBe(false);
	});
});

describe("what the sender can report and do", () => {
	test("links without arrival counters: reachable, no reports, no snapshot", async () => {
		const { state, port } = fake();
		state.replies.push(
			stats([
				link({
					data_packets_queued_total: undefined,
					srtla_ack_entries_total: undefined,
					srtla_ack_epoch: undefined,
				}),
			]),
		);
		await port.poll();
		expect(port.snapshot()).toBeUndefined();
		expect(port.view()).toMatchObject({
			reachable: true,
			arrivalReports: false,
		});
	});

	test("the standby is known from the capability document's methods, read once per connection", async () => {
		const { state, port } = fake();
		state.capabilities = doc(["get_stats", "set_link_standby"]);
		state.replies.push(stats([link()]), stats([link()]));
		await port.poll();
		await port.poll();
		expect(port.view()).toMatchObject({
			reachable: true,
			arrivalReports: true,
			standby: true,
		});
		expect(state.calls.filter((c) => c === "getCapabilities")).toHaveLength(1);
	});

	test("a sender without the method has no standby; one without a method list is unknown", async () => {
		const a = fake();
		a.state.replies.push(stats([link()]));
		await a.port.poll();
		expect(a.port.view().standby).toBe(false);
		const b = fake();
		b.state.capabilities = doc();
		b.state.replies.push(stats([link()]));
		await b.port.poll();
		expect(b.port.view().standby).toBeNull();
	});

	test("only reads reach the sender", async () => {
		const { state, port } = fake();
		state.replies.push(stats([link()]));
		await port.poll();
		port.close();
		expect(new Set(state.calls)).toEqual(
			new Set(["getCapabilities", "getStats"]),
		);
	});
});

describe("interface addresses", () => {
	test("each interface lists IPv4 and IPv6, an address-less one none", () => {
		expect(
			interfaceAddressesOf({
				wlan1: { ip: "192.0.2.1", ipv6: "2001:db8::1" },
				wlan2: { ipv6: "2001:db8::2" },
				eth0: {},
			}),
		).toEqual([
			{ ifname: "wlan1", addresses: ["192.0.2.1", "2001:db8::1"] },
			{ ifname: "wlan2", addresses: ["2001:db8::2"] },
			{ ifname: "eth0", addresses: [] },
		]);
	});
});
