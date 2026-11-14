import { expect, test } from "bun:test";
import { createHeatSettings } from "../modules/streaming/heat-link-box-settings.ts";

test("legacy preference defaults to auto, saves suggest only and reads it back", () => {
	const config: { heat_pause_mode?: "auto" | "suggest" } = {};
	let saves = 0;
	const settings = createHeatSettings(
		() => config,
		() => {
			saves++;
		},
	);
	expect(settings.get()).toEqual({ mode: "auto", active: false });
	expect(settings.set("suggest")).toEqual({ success: true, mode: "suggest" });
	expect(settings.get().mode).toBe("suggest");
	expect(config.heat_pause_mode).toBe("suggest");
	expect(settings.set("auto").mode).toBe("auto");
	expect(saves).toBe(2);
});
test("failed persistence cannot change the effective preference", () => {
	const config: { heat_pause_mode?: "auto" | "suggest" } = {
		heat_pause_mode: "suggest",
	};
	const settings = createHeatSettings(
		() => config,
		() => {
			throw new Error("disk");
		},
	);
	expect(settings.set("auto")).toEqual({ success: false, mode: "suggest" });
	expect(settings.get().mode).toBe("suggest");
});

test("a controller without a measured owner refuses both actions in either mode", async () => {
	const config: { heat_pause_mode?: "auto" | "suggest" } = {};
	const settings = createHeatSettings(
		() => config,
		() => {},
	);
	for (const mode of ["auto", "suggest"] as const) {
		settings.set(mode);
		expect(settings.get().mode).toBe(mode);
		for (const action of ["pause", "restore"] as const)
			for (const id of ["guest", "phone", "", "x".repeat(256)])
				expect(await settings.action(action, id)).toBe(false);
		await settings.update();
		expect(settings.get().active).toBe(false);
	}
});
