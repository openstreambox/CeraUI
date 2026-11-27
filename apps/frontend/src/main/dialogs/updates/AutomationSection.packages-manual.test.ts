// @vitest-environment jsdom

import { m } from "@ceraui/i18n/svelte";
import { updateSettingsSchema } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { expect, it, vi } from "vitest";
import AutomationSection from "./AutomationSection.svelte";

function renderSection(packagesManual: boolean | undefined) {
	const onSave = vi.fn(async () => true);
	render(AutomationSection, {
		settings: updateSettingsSchema.parse({ packagesAuto: true }),
		system: false,
		saving: false,
		onSave,
		...(packagesManual === undefined ? {} : { packagesManual }),
	});
	return { onSave, toggle: screen.getByTestId("update-auto-packages") };
}

it.each([undefined, false])(
	"keeps the automatic package switch live when manual installs are %s",
	async (packagesManual) => {
		// Given a device that installs packages automatically when asked to.
		const { onSave, toggle } = renderSection(packagesManual);
		// Then the switch shows the saved setting, enabled, with no hint.
		expect(toggle.hasAttribute("disabled")).toBe(false);
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		expect(toggle.hasAttribute("aria-describedby")).toBe(false);
		expect(screen.queryByTestId("update-auto-packages-manual")).toBeNull();
		// When the operator turns it off, then the device is asked to save that.
		await fireEvent.click(toggle);
		expect(onSave).toHaveBeenCalledExactlyOnceWith({ packagesAuto: false });
	},
);

it("shows the automatic package switch off and disabled, with a hint, when installs are manual-only", async () => {
	// Given a device that never installs packages on its own, whose stored
	// setting still says automatic.
	const { onSave, toggle } = renderSection(true);
	// Then the label stays, the switch is disabled and off, and the hint says why.
	expect(toggle.getAttribute("aria-label")).toBe(
		m["settings.updates.automation.packages"](),
	);
	expect(
		screen.getByText(m["settings.updates.automation.packages"]()),
	).toBeTruthy();
	expect(toggle.hasAttribute("disabled")).toBe(true);
	expect(toggle.getAttribute("aria-checked")).toBe("false");
	const hint = screen.getByTestId("update-auto-packages-manual");
	expect(hint.textContent?.trim()).toBe(
		m["settings.updates.automation.packagesManualHint"](),
	);
	expect(toggle.getAttribute("aria-describedby")).toBe(hint.id);
	// When the operator clicks it anyway, then nothing is saved.
	await fireEvent.click(toggle);
	expect(onSave).not.toHaveBeenCalled();
});
