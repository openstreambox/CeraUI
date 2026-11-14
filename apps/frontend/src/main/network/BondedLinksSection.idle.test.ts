// @vitest-environment jsdom
import { render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import BondedLinksSection from "./BondedLinksSection.svelte";
import { links, telemetry } from "./connected-idle-fixture";

afterEach(() => vi.useRealTimers());
it.each([0, 50])(
	"uses neutral copy at sender weight %s and clears on recovery",
	async (weight) => {
		const sample = (rate = 0) => {
			const frame = telemetry(rate);
			frame.links[0]!.weight_percent = weight;
			return frame;
		};
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const view = render(BondedLinksSection, {
			links,
			modemEntries: [],
			isStreaming: true,
			linkTelemetry: sample(),
		});
		await tick();
		expect(screen.queryByTestId("connected-idle-notice")).toBeNull();
		for (let t = 1000; t <= 20_000; t += 1000) {
			vi.setSystemTime(t);
			await view.rerender({
				links,
				modemEntries: [],
				isStreaming: true,
				linkTelemetry: sample(),
			});
			await tick();
		}
		expect(screen.getByTestId("connected-idle-notice").textContent).toContain(
			"SIM 2",
		);
		expect(screen.getByTestId("connected-idle-notice").textContent).toContain(
			"carries almost no stream traffic",
		);
		expect(screen.getByTestId("connected-idle-notice").textContent).toContain(
			"still live on other links",
		);
		expect(
			screen.getByTestId("connected-idle-notice").textContent,
		).not.toContain("can this network reach");
		vi.setSystemTime(21_000);
		await view.rerender({
			links,
			modemEntries: [],
			isStreaming: true,
			linkTelemetry: sample(100_000),
		});
		await tick();
		expect(screen.queryByTestId("connected-idle-notice")).toBeNull();
	},
);

it("renders shared observations immediately across a Network remount", async () => {
	const props = {
		links,
		modemEntries: [],
		isStreaming: true,
		linkTelemetry: telemetry(),
		observedIdleLinks: ["eth0"],
	};
	let view = render(BondedLinksSection, props);
	await tick();
	expect(screen.getByTestId("connected-idle-notice")).toBeTruthy();
	view.unmount();
	view = render(BondedLinksSection, props);
	await tick();
	expect(screen.getByTestId("connected-idle-notice")).toBeTruthy();
	await view.rerender({ ...props, observedIdleLinks: [] });
	await tick();
	expect(screen.queryByTestId("connected-idle-notice")).toBeNull();
});
