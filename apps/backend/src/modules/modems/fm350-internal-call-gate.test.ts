import { expect, test } from "bun:test";
import { runtimeConfigSchema } from "../../helpers/config-schemas.ts";
import { fm350InternalCallEnabled } from "./fm350-internal-call-gate.ts";

const identity = {
	model: "FM350-GL",
	firmware: "81600.0000.00.29.18.01",
	mode: "rndis",
} as const;
test("FM350 29.18.01 keeps ModemManager unless its own physical key is explicitly enabled", () => {
	for (const switches of [{}, { a: false }, { b: true }])
		expect(fm350InternalCallEnabled("a", identity, switches)).toBe(false);
	expect(fm350InternalCallEnabled("a", identity, { a: true })).toBe(true);
	expect(fm350InternalCallEnabled(undefined, identity, { a: true })).toBe(
		false,
	);
	expect(
		fm350InternalCallEnabled(
			"a",
			{ ...identity, firmware: "unknown" },
			{ a: true },
		),
	).toBe(false);
	expect(
		fm350InternalCallEnabled("a", { ...identity, mode: "mbim" }, { a: true }),
	).toBe(false);
	expect(fm350InternalCallEnabled("toString", identity, {})).toBe(false);
});
test("the device-local switch is absent by default and validates boolean values", () => {
	expect(runtimeConfigSchema.parse({}).fm350_internal_calls).toBeUndefined();
	expect(
		runtimeConfigSchema.parse({ fm350_internal_calls: { a: true } })
			.fm350_internal_calls,
	).toEqual({ a: true });
	expect(
		runtimeConfigSchema.safeParse({ fm350_internal_calls: { a: "true" } })
			.success,
	).toBe(false);
});
