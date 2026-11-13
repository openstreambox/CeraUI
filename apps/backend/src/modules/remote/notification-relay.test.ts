import { expect, test } from "bun:test";
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
		snapshot = { show: [notice(2)], revision: 2 };
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
