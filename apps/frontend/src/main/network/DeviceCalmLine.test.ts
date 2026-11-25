// @vitest-environment jsdom
import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import DeviceCalmLine from "./DeviceCalmLine.svelte";

describe("device calm line", () => {
	it("says nothing when nothing was turned off or rested on purpose", () => {
		const view = render(DeviceCalmLine, {
			props: { calm: undefined, onOpen: () => undefined },
		});
		expect(view.queryByTestId("device-calm-line")).toBeNull();
		view.rerender({ calm: { resting: 0, off: 0 }, onOpen: () => undefined });
		expect(view.queryByTestId("device-calm-line")).toBeNull();
	});

	it("says the count and the reason, and opens Devices", async () => {
		let opened = 0;
		const view = render(DeviceCalmLine, {
			props: { calm: { resting: 1, off: 0 }, onOpen: () => (opened += 1) },
		});
		const line = view.getByTestId("device-calm-line");
		expect(line.textContent).toContain("1 device is resting to cool the box.");
		expect(line.textContent).not.toContain("offline");
		await view.getByTestId("device-calm-open").click();
		expect(opened).toBe(1);
		view.rerender({ calm: { resting: 2, off: 1 }, onOpen: () => undefined });
		expect(view.getByTestId("device-calm-line").textContent).toContain(
			"2 devices are resting to cool the box.",
		);
		expect(view.getByTestId("device-calm-line").textContent).toContain(
			"1 device is off.",
		);
	});
});
