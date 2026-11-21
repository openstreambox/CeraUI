import { describe, expect, test } from "bun:test";
import {
	classifyEngineSchemaSkew,
	skewMayHideCapabilities,
} from "../modules/streaming/engine-schema-skew.ts";

describe("classifyEngineSchemaSkew", () => {
	test("equal versions match", () => {
		expect(classifyEngineSchemaSkew("0.24.0", "0.24.0")).toBe("match");
	});

	test("a lower minor or patch within the same major is older", () => {
		expect(classifyEngineSchemaSkew("0.21.0", "0.24.0")).toBe("older");
		expect(classifyEngineSchemaSkew("0.24.0", "0.24.1")).toBe("older");
		// numeric, not lexical: 0.9 is older than 0.10
		expect(classifyEngineSchemaSkew("0.9.0", "0.10.0")).toBe("older");
	});

	test("a higher minor or patch within the same major is newer", () => {
		expect(classifyEngineSchemaSkew("0.25.0", "0.24.0")).toBe("newer");
		expect(classifyEngineSchemaSkew("0.24.2", "0.24.0")).toBe("newer");
	});

	test("a different major or an unparsable version is unknown", () => {
		expect(classifyEngineSchemaSkew("1.0.0", "0.24.0")).toBe("unknown");
		expect(classifyEngineSchemaSkew("0.0.1-older", "0.24.0")).toBe("unknown");
		expect(classifyEngineSchemaSkew("", "0.24.0")).toBe("unknown");
	});

	test("only a newer or unknown skew may hide engine capabilities", () => {
		expect(skewMayHideCapabilities("match")).toBe(false);
		expect(skewMayHideCapabilities("older")).toBe(false);
		expect(skewMayHideCapabilities("newer")).toBe(true);
		expect(skewMayHideCapabilities("unknown")).toBe(true);
	});
});
