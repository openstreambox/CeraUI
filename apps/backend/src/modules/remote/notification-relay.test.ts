import { expect, test } from "bun:test";
import { strictParseFrame } from "@ceralive/control-protocol/parse";
import { notificationsMessageSchema } from "@ceraui/rpc/schemas";
import {
	createNotificationPeerRelay,
	isProtocolValidCloudFrame,
	NOTIFICATION_SUMMARIES,
	NotificationRelay,
	projectNotification,
} from "./notification-relay.ts";

const notice = (revision = 1) => ({
	name: "modem-SECRET-IMEI",
	type: "warning",
	msg: "srt://private:123?streamid=SECRET&passphrase=SECRET",
	key: "SECRET",
	params: { address: "SECRET", modem: "SECRET" },
	action: { url: "SECRET" },
	is_persistent: true,
	revision,
});
for (const path of ["cloud", "legacy"]) {
	test(`${path}: snapshot, update, offline clear, reconnect, dedupe and bounded backpressure`, () => {
		let snapshot = { show: [notice()], revision: 1 };
		let blocked = false;
		const frames: unknown[] = [];
		let connected = true;
		const socket = {
			get bufferedAmount() {
				return blocked ? 65537 : 0;
			},
			send(data: string) {
				frames.push(JSON.parse(data));
			},
		};
		const relay = createNotificationPeerRelay(
			path as "cloud" | "legacy",
			() => snapshot,
			() => (connected ? socket : undefined),
		);

		relay.flush(true);
		relay.flush();
		expect(frames).toHaveLength(1);
		expect(JSON.stringify(frames)).not.toContain("SECRET");
		snapshot = { show: [{ ...notice(2), type: "error" }], revision: 2 };
		relay.flush();
		expect(frames).toHaveLength(2);
		blocked = true;
		connected = false;
		snapshot = { show: [], revision: 3 };
		for (let i = 0; i < 1000; i++) relay.flush();
		expect(frames).toHaveLength(2);
		blocked = false;
		connected = true;
		relay.flush(true);
		expect(JSON.stringify(frames[2])).toContain('"revision":3');
		expect(JSON.stringify(frames[2])).toContain('"remove"');
		relay.flush();
		expect(frames).toHaveLength(3);
	});
}
test("projection drops transient and invalid notices and all unreviewed text and fields", () => {
	expect(
		projectNotification({ ...notice(), is_persistent: false }),
	).toBeUndefined();
	expect(projectNotification({ ...notice(), revision: NaN })).toBeUndefined();
	const safe = projectNotification(notice());
	expect(safe).toMatchObject({
		type: "warning",
		is_persistent: true,
		duration: 0,
	});
	expect(JSON.stringify(safe)).not.toContain("SECRET");
});
test("throwing peer is isolated, retries latest state only", () => {
	let fail = true;
	const relay = new NotificationRelay(
		() => ({ show: [notice()], revision: 1 }),
		() => {
			if (fail) throw Error("offline");
			return true;
		},
	);
	expect(() => relay.flush()).not.toThrow();
	fail = false;
	expect(() => relay.flush()).not.toThrow();
});

test("empty reconnect snapshot retries after backpressure", () => {
	let fail = true;
	let accepted = 0;
	const relay = new NotificationRelay(
		() => ({ show: [], revision: 0 }),
		() => {
			if (fail) return false;
			accepted++;
			return true;
		},
	);
	relay.flush(true);
	fail = false;
	relay.flush();
	expect(accepted).toBe(1);
});

test("every reviewed category rejects hostile payload values, including updates and clears", () => {
	for (const name of [
		...Object.keys(NOTIFICATION_SUMMARIES),
		"modem_roaming:SECRET",
		"capture-input-lost:SECRET",
		"__proto__",
		"constructor",
	]) {
		const projected = projectNotification({
			...notice(),
			name,
			settings: { password: "SECRET" },
			streamid: "SECRET",
			passphrase: "SECRET",
			address: "SECRET",
			imei: "SECRET",
		});
		expect(typeof projected?.msg).toBe("string");
		expect(JSON.stringify(projected)).not.toContain("SECRET");
		expect(Object.keys(projected ?? {}).sort()).toEqual([
			"duration",
			"is_dismissable",
			"is_persistent",
			"msg",
			"name",
			"revision",
			"type",
		]);
	}
});

// ── Protocol contract, restart epoch and change detection ──────────────────

/** Record every frame a relay emits through a fake, always-writable peer. */
function recordingRelay(
	path: "cloud" | "legacy",
	snapshot: () => { show: unknown[]; revision: number },
	options?: { epoch?: string; now?: () => number },
) {
	const frames: Record<string, unknown>[] = [];
	const relay = createNotificationPeerRelay(
		path,
		snapshot,
		() => ({ send: (data: string) => frames.push(JSON.parse(data)) }),
		options,
	);
	return { relay, frames };
}

