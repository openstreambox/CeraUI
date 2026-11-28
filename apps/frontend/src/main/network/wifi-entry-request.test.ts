import type { WifiInterface } from "@ceraui/rpc/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";

const next = vi.hoisted(() => ({
	row: undefined as Partial<WifiInterface> | undefined,
}));
vi.mock("$lib/rpc/wifi-status-receipt", () => ({
	waitForWifiStatus: vi.fn(async () => next.row),
	// Upstream's intervening-transition observer; these cases see none.
	observeWifiStatus: vi.fn(() => () => {}),
}));

import { withWifiEntryRetry } from "./wifi-entry-request";

const binding = {
	device: "0",
	incarnation: "radio-A",
	link: 1,
	session: 1,
} as const;
const unobserved = {
	success: false,
	error: "radio-changed",
	reason: "current-unobserved",
} as const;

function owner(
	canRetry = vi.fn(() => true),
	onReplacement = vi.fn(),
	currentToken: () => string | undefined = () => "radio-A",
) {
	return {
		signal: new AbortController().signal,
		current: () => true,
		currentToken,
		canRetry,
		onReplacement,
	};
}

beforeEach(() => {
	next.row = { incarnation: "radio-A" };
});

describe("the current-unobserved entry retry", () => {
	it("resends once when the next status frame carries the same token", async () => {
		const invoke = vi
			.fn()
			.mockResolvedValueOnce(unobserved)
			.mockResolvedValueOnce({ success: true });
		const canRetry = vi.fn(() => true);
		expect(await withWifiEntryRetry(binding, invoke, owner(canRetry))).toEqual({
			success: true,
		});
		expect(invoke.mock.calls.map(([token]) => token)).toEqual([
			"radio-A",
			"radio-A",
		]);
		expect(canRetry).toHaveBeenCalledOnce();
	});

	it("refuses a different token: the first refusal stands and nothing is resent", async () => {
		next.row = { incarnation: "radio-B" };
		const invoke = vi.fn().mockResolvedValue(unobserved);
		const canRetry = vi.fn(() => true);
		const onReplacement = vi.fn();
		expect(
			await withWifiEntryRetry(binding, invoke, owner(canRetry, onReplacement)),
		).toBe(unobserved);
		expect(invoke).toHaveBeenCalledOnce();
		expect(canRetry).not.toHaveBeenCalled();
		expect(onReplacement).toHaveBeenCalledOnce();
	});

	it("refuses a replacement already on screen without waiting for another frame", async () => {
		const invoke = vi.fn().mockResolvedValue(unobserved);
		const canRetry = vi.fn(() => true);
		const onReplacement = vi.fn();
		expect(
			await withWifiEntryRetry(
				binding,
				invoke,
				owner(canRetry, onReplacement, () => "radio-B"),
			),
		).toBe(unobserved);
		expect(invoke).toHaveBeenCalledOnce();
		expect(canRetry).not.toHaveBeenCalled();
		expect(onReplacement).toHaveBeenCalledOnce();
	});

	it("sends nothing more when the next frame has no token", async () => {
		next.row = {};
		const invoke = vi.fn().mockResolvedValue(unobserved);
		expect(await withWifiEntryRetry(binding, invoke, owner())).toBeUndefined();
		expect(invoke).toHaveBeenCalledOnce();
	});

	it("does not resend an operation it no longer owns", async () => {
		const invoke = vi.fn().mockResolvedValue(unobserved);
		expect(
			await withWifiEntryRetry(binding, invoke, owner(vi.fn(() => false))),
		).toBe(unobserved);
		expect(invoke).toHaveBeenCalledOnce();
	});

	it("never sends without a token", async () => {
		const invoke = vi.fn();
		expect(
			await withWifiEntryRetry(
				{ ...binding, incarnation: undefined },
				invoke,
				owner(),
			),
		).toBeUndefined();
		expect(invoke).not.toHaveBeenCalled();
	});
});
