// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getHeat: vi.fn(),
	keepHeatQuality: vi.fn(),
	linkBoxHeatAction: vi.fn(),
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
	cannotReduce: false,
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

test("a source whose bitrate cannot be lowered is not described as capped", () => {
	mocks.getHeat.mockReturnValue({
		...status,
		ceiling: 8000,
		reduced: false,
		cannotReduce: true,
	});
	const view = render(HeatNotice);
	expect(view.queryByText(/bitrate capped/)).toBeNull();
	expect(view.getByText(/can't be lowered/)).toBeTruthy();
	expect(view.getByText(/Still live/)).toBeTruthy();
});

test("shows reduced protection, datasheet values and the resting link", () => {
	mocks.getHeat.mockReturnValue({
		...status,
		protectionReduced: true,
		packDatasheet: true,
		restingLink: "wwan0",
	});
	const view = render(HeatNotice);
	expect(view.getByText("Power board protection is reduced.")).toBeTruthy();
	expect(
		view.getByText("Reserve pack temperature uses datasheet values."),
	).toBeTruthy();
	expect(view.getByText("wwan0 is resting to reduce heat.")).toBeTruthy();
});

test("unknown capacity keeps links in the bond", () => {
	mocks.getHeat.mockReturnValue({ ...status, restUnavailable: true });
	const view = render(HeatNotice);
	expect(view.getByText(/Link capacity is unknown/)).toBeTruthy();
});

test("says plainly when modem temperature cannot be read on this box", () => {
	mocks.getHeat.mockReturnValue({ ...status, modemUnavailable: true });
	const view = render(HeatNotice);
	expect(
		view.getByText(/Modem temperature isn't available on this box/),
	).toBeTruthy();
});

test("names link capacity only when the backend says it is the reason", () => {
	mocks.getHeat.mockReturnValue({ ...status, restUnavailable: false });
	const view = render(HeatNotice);
	expect(view.queryByText(/Link capacity is unknown/)).toBeNull();
});

test("supply proof warning is visible at stage zero without claiming stream loss", () => {
	mocks.getHeat.mockReturnValue({
		...status,
		stage: 0,
		reduced: false,
		supplyUnproven: true,
	});
	const view = render(HeatNotice);
	expect(
		view.getByText(
			"The power board's heat cut-off is paused because it can't confirm the power supply.",
		),
	).toBeTruthy();
	expect(view.queryByText(/offline|stream stopped|stream down/i)).toBeNull();
});

test("a sudden pack reading reports a delayed cut-off", () => {
	mocks.getHeat.mockReturnValue({
		...status,
		stage: 0,
		reduced: false,
		packJump: true,
	});
	const view = render(HeatNotice);
	expect(
		view.getByText(
			"The reserve pack temperature jumped suddenly. The heat cut-off waits up to a minute to confirm it.",
		),
	).toBeTruthy();
	expect(view.queryByText(/can't confirm the power supply/)).toBeNull();
});

test("a suggestion offers one tap and a confirmed pause offers Let back on", async () => {
	mocks.linkBoxHeatAction.mockResolvedValue({ success: true });
	mocks.getHeat.mockReturnValue({
		...status,
		linkBox: { suggestion: "guest", paused: null },
	});
	const view = render(HeatNotice);
	await fireEvent.click(view.getByRole("button", { name: "Pause one device" }));
	expect(mocks.linkBoxHeatAction).toHaveBeenCalledWith({
		action: "pause",
		id: "guest",
	});
	view.unmount();
	mocks.getHeat.mockReturnValue({
		...status,
		linkBox: { suggestion: null, paused: "guest" },
	});
	const paused = render(HeatNotice);
	await fireEvent.click(paused.getByRole("button", { name: "Let back on" }));
	expect(mocks.linkBoxHeatAction).toHaveBeenCalledWith({
		action: "restore",
		id: "guest",
	});
});
test("a refused pause stays visible as a failure, never as a confirmed action", async () => {
	mocks.linkBoxHeatAction.mockResolvedValue({ success: false });
	mocks.getHeat.mockReturnValue({
		...status,
		linkBox: { suggestion: "guest", paused: null },
	});
	const view = render(HeatNotice);
	await fireEvent.click(view.getByRole("button", { name: "Pause one device" }));
	await waitFor(() =>
		expect(view.getByText(/could not be confirmed/i)).toBeTruthy(),
	);
	expect(view.queryByRole("button", { name: "Let back on" })).toBeNull();
});
