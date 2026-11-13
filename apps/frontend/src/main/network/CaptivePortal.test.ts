// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, expect, it, vi } from "vitest";
import CaptivePortal from "./CaptivePortal.svelte";

const { portal } = vi.hoisted(() => ({ portal: vi.fn() }));
vi.mock("$lib/rpc/client", () => ({ rpc: { wifi: { portal } } }));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getWifi: () => ({ "2": { conn: "saved", hw: "Wi-Fi 2" } }),
}));
beforeEach(() => {
	portal.mockReset();
	portal.mockResolvedValue({ phase: "idle" });
});
it("opens only the selected radio and lets the phone cancel", async () => {
	const close = vi.fn();
	const popup = { opener: {}, location: { href: "about:blank" }, close };
	vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
	const view = render(CaptivePortal);
	await waitFor(() =>
		expect(portal).toHaveBeenCalledWith({ action: "status" }),
	);
	await fireEvent.change(view.getByRole("combobox"), {
		target: { value: "2" },
	});
	portal.mockResolvedValue({ phase: "signing_in" });
	await fireEvent.click(
		view.getByRole("button", { name: "Open the hotel's page" }),
	);
	await waitFor(() =>
		expect(portal).toHaveBeenCalledWith({ action: "start", radio: 2 }),
	);
	expect(popup.location.href).toBe("http://www.gstatic.com/generate_204");
	expect(popup.opener).toBeNull();
	portal.mockResolvedValue({ phase: "needs_sign_in" });
	await fireEvent.click(view.getByRole("button", { name: "Cancel sign-in" }));
	await waitFor(() =>
		expect(portal).toHaveBeenCalledWith({ action: "finish" }),
	);
});
