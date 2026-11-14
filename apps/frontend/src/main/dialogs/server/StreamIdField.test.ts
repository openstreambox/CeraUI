// @vitest-environment jsdom
import { m } from "@ceraui/i18n/svelte";
import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import StreamIdField from "./StreamIdField.svelte";

describe("write-only Stream ID field", () => {
	it("masks typed text, reveals only that text, and clears explicitly", async () => {
		const onChange = vi.fn();
		const { container, getByText } = render(StreamIdField, {
			props: {
				id: "test-streamid",
				value: "dummy-typed-key",
				configured: true,
				onChange,
			},
		});
		const input = container.querySelector("input");
		if (!input) throw new Error("Stream ID input missing");
		expect(input.type).toBe("password");
		expect(input.autocomplete).toBe("new-password");
		expect(getByText(m["settings.streamIdStored"]())).toBeTruthy();
		await fireEvent.click(getByText(m["settings.streamIdShow"]()));
		expect(input.type).toBe("text");
		expect(input.value).toBe("dummy-typed-key");
		await fireEvent.click(getByText(m["settings.streamIdHide"]()));
		expect(input.type).toBe("password");
		await fireEvent.click(getByText(m["settings.streamIdClear"]()));
		expect(onChange).toHaveBeenCalledWith("");
	});
	it("never fills an existing saved key into the DOM", () => {
		const { container } = render(StreamIdField, {
			props: {
				id: "test-streamid",
				value: "",
				configured: true,
				onChange: vi.fn(),
			},
		});
		expect(container.querySelector("input")?.value).toBe("");
	});
});
