// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getHeat: vi.fn(),
	keepHeatQuality: vi.fn(),
}));
vi.mock("$lib/rpc/client", () => ({ rpc: { streaming: mocks } }));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getStatus: () => ({ heat: mocks.getHeat() }),
}));

import HeatNotice from "./HeatNotice.svelte";

const status = {
	stage: 2,
	unknown: false,
	keepQuality: false,
	ceiling: 4500,
	error: false,
	history: [],
	phoneAdvice: true,
	reduced: true,
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.getHeat.mockReturnValue(status);
});
test("names the real ceiling and keeps warning after override", async () => {
	mocks.keepHeatQuality.mockResolvedValue({
		success: true,
		applied: { ...status, keepQuality: true, ceiling: 6000 },
	});
	const view = render(HeatNotice);
	await waitFor(() => expect(view.getByText(/4.5 Mbit\/s/)).toBeTruthy());
	await fireEvent.click(view.getByRole("button", { name: "Keep quality" }));

	expect(mocks.keepHeatQuality).toHaveBeenCalledWith({ enabled: true });
});
test("unknown temperature says adjustments are paused", async () => {
	mocks.getHeat.mockReturnValue({ ...status, unknown: true });
	const view = render(HeatNotice);
	await waitFor(() =>
		expect(view.getByText(/Temperature unavailable/)).toBeTruthy(),
	);
	expect(view.queryByText(/bitrate capped/)).toBeNull();
});

test("override keeps warning visible", () => {
	mocks.getHeat.mockReturnValue({
		...status,
		keepQuality: true,
		reduced: false,
		ceiling: 6000,
	});
	const view = render(HeatNotice);
	expect(view.getByText(/Keeping full quality/)).toBeTruthy();
});

test("an operator ceiling below the floor is never described as reduced", () => {
	mocks.getHeat.mockReturnValue({ ...status, ceiling: 1000, reduced: false });
	const view = render(HeatNotice);
	expect(view.queryByText(/bitrate capped/)).toBeNull();
	expect(view.getByText("Hot")).toBeTruthy();
});

test("a pending override does not claim full quality before restoration", () => {
	mocks.getHeat.mockReturnValue({
		...status,
		keepQuality: true,
		reduced: true,
	});
	const view = render(HeatNotice);
	expect(view.queryByText(/Keeping full quality/)).toBeNull();
	expect(view.getByText(/4.5 Mbit/)).toBeTruthy();
});
