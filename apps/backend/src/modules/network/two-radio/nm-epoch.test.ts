import { expect, test } from "bun:test";
import { captureNmEpoch } from "./nm-epoch.ts";

test("NM and bus incarnations are bracketed and disposed on every result", async () => {
	let owner = ":1.7",
		bus = "a".repeat(32),
		disconnects = 0,
		calls = 0,
		change = false;
	const transport = {
		connect: async () => {},
		disconnect: async () => {
			disconnects++;
		},
		callMethod: async ({ member }: { member: string }) => {
			calls++;
			return {
				signature: "s",
				body: [
					member === "GetNameOwner"
						? owner
						: change && calls % 3 === 0
							? "b".repeat(32)
							: bus,
				],
			};
		},
	};
	const first = await captureNmEpoch(transport, AbortSignal.timeout(1000));
	owner = ":1.8";
	expect(await captureNmEpoch(transport, AbortSignal.timeout(1000))).not.toBe(
		first,
	);
	bus = "c".repeat(32);
	expect(await captureNmEpoch(transport, AbortSignal.timeout(1000))).not.toBe(
		first,
	);
	change = true;
	await expect(
		captureNmEpoch(transport, AbortSignal.timeout(1000)),
	).rejects.toThrow("NM epoch changed");
	expect(disconnects).toBeGreaterThanOrEqual(4);
	const aborted = new AbortController();
	aborted.abort();
	await expect(captureNmEpoch(transport, aborted.signal)).rejects.toThrow();
});
