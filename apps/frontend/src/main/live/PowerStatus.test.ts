import { setLocale } from "@ceraui/i18n/svelte";
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";
import PowerStatus from "./PowerStatus.svelte";

afterEach(() => {
	cleanup();
	setLocale("en");
	vi.useRealTimers();
});
test("phone and moderator can read the power warning without changing the live verdict", () => {
	render(PowerStatus, {
		sensors: {
			Power: "Power is weak. The box remains powered.",
			"Power sample": "1",
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
		sensors: { Power: "Running on reserve.", "Power sample": "1" },
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

test("unrelated sensor deliveries cannot refresh an unchanged power sample", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
	const { rerender } = render(PowerStatus, {
		sensors: { Power: "The box remains powered.", "Power sample": "1" },
		connected: true,
	});
	await vi.advanceTimersByTimeAsync(4000);
	await rerender({
		sensors: {
			Power: "The box remains powered.",
			"Power sample": "1",
			"SoC temperature": "46 °C",
		},
		connected: true,
	});
	await vi.advanceTimersByTimeAsync(1000);
	expect(screen.getByRole("status").textContent).toContain(
		"Power data not available",
	);
});

test("Spanish readers get localized power and temperature copy", () => {
	setLocale("es");
	render(PowerStatus, {
		sensors: {
			Power: "Bank A is hot and resting. Bank B powers the box.",
			"Power sample": "1",
			"Reserve pack": "30.0 °C (estimate)",
		},
		connected: true,
	});
	expect(screen.getByRole("status").textContent).toBe(
		"El banco A está caliente y en reposo. El banco B alimenta el equipo.",
	);
	expect(screen.getByText("Reserva: 30.0 °C (estimación)")).toBeTruthy();
});

test("power-only payload identity cannot establish freshness without a sample marker", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
	const { rerender } = render(PowerStatus, {
		sensors: { Power: "The box remains powered." },
		connected: true,
	});
	await vi.advanceTimersByTimeAsync(4000);
	await rerender({
		sensors: { Power: "The box remains powered." },
		connected: true,
	});
	await vi.advanceTimersByTimeAsync(4000);
	expect(screen.getByRole("status").textContent).toContain(
		"Power data not available",
	);
});
