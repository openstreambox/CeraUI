// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { expect, it, vi } from "vitest";
import SharingPolicyControl from "./SharingPolicyControl.svelte";

const initial = {
	mode: "automatic",
	priorities: { wired: 0, cellular: 10, wifi: 20 },
	administrativelyDown: [],
};
const { get, set } = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { getSharingPolicy: get, setSharingPolicy: set } },
}));
it("loads runtime policy, submits forced mode and AP-only administrative down", async () => {
	get.mockResolvedValue(structuredClone(initial));
	set.mockImplementation(async (value) => value);
	const view = render(SharingPolicyControl, { interfaces: ["eth0", "wwan0"] });
	await waitFor(() =>
		expect(view.container.querySelector("select")).not.toBeNull(),
	);
	const picker = view.container.querySelector("select");
	const form = view.container.querySelector("form");
	if (!picker || !form) throw new Error("missing policy controls");
	await fireEvent.change(picker, { target: { value: "cellular-only" } });
	await fireEvent.click(view.getByLabelText("eth0"));
	await fireEvent.submit(form);
	await waitFor(() =>
		expect(set).toHaveBeenCalledWith({
			...initial,
			mode: "cellular-only",
			administrativelyDown: ["eth0"],
		}),
	);
});
it("reports a failed read without inventing automatic state", async () => {
	get.mockRejectedValue(new Error("offline"));
	const view = render(SharingPolicyControl);
	await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
	expect(view.container.querySelector("form")).toBeNull();
});
