import { expect, test } from "bun:test";
import { projectRemotePayload } from "../modules/remote/remote-status.ts";

test("remote sensors preserve bounded power status and temperatures", () => {
	const allowed = {
		"SoC temperature": "45.0 °C",
		Power: "Power data not available",
		"Bank A": "30.0 °C",
		"Bank B": "Temperature unavailable",
		"Reserve pack": "29.0 °C (estimate)",
	};
	expect(
		projectRemotePayload("sensors", {
			...allowed,
			"Power sample": "4242",
			password: "secret",
		}),
	).toEqual(allowed);
});
test("power summaries accept only complete known phrases and bounded parameters", () => {
	const summary =
		"Bank A is hot and resting. Bank B powers the box. The box remains powered.";
	expect(projectRemotePayload("sensors", { Power: summary })).toEqual({
		Power: summary,
		"SoC temperature": "unavailable",
	});
	for (const value of [
		"secret",
		`${summary} secret`,
		"Bank secret is hot and resting.",
		"30 °C",
		"Bank A is hot and restingX",
		"Bank A is hot and resting. secret",
	])
		expect(
			projectRemotePayload("sensors", { Power: value, "Bank A": "secret" }),
		).toEqual({ "SoC temperature": "unavailable" });
});
