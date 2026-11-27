// @vitest-environment jsdom

import type { RadioHealth } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { expect, test } from "vitest";
import RadioHealthPanel from "./RadioHealthPanel.svelte";

const field = {
	value: null,
	source: "ModemManager",
	unit: "dB",
	technology: "unknown",
	capturedAt: 1000,
};
test("unavailable readings and words remain visible without modem action controls", () => {
	const radio: RadioHealth = {
		capturedAt: 1000,
		registration: field,
		layer: field,
		band: field,
		metrics: { sinr: field },
		neighbours: [],
		usb: { available: false, events: [] },
		finding: { kind: "unknown", confidence: "unknown", evidence: [] },
		timeline: [],
	};
	const { container, getByTestId } = render(RadioHealthPanel, {
		radio,
		id: "1",
		network: "Example",
	});
	expect(getByTestId("radio-health").textContent).toContain("Unavailable");
	expect(container.textContent).toContain("Unknown");
	expect(container.querySelectorAll("button,input,select").length).toBe(0);
	expect(container.textContent).not.toContain("Weak signal");
});