test("every emitted cloud frame passes the pinned hub contract's strictParseFrame", () => {
	let snapshot = { show: [notice(1)], revision: 1 };
	let t = 0;
	const { relay, frames } = recordingRelay("cloud", () => snapshot, {
		now: () => t,
	});
	relay.flush(true); // connect-time list
	snapshot = {
		show: [notice(2), { ...notice(3), name: "hdmi_error", type: "error" }],
		revision: 3,
	};
	relay.flush(); // update
	snapshot = { show: [], revision: 4 };
	t += 1000; // past the coalescing window
	relay.flush(); // clear
	relay.flush(true); // reconnect, empty list
	expect(frames).toHaveLength(4);
	for (const frame of frames) {
		const parsed = strictParseFrame(frame);
		expect(parsed.kind).toBe("status");
		expect(parsed.type).toBe("notifications");
		// Strict parsing must not strip the fields a consumer relies on.
		expect(parsed.payload).toEqual(frame.payload as Record<string, unknown>);
	}
});

test("every emitted legacy frame is a valid notifications message for the existing client", () => {
	let snapshot = { show: [notice(1)], revision: 1 };
	let t = 0;
	const { relay, frames } = recordingRelay("legacy", () => snapshot, {
		now: () => t,
	});
	relay.flush(true);
	snapshot = { show: [], revision: 2 };
	t += 1000; // past the coalescing window
	relay.flush();
	expect(frames).toHaveLength(2);
	for (const frame of frames) {
		expect(Object.keys(frame)).toEqual(["notification"]);
		expect(
			notificationsMessageSchema.safeParse(frame.notification).success,
		).toBe(true);
	}
});

/** Reference consumer implementing the documented contract: fence by seq
 * within an epoch, reset on a new epoch, and replace the list on `full`. */
function referenceConsumer() {
	let epoch: string | undefined;
	let lastSeq = -1;
	let shown = new Map<string, unknown>();
	return {
		apply(frame: Record<string, unknown>) {
			const payload = frame.payload as {
				epoch: string;
				full?: boolean;
				show: { name: string }[];
				remove: { id: string }[];
			};
			const seq = frame.seq as number;
			if (payload.epoch === epoch && seq <= lastSeq) return; // stale
			if (payload.epoch !== epoch) shown = new Map();
			epoch = payload.epoch;
			lastSeq = seq;
			if (payload.full) shown = new Map();
			for (const n of payload.show) shown.set(n.name, n);
			for (const r of payload.remove) shown.delete(r.id);
		},
		get names() {
			return [...shown.keys()];
		},
	};
}

test("a backend restart is distinguishable: new epoch, full replace, consumer drops stale notices", () => {
	const consumer = referenceConsumer();
	// Process A raises two notices and advances its seq.
	let a = { show: [notice(1)], revision: 1 };
	let t = 0;
	const procA = recordingRelay("cloud", () => a, {
		epoch: "epoch-a",
		now: () => t,
	});
	procA.relay.flush(true);
	a = { show: [notice(2), { ...notice(3), name: "hdmi_error" }], revision: 3 };
	procA.relay.flush();
	a = { show: [{ ...notice(4), name: "hdmi_error" }], revision: 4 };
	t += 1000; // past the coalescing window
	procA.relay.flush();
	for (const f of procA.frames) consumer.apply(f);
	expect(consumer.names).toHaveLength(1);

	// Process B (restart): nothing persistent yet, seq restarts at 1.
	let b = { show: [] as unknown[], revision: 0 };
	const procB = recordingRelay("cloud", () => b, { epoch: "epoch-b" });
	procB.relay.flush(true);
	const first = procB.frames[0] as {
		seq: number;
		payload: { epoch: string; full: boolean };
	};
	expect(first.seq).toBe(1);
	expect(first.payload.epoch).toBe("epoch-b");
	expect(first.payload.full).toBe(true);
	consumer.apply(procB.frames[0] as Record<string, unknown>);
	expect(consumer.names).toEqual([]);

	// New notices after the restart are not fenced out by the old seq.
	b = { show: [{ ...notice(1), name: "no_internet" }], revision: 1 };
	procB.relay.flush();
	consumer.apply(procB.frames[1] as Record<string, unknown>);
	expect(consumer.names).toHaveLength(1);
});

