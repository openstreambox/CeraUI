// @vitest-environment jsdom

import { m } from "@ceraui/i18n/svelte";
import { updateSettingsSchema } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { expect, it, vi } from "vitest";
import AutomationSection from "./AutomationSection.svelte";

function renderSection(
	packagesManual: boolean | undefined,
	packagesAuto = true,
) {
	const onSave = vi.fn(async () => true);
	render(AutomationSection, {
		settings: updateSettingsSchema.parse({ packagesAuto }),
		system: false,
		saving: false,
		onSave,
		...(packagesManual === undefined ? {} : { packagesManual }),
	});
	return { onSave, toggle: screen.getByTestId("update-auto-packages") };
}

it.each([undefined, false])(
	"keeps the package switch's wording when manual installs are %s",
	async (packagesManual) => {
		// Given a device that installs packages automatically when asked to.
		const { onSave, toggle } = renderSection(packagesManual);
		// Then the switch keeps its label, shows the saved setting and has no hint.
		expect(toggle.getAttribute("aria-label")).toBe(
			m["settings.updates.automation.packages"](),
		);
		expect(toggle.hasAttribute("disabled")).toBe(false);
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		expect(toggle.hasAttribute("aria-describedby")).toBe(false);
		expect(screen.queryByTestId("update-auto-packages-manual")).toBeNull();
		// When the operator turns it off, then the device is asked to save that.
		await fireEvent.click(toggle);
		expect(onSave).toHaveBeenCalledExactlyOnceWith({ packagesAuto: false });
	},
);

it.each([true, false])(
	"names the switch for the scheduled check, with a hint, when installs are manual-only (saved %s)",
	async (packagesAuto) => {
		// Given a device that installs packages only by hand, where the same
		// setting still drives the scheduled package check.
		const { onSave, toggle } = renderSection(true, packagesAuto);
		const label = m["settings.updates.automation.packagesCheck"]();
		// Then the switch is named for what it does there, shows the saved
		// value, stays editable and is described by the hint.
		expect(toggle.getAttribute("aria-label")).toBe(label);
		expect(screen.getByText(label)).toBeTruthy();
		expect(
			screen.queryByText(m["settings.updates.automation.packages"]()),
		).toBeNull();
		expect(toggle.hasAttribute("disabled")).toBe(false);
		expect(toggle.getAttribute("aria-checked")).toBe(String(packagesAuto));
		const hint = screen.getByTestId("update-auto-packages-manual");
		expect(hint.textContent?.trim()).toBe(
			m["settings.updates.automation.packagesManualHint"](),
		);
		expect(toggle.getAttribute("aria-describedby")).toBe(hint.id);
		// When the operator flips it, then exactly that setting is saved.
		await fireEvent.click(toggle);
		expect(onSave).toHaveBeenCalledExactlyOnceWith({
			packagesAuto: !packagesAuto,
		});
	},
);
