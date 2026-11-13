import { expect, test } from "bun:test";
import { strictParseFrame } from "@ceralive/control-protocol/parse";
import { notificationsMessageSchema } from "@ceraui/rpc/schemas";
import {
	createNotificationPeerRelay,
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
	options?: { epoch?: string },
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
	const { relay, frames } = recordingRelay("cloud", () => snapshot);
	relay.flush(true); // connect-time list
	snapshot = {
		show: [notice(2), { ...notice(3), name: "hdmi_error", type: "error" }],
		revision: 3,
	};
	relay.flush(); // update
	snapshot = { show: [], revision: 4 };
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
	const { relay, frames } = recordingRelay("legacy", () => snapshot);
	relay.flush(true);
	snapshot = { show: [], revision: 2 };
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
	const procA = recordingRelay("cloud", () => a, { epoch: "epoch-a" });
	procA.relay.flush(true);
	a = { show: [notice(2), { ...notice(3), name: "hdmi_error" }], revision: 3 };
	procA.relay.flush();
	a = { show: [{ ...notice(4), name: "hdmi_error" }], revision: 4 };
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