test("the process epoch is stable within a process and carried on both paths", () => {
	const cloud = recordingRelay("cloud", () => ({ show: [], revision: 0 }));
	const legacy = recordingRelay("legacy", () => ({ show: [], revision: 0 }));
	cloud.relay.flush(true);
	cloud.relay.flush(true);
	legacy.relay.flush(true);
	const legacyBody = legacy.frames[0]?.notification as
		| { epoch: string; full: boolean }
		| undefined;
	const epochs = [
		...cloud.frames.map((f) => (f.payload as { epoch: string }).epoch),
		legacyBody?.epoch,
	];
	expect(epochs[0]).toMatch(/^[0-9a-f-]{36}$/);
	expect(new Set(epochs).size).toBe(1);
	expect(legacyBody?.full).toBe(true);
});

test("a re-raise that only bumps the revision does not re-send unchanged content", () => {
	let snapshot = { show: [notice(1)], revision: 1 };
	const { relay, frames } = recordingRelay("cloud", () => snapshot);
	relay.flush(true);
	for (let r = 2; r < 10; r++) {
		snapshot = { show: [notice(r)], revision: r };
		relay.flush();
	}
	expect(frames).toHaveLength(1);
	// A change of projected content (severity) is sent.
	snapshot = { show: [{ ...notice(10), type: "error" }], revision: 10 };
	relay.flush();
	expect(frames).toHaveLength(2);
	// A forced connect-time flush is still sent even when unchanged.
	relay.flush(true);
	expect(frames).toHaveLength(3);
});

test("the cloud path can write through an injected frame sender", () => {
	const sent: unknown[] = [];
	const relay = createNotificationPeerRelay(
		"cloud",
		() => ({ show: [notice(1)], revision: 1 }),
		() => ({
			bufferedAmount: 0,
			send: () => {
				throw Error("raw write used");
			},
		}),
		{
			sendFrame: (frame) => {
				sent.push(frame);
				return true;
			},
		},
	);
	relay.flush(true);
	expect(sent).toHaveLength(1);
	expect(strictParseFrame(sent[0])).toMatchObject({ type: "notifications" });
});

// ── Oversized lists, flapping, production frame validation ─────────────────

/** A manual monotonic clock for rate-limit tests. */
function fakeClock(start = 0) {
	let t = start;
	return {
		now: () => t,
		tick(ms: number) {
			t += ms;
		},
	};
}

/** Many distinct persistent notices; names are unique so none collapse. */
function manyNotices(count: number, type: string) {
	return Array.from({ length: count }, (_, i) => ({
		...notice(i + 1),
		name: `${type}-producer-${i}`,
		type,
	}));
}

test("an oversized list keeps the most severe notices, adds a summary and logs once", () => {
	const logs: string[] = [];
	// all-links-down is raised last, behind hundreds of lower-severity notices.
	let snapshot = {
		show: [
			...manyNotices(200, "info"),
			...manyNotices(200, "warning"),
			{ ...notice(500), name: "all-links-down", type: "error" },
		] as unknown[],
		revision: 500,
	};
	const clock = fakeClock();
	const frames: Record<string, unknown>[] = [];
	const relay = createNotificationPeerRelay(
		"cloud",
		() => snapshot,
		() => ({ send: (data: string) => frames.push(JSON.parse(data)) }),
		{ now: clock.now, log: (m) => logs.push(m) },
	);
	relay.flush(true);
	expect(frames).toHaveLength(1);
	const frame = frames[0] as {
		payload: { show: { name: string; type: string; msg: string }[] };
	};
	expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(65536);
	const show = frame.payload.show;
	expect(show.some((n) => n.msg.startsWith("All bonded links are down"))).toBe(
		true,
	);
	// Severity order: every warning that fits goes before any info notice.
	const warnings = show.filter((n) => n.type === "warning").length;
	const infos = show.filter((n) => n.type === "info").length;
	expect(warnings).toBeGreaterThan(0);
	if (infos > 0) expect(warnings).toBe(200);
	// The last entry tells the remote side how many more are on the device.
	const summary = show.at(-1);
	expect(summary?.name).toBe("remote-overflow");
	const omitted = 401 - (show.length - 1);
	expect(summary?.msg).toContain(`${omitted} more`);
	expect(strictParseFrame(frame).type).toBe("notifications");
	expect(logs).toHaveLength(1);

	// Unchanged oversized content does not re-send, and logging stays at once.
	relay.flush();
	clock.tick(5000);
	relay.flush();
	expect(frames).toHaveLength(1);
	snapshot = { show: snapshot.show.slice(1), revision: 501 };
	relay.flush();
	expect(frames).toHaveLength(2);
	expect(logs).toHaveLength(1);
	// Apply frames in the client's show-then-remove order, including merges by id.
	const visible = new Map<string, unknown>();
	for (const raw of frames) {
		const payload = raw.payload as {
			show: { name: string }[];
			remove: { id: string }[];
		};
		for (const n of payload.show) visible.set(n.name, n);
		for (const n of payload.remove) visible.delete(n.id);
		expect(visible.has("remote-overflow")).toBe(true);
	}
});

