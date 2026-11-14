// @vitest-environment jsdom
import { render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import BondedLinksSection from "./BondedLinksSection.svelte";
import { links, telemetry } from "./connected-idle-fixture";

afterEach(() => vi.useRealTimers());
it("shows the named quiet-link notice with details and clears on recovery", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	const view = render(BondedLinksSection, {
		links,
		modemEntries: [],
		isStreaming: true,
		linkTelemetry: telemetry(),
	});
	await tick();
	expect(screen.queryByTestId("connected-idle-notice")).toBeNull();
	for (let t = 1000; t <= 20_000; t += 1000) {
		vi.setSystemTime(t);
		await view.rerender({
			links,
			modemEntries: [],
			isStreaming: true,
			linkTelemetry: telemetry(),
		});
		await tick();
	}
	expect(screen.getByTestId("connected-idle-notice").textContent).toContain(
		"SIM 2",
	);
	expect(screen.getByTestId("connected-idle-notice").textContent).toContain(
		"can this network reach the receiver?",
	);
	expect(screen.getByTestId("connected-idle-notice").textContent).toContain(
		"still live on other links",
	);
	vi.setSystemTime(21_000);
	await view.rerender({
		links,
		modemEntries: [],
		isStreaming: true,
		linkTelemetry: telemetry(100_000),
	});
	await tick();
	expect(screen.queryByTestId("connected-idle-notice")).toBeNull();
});
