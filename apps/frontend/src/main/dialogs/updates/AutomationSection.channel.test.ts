// @vitest-environment jsdom

import { updateSettingsSchema } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { expect, it, vi } from "vitest";
import AutomationSection from "./AutomationSection.svelte";

it("saves an explicit channel address without applying the draft locally", async () => {
	const onSave = vi.fn(async () => true);
	render(AutomationSection, {
		settings: updateSettingsSchema.parse({}),
		system: true,
		saving: false,
		onSave,
	});
	const input = screen.getByTestId("update-channel-url");
	expect((input as HTMLInputElement).value).toBe("https://images.ceralive.tv");
	await fireEvent.input(input, {
		target: { value: "https://updates.example.invalid/bench" },
	});
	await fireEvent.click(screen.getByTestId("update-channel-url-save"));
	expect(onSave).toHaveBeenCalledWith({
		channelUrl: "https://updates.example.invalid/bench",
	});
});
