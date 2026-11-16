import { beforeEach, expect, test } from "bun:test";
import type { ModemMutationBlock } from "@ceraui/rpc/schemas";
import {
	HELD_OUT_KEY,
	HELD_OUT_UNKNOWN_KEY,
	type HeldOutNoticeDeps,
	resetHeldOutNoticesForTest,
	syncHeldOutModemNotices,
} from "./held-out-modem-notice.ts";

const KEY = "platform-xhci-hcd.0.auto-usb-0:1.2";
const block = (
	state: ModemMutationBlock["state"],
	blocksStreaming = true,
): ModemMutationBlock => ({
	stableKey: KEY,
	kind: "modem-config",
	state,
	updatedAt: 1,
	devicePresent: true,
	blocksStreaming,
});

function fake(labels: Map<string, string>) {
	const events: string[] = [];
	const deps: HeldOutNoticeDeps = {
		notify: (
			name,
			type,
			_msg,
			_d,
			persistent,
			dismissable,
			_a,
			key,
			params,
		) => {
			events.push(
				`raise ${name} ${type} ${persistent} ${dismissable} ${key} ${params?.name ?? "-"}`,
			);
		},
		remove: (name) => {
			events.push(`remove ${name}`);
		},
		labelFor: (key) => labels.get(key),
	};
	return { deps, events };
}

beforeEach(() => resetHeldOutNoticesForTest());

test("a held-out modem with a row is named, once per episode, and retracted when released", () => {
	const { deps, events } = fake(new Map([[KEY, "RM520N-GL"]]));
	syncHeldOutModemNotices([block("failed")], deps);
	syncHeldOutModemNotices([block("failed")], deps);
	syncHeldOutModemNotices([], deps);
	expect(events).toEqual([
		`raise modem_held_out:${KEY} warning true false ${HELD_OUT_KEY} RM520N-GL`,
		`remove modem_held_out:${KEY}`,
	]);
});

test("a modem with no current row (unplugged or renamed) still gets a notice", () => {
	const labels = new Map<string, string>();
	const { deps, events } = fake(labels);
	syncHeldOutModemNotices([block("device-absent-quarantine")], deps);
	expect(events).toEqual([
		`raise modem_held_out:${KEY} warning true false ${HELD_OUT_UNKNOWN_KEY} -`,
	]);
	// When the modem gets its row back, the notice is re-raised with its name.
	labels.set(KEY, "RM520N-GL");
	syncHeldOutModemNotices([block("device-absent-quarantine")], deps);
	expect(events.at(-1)).toBe(
		`raise modem_held_out:${KEY} warning true false ${HELD_OUT_KEY} RM520N-GL`,
	);
});

test("changes in flight and decommissioned modems raise nothing", () => {
	const { deps, events } = fake(new Map());
	syncHeldOutModemNotices(
		[block("armed"), block("executing"), block("decommissioned", false)],
		deps,
	);
	expect(events).toEqual([]);
});

test("a failing notifier never breaks the block projection", () => {
	const deps: HeldOutNoticeDeps = {
		notify: () => {
			throw new Error("socket gone");
		},
		remove: () => undefined,
		labelFor: () => undefined,
	};
	expect(() => syncHeldOutModemNotices([block("failed")], deps)).not.toThrow();
});

for (const operation of ["notify", "remove"] as const) {
	test(`a failed ${operation} is retried on the next projection`, () => {
		const { deps, events } = fake(new Map());
		let fail = true;
		const flaky = {
			...deps,
			[operation]: (...args: never[]) => {
				if (fail) {
					fail = false;
					throw new Error("socket gone");
				}
				(deps[operation] as (...args: never[]) => void)(...args);
			},
		};
		if (operation === "remove")
			syncHeldOutModemNotices([block("failed")], deps);
		const wanted = operation === "notify" ? [block("failed")] : [];
		syncHeldOutModemNotices(wanted, flaky);
		syncHeldOutModemNotices(wanted, flaky);
		syncHeldOutModemNotices(wanted, flaky);
		expect(
			events.filter((event) =>
				event.startsWith(operation === "notify" ? "raise" : "remove"),
			),
		).toHaveLength(1);
	});
}
