// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, expect, it, vi } from "vitest";
import PortalSetting from "./PortalSetting.svelte";

const state = vi.hoisted(() => ({
	enabled: undefined as boolean | undefined,
	portal: vi.fn(),
}));
vi.mock("$lib/rpc/client", () => ({ rpc: { wifi: { portal: state.portal } } }));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => ({ captive_portal_enabled: state.enabled }),
}));
beforeEach(() => {
	state.enabled = undefined;
	state.portal.mockReset();
});
it("starts disabled and saves an explicit experimental opt-in", async () => {
	state.portal.mockResolvedValue({ phase: "idle" });
	const view = render(PortalSetting);
	const control = view.getByRole("switch", {
		name: "Wi-Fi sign-in (experimental)",
	});
	expect(control.getAttribute("aria-checked")).toBe("false");
	await fireEvent.click(control);
	await waitFor(() =>
		expect(state.portal).toHaveBeenCalledWith({
			action: "configure",
			enabled: true,
		}),
	);
	await waitFor(() =>
		expect(control.getAttribute("aria-checked")).toBe("true"),
	);
	await fireEvent.click(control);
	await waitFor(() =>
		expect(state.portal).toHaveBeenLastCalledWith({
			action: "configure",
			enabled: false,
		}),
	);
});
it("leaves a failed opt-in disabled and explains the failure", async () => {
	state.portal.mockRejectedValue(new Error("disk full"));
	vi.spyOn(console, "error").mockImplementation(() => {});
	const view = render(PortalSetting);
	const control = view.getByRole("switch");
	await fireEvent.click(control);
	await waitFor(() =>
		expect(view.getByRole("status").textContent).toContain(
			"could not be saved",
		),
	);
	expect(control.getAttribute("aria-checked")).toBe("false");
});

it("retries the same requested value after a failed save", async () => {
	state.portal
		.mockRejectedValueOnce(new Error("disk full"))
		.mockResolvedValue({ phase: "idle" });
	vi.spyOn(console, "error").mockImplementation(() => {});
	const view = render(PortalSetting);
	await fireEvent.click(view.getByRole("switch"));
	await waitFor(() =>
		expect(view.getByRole("status").textContent).toContain(
			"could not be saved",
		),
	);
	await fireEvent.click(view.getByRole("button", { name: "Try again" }));
	await waitFor(() =>
		expect(view.getByRole("switch").getAttribute("aria-checked")).toBe("true"),
	);
	expect(state.portal.mock.calls).toEqual([
		[{ action: "configure", enabled: true }],
		[{ action: "configure", enabled: true }],
	]);
	expect(view.queryByRole("status")).toBeNull();
});
