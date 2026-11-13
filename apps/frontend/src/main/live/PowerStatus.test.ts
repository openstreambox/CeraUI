// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";
import PowerStatus from "./PowerStatus.svelte";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});
test("phone and moderator can read the power warning without changing the live verdict", () => {
	render(PowerStatus, {
		sensors: {
			Power: "Power is weak. The box remains powered.",
			"Bank A": "30.0 °C",
		},
		connected: true,
	});
	expect(screen.getByRole("status").textContent).toContain(
		"box remains powered",
	);
	expect(screen.getByText("Bank A: 30.0 °C")).toBeTruthy();
	expect(screen.getByText("Bank A: 30.0 °C").closest("details")?.open).toBe(
		false,
	);
	expect(screen.queryByRole("button")).toBeNull();
	expect(screen.queryByRole("alert")).toBeNull();
});
test("disconnect hides retained warnings and readings quietly", () => {
	render(PowerStatus, {
		sensors: { Power: "Power is weak.", "Bank A": "30.0 °C" },
		connected: false,
	});
	expect(screen.getByRole("status").textContent).toContain(
		"Power data not available",
	);
	expect(screen.queryByText("Power is weak.")).toBeNull();
	expect(screen.queryByText("Bank A: 30.0 °C")).toBeNull();
});
test("older images and dev without a power field render no extra notice", () => {
	render(PowerStatus, {
		sensors: { "SoC temperature": "45 °C" },
		connected: true,
	});
	expect(screen.queryByRole("status")).toBeNull();
});
test("a stalled socket cannot leave a fresh-looking power warning", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
	render(PowerStatus, {
		sensors: { Power: "Running on reserve." },
		connected: true,
	});
	expect(screen.getByRole("status").textContent).toContain(
		"Running on reserve",
	);
	await vi.advanceTimersByTimeAsync(5000);
	expect(screen.getByRole("status").textContent).toContain(
		"Power data not available",
	);
});

test("fresh deliveries of an unchanged condition keep the status current", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
	const { rerender } = render(PowerStatus, {
		sensors: { Power: "The box remains powered.", "Power sample": "1" },
		connected: true,
	});
	await vi.advanceTimersByTimeAsync(4000);
	await rerender({
		sensors: { Power: "The box remains powered.", "Power sample": "2" },
		connected: true,
	});
	await vi.advanceTimersByTimeAsync(4000);
	expect(screen.getByRole("status").textContent).toContain(
		"box remains powered",
	);
});
