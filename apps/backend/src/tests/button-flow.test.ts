import { expect, test } from "bun:test";
import { ButtonFlow } from "../modules/system/button-flow.ts";
import type { ButtonResult } from "../modules/system/power-button-client.ts";

test("confirmation is transport-bound and consumed once", async () => {
	let finish!: (s: ButtonResult) => void;
	const flow = new ButtonFlow({
		confirm: async () => ({
			result: new Promise<ButtonResult>((r) => {
				finish = r;
			}),
			cancel() {},
		}),
	});
	const owner = {};
	const id = await flow.begin(owner, "disconnect");
	if (!id) throw new Error("Request was not admitted");
	expect(flow.poll({}, id)).toBeNull();
	expect(flow.poll(owner, "stale")).toBeNull();
	finish("confirmed");
	await Promise.resolve();
	expect(flow.poll(owner, id)).toEqual({
		state: "confirmed",
		purpose: "disconnect",
	});
	expect(flow.poll(owner, id)).toBeNull();
});
test("UI disappearance cancels request", async () => {
	let cancelled = 0;
	const flow = new ButtonFlow(
		{
			confirm: async () => ({
				result: new Promise<ButtonResult>(() => {}),
				cancel() {
					cancelled++;
				},
			}),
		},
		10,
	);
	await flow.begin({}, "connect");
	await new Promise((r) => setTimeout(r, 30));
	expect(cancelled).toBe(1);
});
test("cancellation during handshake cannot leave a late request active", async () => {
	let admit!: (r: { result: Promise<ButtonResult>; cancel(): void }) => void;
	let cancelled = 0;
	const flow = new ButtonFlow({
		confirm: () =>
			new Promise((r) => {
				admit = r;
			}),
	});
	const owner = {};
	const pending = flow.begin(owner, "connect");
	flow.cancel(owner);
	admit({
		result: Promise.resolve("confirmed"),
		cancel() {
			cancelled++;
		},
	});
	expect(await pending).toBeNull();
	expect(cancelled).toBe(1);
});
