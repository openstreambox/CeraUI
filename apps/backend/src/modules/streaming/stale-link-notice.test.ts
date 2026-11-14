import { describe, expect, test } from "bun:test";
import { notificationActionSchema } from "@ceraui/rpc/schemas";
import {
	createStaleLinkNotice,
	STALE_LINK_NOTICE,
	STALE_LINK_NOTICE_COOLDOWN_MS,
	type StaleLinkNoticeDeps,
	staleLinkMessage,
} from "./stale-link-notice.ts";

function fixture() {
	let clock = 0;
	let tokens = 0;
	const shown: Array<Parameters<StaleLinkNoticeDeps["show"]>[0]> = [];
	const removed: string[] = [];
	const notice = createStaleLinkNotice({
		now: () => clock,
		token: () => `token-${++tokens}`,
		show: (n) => shown.push(n),
		remove: (name) => removed.push(name),
		log: () => {},
	});
	return {
		notice,
		shown,
		removed,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

describe("stale link notice copy", () => {
	test("names the link with the UI's own label, and states the cost", () => {
		expect(staleLinkMessage({ count: 1, name: "Modem 2" })).toEqual({
			key: "notifications.staleLinkAddress",
			params: { link: "Modem 2" },
			msg: "Modem 2 isn't contributing because it's still using an old address. Restart connection? Viewers see your BRB screen for a few seconds.",
		});
		expect(staleLinkMessage({ count: 1 }).key).toBe(
			"notifications.staleLinkAddressUnnamed",
		);
		expect(staleLinkMessage({ count: 2, name: "Modem 2" }).key).toBe(
			"notifications.staleLinkAddressSeveral",
		);
	});

	test("says the other links carry the stream only when that was seen", () => {
		expect(
			staleLinkMessage({ count: 1, name: "Modem 2", othersCarrying: true }),
		).toEqual({
			key: "notifications.staleLinkAddressCarrying",
			params: { link: "Modem 2" },
			msg: "Modem 2 isn't contributing because it's still using an old address. Your other links are carrying the stream. Restart connection? Viewers see your BRB screen for a few seconds.",
		});
		expect(staleLinkMessage({ count: 1, othersCarrying: true }).key).toBe(
			"notifications.staleLinkAddressUnnamedCarrying",
		);
		expect(staleLinkMessage({ count: 3, othersCarrying: true }).key).toBe(
			"notifications.staleLinkAddressSeveralCarrying",
		);
		expect(staleLinkMessage({ count: 1, name: "eth1" }).msg).not.toContain(
			"carrying",
		);
	});

	test("never claims the stream is or is not live", () => {
		for (const links of [
			{ count: 1, name: "eth1" },
			{ count: 1 },
			{ count: 3 },
		]) {
			const { msg } = staleLinkMessage(links);
			expect(msg).not.toMatch(/still live|not live|offline|you're live/i);
			expect(msg).toContain("Viewers see your BRB screen");
		}
	});
});

describe("stale link offer", () => {
	test("offers a one-tap restart with a schema-valid command action", () => {
		const f = fixture();
		expect(f.notice.offer(5, { count: 1, name: "Modem 2" })).toBe(true);
		expect(f.shown).toHaveLength(1);
		const action = f.shown[0]?.action;
		expect(notificationActionSchema.parse(action)).toEqual({
			schema: 1,
			kind: "command",
			command: "restart-connection",
			token: "token-1",
			labelKey: "notifications.restartConnection",
		});
		expect(f.shown[0]?.name).toBe(STALE_LINK_NOTICE);
	});

	test("cannot repeat within the cooldown", () => {
		const f = fixture();
		f.notice.offer(5, { count: 1 });
		f.advance(STALE_LINK_NOTICE_COOLDOWN_MS - 1);
		expect(f.notice.offer(5, { count: 1 })).toBe(false);
		expect(f.notice.offer(6, { count: 1 })).toBe(false);
		expect(f.shown).toHaveLength(1);
		f.advance(1);
		expect(f.notice.offer(6, { count: 1 })).toBe(true);
		expect(f.shown).toHaveLength(2);
		// The newer offer replaces the older token.
		expect(f.notice.take("token-1", 6)).toBeUndefined();
	});

	test("a held automatic restart's offer is shown inside the cooldown, and restarts the cooldown", () => {
		const f = fixture();
		f.notice.offer(5, { count: 1 });
		f.advance(60_000);
		expect(f.notice.offer(5, { count: 1 }, { pastCooldown: true })).toBe(true);
		expect(f.shown).toHaveLength(2);
		// It counts as shown: an ordinary offer right after is still held.
		f.advance(STALE_LINK_NOTICE_COOLDOWN_MS - 1);
		expect(f.notice.offer(5, { count: 1 })).toBe(false);
	});

	test("one tap, one restart, and only for the session that raised it", () => {
		const f = fixture();
		f.notice.offer(5, { count: 1 });
		expect(f.notice.take("token-1", 6)).toBeUndefined();
		expect(f.notice.take("wrong", 5)).toBeUndefined();
		expect(f.notice.take("token-1", undefined)).toBeUndefined();
		expect(f.notice.take("token-1", 5)).toEqual({
			token: "token-1",
			generation: 5,
		});
		expect(f.removed).toEqual([STALE_LINK_NOTICE]);
		expect(f.notice.take("token-1", 5)).toBeUndefined();
	});

	test("retract only withdraws the offer of its own session", () => {
		const f = fixture();
		f.notice.offer(5, { count: 1 });
		f.notice.retract(4);
		expect(f.notice.current()).toBeDefined();
		f.notice.retract(5);
		expect(f.notice.current()).toBeUndefined();
		expect(f.removed).toEqual([STALE_LINK_NOTICE]);
	});

	test("closing the notice spends the token", () => {
		const f = fixture();
		f.notice.offer(5, { count: 1 });
		f.shown[0]?.onDismiss();
		expect(f.notice.take("token-1", 5)).toBeUndefined();
	});
});
