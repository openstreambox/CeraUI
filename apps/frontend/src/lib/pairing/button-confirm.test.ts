import { expect, test, vi } from "vitest";
import { ButtonConfirm } from "./button-confirm";

test("missing image capability returns to the existing path", async () => {
	const changed = vi.fn();
	const flow = new ButtonConfirm(
		async () => ({ state: "unavailable" }),
		changed,
		vi.fn(),
	);
	await flow.begin("connect");
	expect(changed).toHaveBeenLastCalledWith({ state: "unavailable" });
});
test("closing during admission cancels a late READY without showing a prompt", async () => {
	let admit!: (r: { state: "waiting"; id: string }) => void;
	const call = vi
		.fn()
		.mockImplementationOnce(
			() =>
				new Promise((r) => {
					admit = r;
				}),
		)
		.mockResolvedValue({ state: "cancelled" });
	const changed = vi.fn();
	const flow = new ButtonConfirm(call, changed, vi.fn());
	const pending = flow.begin("connect");
	flow.cancel();
	admit({ state: "waiting", id: "late" });
	await pending;
	expect(changed).not.toHaveBeenCalledWith(
		expect.objectContaining({ state: "waiting" }),
	);
	expect(call).toHaveBeenCalledWith({ action: "cancel" });
});
