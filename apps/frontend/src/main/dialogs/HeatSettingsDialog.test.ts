// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getLinkBoxHeat: vi.fn(),
	setLinkBoxHeatMode: vi.fn(),
}));
vi.mock("$lib/rpc/client", () => ({ rpc: { streaming: mocks } }));

import HeatSettingsDialog from "./HeatSettingsDialog.svelte";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getLinkBoxHeat.mockResolvedValue({ mode: "auto", active: false });
});
test("automatic is the default and a single selection saves suggest only", async () => {
	mocks.setLinkBoxHeatMode.mockResolvedValue({
		success: true,
		mode: "suggest",
	});
	const view = render(HeatSettingsDialog, { open: true });
	const toggle = await view.findByRole("checkbox", { name: "Suggest only" });
	await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
	expect((toggle as HTMLInputElement).checked).toBe(false);
	await fireEvent.click(toggle);
	await waitFor(() =>
		expect(mocks.setLinkBoxHeatMode).toHaveBeenCalledWith({ mode: "suggest" }),
	);
	await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));
	expect(view.getByText(/isn.t active on this box/i)).toBeTruthy();
});
test("a failed save preserves the confirmed mode and reports failure", async () => {
	mocks.getLinkBoxHeat.mockResolvedValue({ mode: "suggest", active: false });
	mocks.setLinkBoxHeatMode.mockRejectedValue(new Error("unavailable"));
	const view = render(HeatSettingsDialog, { open: true });
	const toggle = await view.findByRole("checkbox", { name: "Suggest only" });
	await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));
	await fireEvent.click(toggle);
	await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
	expect((toggle as HTMLInputElement).checked).toBe(true);
});