test("a flapping notice is coalesced to at most one frame per second carrying the latest state", () => {
	const clock = fakeClock();
	const steady = { ...notice(1), name: "hdmi_error", type: "warning" };
	const flapping = { ...notice(1), name: "no_internet", type: "warning" };
	let revision = 1;
	let up = false;
	const snapshot = () => ({
		show: up ? [steady, { ...flapping, revision }] : [steady],
		revision,
	});
	const frames: Record<string, unknown>[] = [];
	const relay = createNotificationPeerRelay(
		"cloud",
		snapshot,
		() => ({ send: (data: string) => frames.push(JSON.parse(data)) }),
		{ now: clock.now },
	);
	relay.flush(true);
	expect(frames).toHaveLength(1);

	// The first appearance of a new problem goes out on the same tick.
	clock.tick(250);
	up = true;
	revision++;
	relay.flush();
	expect(frames).toHaveLength(2);

	// Ten seconds of the same notice toggling on every 250 ms tick.
	for (let i = 0; i < 40; i++) {
		clock.tick(250);
		up = !up;
		revision++;
		relay.flush();
	}
	expect(frames.length).toBeLessThanOrEqual(2 + 10);
	expect(frames.length).toBeGreaterThanOrEqual(2 + 4);

	// The flapping stops in the cleared state: within one second the latest
	// state is on the wire.
	up = false;
	revision++;
	for (let i = 0; i < 4; i++) {
		clock.tick(250);
		relay.flush();
	}
	const last = frames.at(-1) as { payload: { show: unknown[] } };
	expect(last.payload.show).toHaveLength(1);
	const settled = frames.length;
	for (let i = 0; i < 8; i++) {
		clock.tick(250);
		relay.flush();
	}
	expect(frames).toHaveLength(settled);
});

test("a different new problem is sent at once even inside the coalescing window", () => {
	const clock = fakeClock();
	let show: unknown[] = [{ ...notice(1), name: "hdmi_error" }];
	const frames: Record<string, unknown>[] = [];
	const relay = createNotificationPeerRelay(
		"legacy",
		() => ({ show, revision: 3 }),
		() => ({ send: (data: string) => frames.push(JSON.parse(data)) }),
		{ now: clock.now },
	);
	relay.flush(true);
	clock.tick(100);
	show = [];
	relay.flush(); // a clear may wait for the window
	expect(frames).toHaveLength(1);
	clock.tick(100);
	show = [{ ...notice(2), name: "all-links-down", type: "error" }];
	relay.flush();
	expect(frames).toHaveLength(2);
	const body = (frames[1] as { notification: { show: { msg: string }[] } })
		.notification;
	expect(body.show[0]?.msg).toStartWith("All bonded links are down");
	// The notice cleared a moment ago comes back: that is flapping, so it waits.
	const linksDown = { ...notice(3), name: "all-links-down", type: "error" };
	clock.tick(100);
	show = [linksDown, { ...notice(3), name: "hdmi_error", type: "warning" }];
	relay.flush();
	expect(frames).toHaveLength(2);
	// A severity rise above what the remote side saw recently goes at once.
	clock.tick(100);
	show = [linksDown, { ...notice(4), name: "hdmi_error", type: "error" }];
	relay.flush();
	expect(frames).toHaveLength(3);
});

test("production checks each cloud frame against the pinned contract before sending", () => {
	expect(
		isProtocolValidCloudFrame({
			v: 1,
			kind: "status",
			type: "notification",
			cid: crypto.randomUUID(),
			seq: 1,
			payload: {},
		}),
	).toBe(false);
	const logs: string[] = [];
	let valid = false;
	const frames: unknown[] = [];
	const relay = createNotificationPeerRelay(
		"cloud",
		() => ({ show: [notice(1)], revision: 1 }),
		() => ({ send: (data: string) => frames.push(JSON.parse(data)) }),
		{ validate: () => valid, log: (m) => logs.push(m) },
	);
	relay.flush(true);
	relay.flush();
	relay.flush();
	expect(frames).toHaveLength(0);
	expect(logs).toHaveLength(1);
	valid = true;
	relay.flush();
	expect(frames).toHaveLength(1);
	expect(isProtocolValidCloudFrame(frames[0])).toBe(true);
	expect((frames[0] as { seq: number }).seq).toBe(1);
});
