// @vitest-environment jsdom
/**
 * The box's reconnect settings: on by default with two minutes, saved through
 * `streaming.setReconnect`, and adopted from what the device persisted.
 */
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, expect, it, vi } from "vitest";
import ReconnectSetting from "./ReconnectSetting.svelte";

const state = vi.hoisted(() => ({
	config: {} as { auto_reconnect?: boolean; auto_reconnect_max_s?: number },
	setReconnect: vi.fn(),
}));
vi.mock("$lib/rpc/client", () => ({
	rpc: { streaming: { setReconnect: state.setReconnect } },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => state.config,
}));
beforeEach(() => {
	state.config = {};
	state.setReconnect.mockReset();
});

it("is on with two minutes when the device has no setting yet", () => {
	const view = render(ReconnectSetting);
	const control = view.getByRole("switch", {
		name: "Reconnect after losing every link",
	});
	expect(control.getAttribute("aria-checked")).toBe("true");
	expect(
		view.getByTestId("settings-auto-reconnect-max").textContent?.trim(),
	).toBe("2 min");
});

it("turns reconnecting off on the device and adopts what it persisted", async () => {
	state.setReconnect.mockResolvedValue({
		success: true,
		applied: { enabled: false, max_s: 120 },
	});
	const view = render(ReconnectSetting);
	const control = view.getByRole("switch", {
		name: "Reconnect after losing every link",
	});
	await fireEvent.click(control);
	await waitFor(() =>
		expect(state.setReconnect).toHaveBeenCalledWith({ enabled: false }),
	);
	await waitFor(() =>
		expect(control.getAttribute("aria-checked")).toBe("false"),
	);
	// The time limit has nothing to bound while reconnecting is off.
	expect(
		view
			.getByTestId("settings-auto-reconnect-max")
			.hasAttribute("data-disabled"),
	).toBe(true);
});

it("shows a stored time limit that is not one of the choices", () => {
	state.config = { auto_reconnect_max_s: 90 };
	const view = render(ReconnectSetting);
	expect(
		view.getByTestId("settings-auto-reconnect-max").textContent?.trim(),
	).toBe("1.5 min");
});
