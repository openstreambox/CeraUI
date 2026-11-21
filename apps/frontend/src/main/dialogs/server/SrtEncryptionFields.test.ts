import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import SrtEncryptionFields from "./SrtEncryptionFields.svelte";

describe("SRT encryption fields", () => {
	it("offers nothing without supported producer evidence", () => {
		const { container } = render(SrtEncryptionFields, { onChange: vi.fn() });
		expect(container.querySelector("input")).toBeNull();
	});
	it("hides secrets by default, toggles visibility and validates byte length", async () => {
		const onChange = vi.fn();
		const { container } = render(SrtEncryptionFields, {
			supported: true,
			onChange,
		});
		const field = container.querySelector(
			"#srt-output-passphrase",
		) as HTMLInputElement;
		expect(field.type).toBe("password");
		await fireEvent.click(
			container.querySelector("[type=checkbox]") as HTMLInputElement,
		);
		expect(field.type).toBe("text");
		await fireEvent.input(field, { target: { value: "short" } });
		expect(field.getAttribute("aria-invalid")).toBe("true");
		await fireEvent.input(field, { target: { value: "dummy-secret" } });
		expect(field.getAttribute("aria-invalid")).toBe("false");
		expect(onChange).toHaveBeenLastCalledWith("dummy-secret", 16);
	});
});
