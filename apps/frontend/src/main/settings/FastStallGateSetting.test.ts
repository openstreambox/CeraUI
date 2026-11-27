// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { destroyAsyncOperations } from "$lib/rpc/async-operation.svelte";
import FastStallGateSetting from "./FastStallGateSetting.svelte";

const state = vi.hoisted(() => ({
	enabled: undefined as boolean | undefined,
	set: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("$lib/rpc/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/rpc/client")>()),
	rpc: { system: { setFastStallGate: state.set } },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => ({ srtla_fast_stall_gate: state.enabled }),
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: state.toastError, success: vi.fn() },
}));

const NAME = "Quick switch off a stalled link (experimental)";

beforeEach(() => {
	state.enabled = undefined;
	state.set.mockReset();
	state.toastError.mockClear();
});
afterEach(() => {
	destroyAsyncOperations();
});

it("is off on a box that never set it, and saves an explicit opt-in and opt-out", async () => {
	state.set.mockImplementation(async ({ enabled }: { enabled: boolean }) => ({
		success: true,
		applied: { enabled },
	}));
	const view = render(FastStallGateSetting);
	const control = view.getByRole("switch", { name: NAME });
	expect(control.getAttribute("aria-checked")).toBe("false");
	expect(view.getByText(/Applies from the next stream start/)).toBeTruthy();

	await fireEvent.click(control);
	await waitFor(() =>
		expect(control.getAttribute("aria-checked")).toBe("true"),
	);
	expect(state.set).toHaveBeenCalledWith({ enabled: true });

	await fireEvent.click(control);
	await waitFor(() =>
		expect(control.getAttribute("aria-checked")).toBe("false"),
	);
	expect(state.set).toHaveBeenLastCalledWith({ enabled: false });
});

it("follows the box config when it is already on", () => {
	state.enabled = true;
	const view = render(FastStallGateSetting);
	expect(
		view.getByRole("switch", { name: NAME }).getAttribute("aria-checked"),
	).toBe("true");
});

it("stays off and reports a failed save", async () => {
	state.set.mockRejectedValue(new Error("disk full"));
	vi.spyOn(console, "error").mockImplementation(() => {});
	const view = render(FastStallGateSetting);
	const control = view.getByRole("switch", { name: NAME });
	await fireEvent.click(control);
	await waitFor(() => expect(state.toastError).toHaveBeenCalled());
	await waitFor(() =>
		expect(control.getAttribute("aria-checked")).toBe("false"),
	);
});
