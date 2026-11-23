import { expect, test } from "bun:test";
import { resolveUplinkHealthTarget } from "../modules/network/uplink-health/runtime.ts";

test("under mocks uplink health resolves no public check target", async () => {
	let resolved = 0;
	const resolve = async () => {
		resolved++;
		return "192.0.2.10";
	};
	expect(await resolveUplinkHealthTarget(resolve, () => true)).toBeUndefined();
	expect(resolved).toBe(0);
	expect(await resolveUplinkHealthTarget(resolve, () => false)).toBe(
		"192.0.2.10",
	);
	expect(resolved).toBe(1);
});
