import { expect } from "bun:test";
export function expectNoSourceStrings(remote: unknown, source: unknown): void {
	const bytes = typeof remote === "string" ? remote : JSON.stringify(remote);
	function visit(v: unknown) {
		if (
			typeof v === "string" &&
			v.length > 3 &&
			![
				"connected",
				"disconnected",
				"connecting",
				"disconnecting",
				"station",
				"hotspot",
				"auto",
				"auto_24",
				"auto_50",
				"custom",
				"standard",
				"bandwidth-saver",
				"unknown",
			].includes(v)
		)
			expect(bytes).not.toContain(v);
		else if (v && typeof v === "object")
			for (const value of Object.values(v)) visit(value);
	}
	visit(source);
}
