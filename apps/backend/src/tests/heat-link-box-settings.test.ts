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
