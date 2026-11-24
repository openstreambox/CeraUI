// @vitest-environment jsdom
/**
 * A notice can offer one allowlisted device command. The stale-link notice
 * offers "Restart connection": the tap sends the offer's own token, and an
 * outdated offer is refused by the device and said so, never silently ignored.
 */
import type { Notification } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastCalls: { level: string; text: string }[] = [];
const clearRecord = vi.fn(async (_input: unknown) => ({ success: true }));
const restartCalls: unknown[] = [];
let restartResult: "restarting" | "refused" | "transport-error" = "restarting";

vi.mock("svelte-sonner", () => {
	const record =
		(level: string) =>
		(text: string): string => {
			toastCalls.push({ level, text });
			return text;
		};
	const toast = Object.assign(record("default"), {
		success: record("success"),
		error: record("error"),
		warning: record("warning"),
		info: record("info"),
		dismiss: () => undefined,
	});
	return { toast };
});

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: { clearUnreadableRecord: (input: unknown) => clearRecord(input) },
		notifications: { dismiss: () => Promise.resolve({}) },
		streaming: {
			restartConnection: (input: unknown) => {
				restartCalls.push(input);
				if (restartResult === "transport-error")
					return Promise.reject(new Error("socket closed"));
				return Promise.resolve({
					success: restartResult === "restarting",
					result: restartResult,
				});
			},
		},
	},
}));

import {
	clearNotifications,
	getPersistent,
	push,
} from "$lib/stores/notifications.svelte";
import PersistentNotices from "$main/notifications/PersistentNotices.svelte";

function staleLink(): Notification {
	return {
		name: "stale_link_address",
		type: "info",
		msg: "Modem 2 is still using an old address. Restart connection? Viewers see your BRB screen for a few seconds.",
		key: "notifications.staleLinkAddress",
		params: { link: "Modem 2" },
		duration: 0,
		is_persistent: true,
		is_dismissable: true,
		action: {
			schema: 1,
			kind: "command",
			command: "restart-connection",
			token: "offer-1",
			labelKey: "notifications.restartConnection",
		},
	};
}

async function tap() {
	push(staleLink());
	const { container } = render(PersistentNotices);
	flushSync();
	const button = container.querySelector<HTMLButtonElement>(
		'[data-testid="persistent-notice-action"]',
	);
	expect(button).not.toBeNull();
	button?.click();
	for (let i = 0; i < 5; i++) await Promise.resolve();
	flushSync();
}

beforeEach(() => {
	toastCalls.length = 0;
	restartCalls.length = 0;
	restartResult = "restarting";
	clearNotifications();
});

afterEach(() => {
	clearNotifications();
});

describe("a command action on a persistent notice", () => {
	it("sends the offer's token and takes the notice down", async () => {
		await tap();
		expect(restartCalls).toEqual([{ token: "offer-1" }]);
		expect(getPersistent()).toHaveLength(0);
		expect(toastCalls).toEqual([]);
	});

	it("says nothing was restarted when the device refuses an outdated offer", async () => {
		restartResult = "refused";
		await tap();
		expect(restartCalls).toEqual([{ token: "offer-1" }]);
		expect(toastCalls).toHaveLength(1);
		expect(toastCalls[0]?.level).toBe("info");
		expect(toastCalls[0]?.text).toBe(
			"This restart option is out of date, so nothing was restarted.",
		);
	});

	it("never claims nothing was restarted when the device could not be reached", async () => {
		// The request may have reached the device before the reply was lost, so
		// only the device's own refusal may say nothing was restarted.
		restartResult = "transport-error";
		await tap();
		expect(restartCalls).toEqual([{ token: "offer-1" }]);
		expect(toastCalls).toEqual([
			{
				level: "warning",
				text: "Couldn't reach the device. Check the stream status before trying again.",
			},
		]);
		expect(toastCalls[0]?.text).not.toContain("nothing was restarted");
	});
});

it("requires an explicit confirmation for the current unreadable record; cancel keeps the warning", async () => {
	const token = "a1c66c88-3b78-4de7-9637-fc54dfb90bf3";
	const notice: Notification = {
		...staleLink(),
		name: "modem_recovery_record",
		is_dismissable: false,
		key: "notifications.modemRecoveryWarning",
		params: { record: "abc01234" },
		action: {
			schema: 1,
			kind: "confirm-modem-record",
			token,
			labelKey: "notifications.modemRecoveryReview",
		},
	};
	push(notice);
	render(PersistentNotices);
	const review = () =>
		screen.getByRole("button", { name: "Review recovery record" });
	await fireEvent.click(review());
	expect(await screen.findByRole("alertdialog")).toBeTruthy();
	expect(clearRecord).not.toHaveBeenCalled();
	await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
	await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	expect(getPersistent()).toHaveLength(1);
	await fireEvent.click(review());
	await fireEvent.click(
		await screen.findByRole("button", { name: "Clear recovery record" }),
	);
	expect(clearRecord).toHaveBeenCalledExactlyOnceWith({ token, confirm: true });
	expect(getPersistent()).toHaveLength(1);
});
