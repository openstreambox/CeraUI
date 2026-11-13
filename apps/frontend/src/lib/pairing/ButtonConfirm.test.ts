// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, expect, test, vi } from "vitest";
import ButtonConfirm from "./ButtonConfirm.svelte";

const call = vi.hoisted(() => vi.fn());
vi.mock("$lib/rpc/client", () => ({ rpc: { auth: { button: call } } }));
vi.mock("$lib/stores/auth-status.svelte", () => ({ setAuthStatus: vi.fn() }));
beforeEach(() => call.mockReset());
test("the double-press instruction appears only after READY, then Cancel releases it", async () => {
	let ready!: (r: { state: "waiting"; id: string }) => void;
	call
		.mockImplementationOnce(
			() =>
				new Promise((r) => {
					ready = r;
				}),
		)
		.mockResolvedValue({ state: "cancelled" });
	const view = render(ButtonConfirm);
	await fireEvent.click(screen.getByRole("button"));
	expect(screen.queryByText(/double-press/i)).toBeNull();
	ready({ state: "waiting", id: "request" });
	await waitFor(() => expect(screen.getByText(/double-press/i)).toBeTruthy());
	expect(screen.getByText("You have 1 minute.")).toBeTruthy();
	await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
	expect(call).toHaveBeenCalledWith({ action: "cancel" });
	expect(screen.queryByText(/double-press/i)).toBeNull();
	view.unmount();
});
test("old images use fallback copy without a power-button instruction", async () => {
	call.mockResolvedValue({ state: "unavailable" });
	const view = render(ButtonConfirm);
	await fireEvent.click(screen.getByRole("button"));
	await waitFor(() =>
		expect(screen.getByText(/Use your password to sign in/)).toBeTruthy(),
	);
	expect(screen.queryByText(/double-press/i)).toBeNull();
	view.unmount();
});

test("leaving an active prompt cancels its held request", async () => {
	call.mockResolvedValue({ state: "waiting", id: "request" });
	const view = render(ButtonConfirm);
	await fireEvent.click(screen.getByRole("button"));
	await waitFor(() => expect(screen.getByText(/double-press/i)).toBeTruthy());
	view.unmount();
	expect(call).toHaveBeenLastCalledWith({ action: "cancel" });
});

test("disconnect explains consequences without prompting for a gesture before READY", async () => {
	call.mockResolvedValue({ state: "unavailable" });
	const view = render(ButtonConfirm, { purpose: "disconnect" });
	expect(screen.queryByText(/double.press/i)).toBeNull();
	await fireEvent.click(screen.getByRole("button"));
	await waitFor(() =>
		expect(screen.getByText("Use your password to sign in.")).toBeTruthy(),
	);
	expect(screen.queryByText(/double.press/i)).toBeNull();
	view.unmount();
});

test("disconnect reports that credentials may survive a persistence failure", async () => {
	call.mockResolvedValue({ state: "persistence-failed" });
	const view = render(ButtonConfirm, { purpose: "disconnect" });
	await fireEvent.click(screen.getByRole("button"));
	await waitFor(() =>
		expect(
			screen.getByText(/saved credentials could not be revoked/),
		).toBeTruthy(),
	);
	expect(screen.queryByText(/double.press/i)).toBeNull();
	view.unmount();
});
