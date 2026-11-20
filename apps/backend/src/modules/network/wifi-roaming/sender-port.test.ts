import { describe, expect, test } from "bun:test";
import type { SenderLinkStats, SenderStats } from "@ceraui/srtla-send/control";
import { createSenderPort, type SenderPortDeps } from "./sender-port.ts";

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

/** A fake sender behind the control socket, and the port's other inputs. */
function fake() {
	const state = {
		now: 1_000,
		replies: [] as (SenderStats | null | Error)[],
		reachable: true,
		connects: 0,
		closes: 0,
		kbps: null as number | null,
	};
	const deps: SenderPortDeps = {
		now: () => state.now,
		connect: async () => {
			state.connects++;
			if (!state.reachable) return null;
			return {
				getStats: async () => {
					const next = state.replies.shift() ?? null;
					if (next instanceof Error) throw next;
					return next;
				},
				close: () => {
					state.closes++;
				},
			};
		},
		radios: () => [{ ifname: "wlan1", addresses: ["192.168.1.10"] }],
		appliedKbps: () => state.kbps,
	};
	return { state, port: createSenderPort(deps) };
}

describe("the sender port", () => {
	test("maps a get_stats reply onto the radios, stamped on the caller's clock", async () => {
		const { state, port } = fake();
		expect(port.senderLinks()).toBeUndefined();
		state.replies.push(stats([link()]));
		await port.poll();
		const snap = port.senderLinks();
		expect(snap?.at).toBe(1_000);
		expect(snap?.radios.get("wlan1")?.queued).toBe(100);
	});

	test("a reply with the same state is the same sample: its time does not advance", async () => {
		const { state, port } = fake();
		state.replies.push(stats([link()]));
		await port.poll();
		state.now = 2_000;
		state.replies.push(stats([link()]));
		await port.poll();
		expect(port.senderLinks()?.at).toBe(1_000);
		state.now = 3_000;
		state.replies.push(stats([link({ data_packets_queued_total: 160 })]));
		await port.poll();
		expect(port.senderLinks()?.at).toBe(3_000);
	});

	test("a changed age or epoch alone is a new sample", async () => {
		const { state, port } = fake();
		state.replies.push(stats([link()]));
		await port.poll();
		state.now = 2_000;
		state.replies.push(stats([link({ last_srtla_ack_age_ms: 1_200 })]));
		await port.poll();
		expect(port.senderLinks()?.at).toBe(2_000);
		state.now = 3_000;
		state.replies.push(
			stats([link({ last_srtla_ack_age_ms: 1_200, srtla_ack_epoch: 4 })]),
		);
		await port.poll();
		expect(port.senderLinks()?.at).toBe(3_000);
	});

	test("a failed read gives no snapshot and reconnects next time", async () => {
		const { state, port } = fake();
		state.replies.push(stats([link()]));
		await port.poll();
		state.replies.push(null);
		await port.poll();
		expect(port.senderLinks()).toBeUndefined();
		expect(state.closes).toBe(1);
		state.replies.push(stats([link()]));
		await port.poll();
		expect(state.connects).toBe(2);
		expect(port.senderLinks()).toBeDefined();
	});

	test("a read that throws gives no snapshot and never throws", async () => {
		const { state, port } = fake();
		state.replies.push(new Error("socket closed"));
		await port.poll();
		expect(port.senderLinks()).toBeUndefined();
	});

	test("an unreachable sender gives no snapshot", async () => {
		const { state, port } = fake();
		state.reachable = false;
		await port.poll();
		expect(port.senderLinks()).toBeUndefined();
	});

	test("a sender without arrival counters gives no snapshot", async () => {
		const { state, port } = fake();
		state.replies.push(
			stats([
				link({
					srtla_ack_epoch: undefined,
					data_packets_queued_total: undefined,
					srtla_ack_entries_total: undefined,
				}),
			]),
		);
		await port.poll();
		expect(port.senderLinks()).toBeUndefined();
	});

	test("after a failure the first good reply is a new sample even if unchanged", async () => {
		const { state, port } = fake();
		state.replies.push(stats([link()]));
		await port.poll();
		state.replies.push(null);
		await port.poll();
		state.now = 5_000;
		state.replies.push(stats([link()]));
		await port.poll();
		expect(port.senderLinks()?.at).toBe(5_000);
	});

	test("the encoder rate is the applied rate in bits/s, null when unknown", () => {
		const { state, port } = fake();
		expect(port.encoderRate()).toBeNull();
		state.kbps = 4_500;
		expect(port.encoderRate()).toBe(4_500_000);
		state.kbps = 0;
		expect(port.encoderRate()).toBeNull();
		state.kbps = Number.NaN;
		expect(port.encoderRate()).toBeNull();
	});

	test("overlapping polls share one read and never leak a client", async () => {
		const { state, port } = fake();
		state.replies.push(
			stats([link()]),
			stats([link({ data_packets_queued_total: 160 })]),
		);
		// Two rounds' polls overlap (a timer that does not await the last one).
		await Promise.all([port.poll(), port.poll()]);
		expect(state.connects).toBe(1);
		port.close();
		expect(state.connects - state.closes).toBe(0);
		// The two callers got one read; the next poll reads the second reply.
		expect(port.senderLinks()).toBeUndefined();
	});

	test("polls that do not overlap each read", async () => {
		const { state, port } = fake();
		state.replies.push(
			stats([link()]),
			stats([link({ data_packets_queued_total: 160 })]),
		);
		await port.poll();
		state.now = 2_000;
		await port.poll();
		expect(port.senderLinks()?.radios.get("wlan1")?.queued).toBe(160);
	});

	test("close drops the client and the snapshot", async () => {
		const { state, port } = fake();
		state.replies.push(stats([link()]));
		await port.poll();
		port.close();
		expect(state.closes).toBe(1);
		expect(port.senderLinks()).toBeUndefined();
	});
});
