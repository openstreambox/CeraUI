// @vitest-environment jsdom

import { m } from "@ceraui/i18n/svelte";
import { updateSettingsSchema } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { expect, it, vi } from "vitest";
import type { PackagesAutomationMode } from "$lib/updates/update-surface.svelte";
import AutomationSection from "./AutomationSection.svelte";

function renderSection(
	packagesMode: PackagesAutomationMode | undefined,
	packagesAuto = true,
) {
	const onSave = vi.fn(async () => true);
	render(AutomationSection, {
		settings: updateSettingsSchema.parse({ packagesAuto }),
		system: false,
		saving: false,
		onSave,
		...(packagesMode === undefined ? {} : { packagesMode }),
	});
	return { onSave, toggle: screen.getByTestId("update-auto-packages") };
}

const LABEL = {
	install: () => m["settings.updates.automation.packages"](),
	check: () => m["settings.updates.automation.packagesCheck"](),
	unknown: () => m["settings.updates.automation.packagesNeutral"](),
} as const;

it.each([
	{ packagesMode: undefined, label: "install", hint: false },
	{ packagesMode: "install", label: "install", hint: false },
	{ packagesMode: "unknown", label: "unknown", hint: false },
	{ packagesMode: "check", label: "check", hint: true },
] as const)(
	"names the package switch for mode $packagesMode",
	({ packagesMode, label, hint }) => {
		const { toggle } = renderSection(packagesMode);
		// Then exactly one name shows, and only check adds the hint.
		expect(toggle.getAttribute("aria-label")).toBe(LABEL[label]());
		expect(screen.getByText(LABEL[label]())).toBeTruthy();
		for (const other of Object.keys(LABEL) as (keyof typeof LABEL)[])
			if (other !== label)
				expect(screen.queryByText(LABEL[other]())).toBeNull();
		const note = screen.queryByTestId("update-auto-packages-manual");
		if (hint) {
			expect(note?.textContent?.trim()).toBe(
				m["settings.updates.automation.packagesManualHint"](),
			);
			expect(toggle.getAttribute("aria-describedby")).toBe(note?.id);
		} else {
			expect(note).toBeNull();
			expect(toggle.hasAttribute("aria-describedby")).toBe(false);
		}
	},
);

it.each(
	(["install", "check", "unknown"] as const).flatMap((packagesMode) =>
		[true, false].map((packagesAuto) => ({ packagesMode, packagesAuto })),
	),
)(
	"in mode $packagesMode the switch shows and saves packagesAuto (saved $packagesAuto)",
	async ({ packagesMode, packagesAuto }) => {
		// Given any mode: the switch is the same stored setting on every image.
		const { onSave, toggle } = renderSection(packagesMode, packagesAuto);
		expect(toggle.hasAttribute("disabled")).toBe(false);
		expect(toggle.getAttribute("aria-checked")).toBe(String(packagesAuto));
		// When the operator flips it, then exactly that setting is saved.
		await fireEvent.click(toggle);
		expect(onSave).toHaveBeenCalledExactlyOnceWith({
			packagesAuto: !packagesAuto,
		});
	},
);
