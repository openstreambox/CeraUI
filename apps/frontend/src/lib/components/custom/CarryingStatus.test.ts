import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import CarryingStatus from "./CarryingStatus.svelte";

describe("client carrying status", () => {
	it("shows the backend carrying state, including its hold", () => {
		render(CarryingStatus, { carrying: { state: "streaming" } });
		expect(screen.getByTestId("carrying-status").textContent).toContain(
			"Carrying",
		);
	});
	it("keeps unknown distinct from confirmed no client", () => {
		render(CarryingStatus, { carrying: { state: "unknown" } });
		expect(screen.getByTestId("carrying-status").textContent).toContain(
			"unknown",
		);
	});
	it("does not claim idle about the phone itself", () => {
		render(CarryingStatus, { carrying: { state: "idle" } });
		expect(screen.getByTestId("carrying-status").textContent).toContain(
			"through this box",
		);
	});
	it("renders no client claim for an older backend", () => {
		render(CarryingStatus, {});
		expect(screen.queryByTestId("carrying-status")).toBeNull();
	});
});
