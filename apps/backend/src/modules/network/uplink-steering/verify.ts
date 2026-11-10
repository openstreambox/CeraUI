import { run } from "../../../helpers/run.ts";
import type { PreparedSteeringState } from "./applier.ts";
import { SteeringUnavailableError } from "./contracts.ts";
import { hasFwmarkRule, hasSourceRule } from "./route-policy.ts";

export async function verifySteeringState(
	state: PreparedSteeringState,
	execute = run,
): Promise<void> {
	if (state.clientZones.length === 0) return;
	const rules = await execute("ip", ["rule", "show"]);
	for (const route of state.routes) {
		const table = await execute("ip", ["route", "show", "table", route.table]);
		if (
			!hasFwmarkRule(rules, route) ||
			(route.sourceRulePriority !== undefined &&
				!hasSourceRule(rules, route)) ||
			!table
				.split("\n")
				.some(
					(line) =>
						line.startsWith("default ") &&
						line
							.split(/\s+/)
							.some(
								(token, index, tokens) =>
									token === "dev" && tokens[index + 1] === route.ifname,
							),
				)
		) {
			throw new SteeringUnavailableError(
				"policy_route_missing",
				`steering readback failed for ${route.ifname}`,
			);
		}
	}
	const table = await execute("nft", [
		"list",
		"table",
		"inet",
		"ceralive_share",
	]);
	for (const zone of state.clientZones) {
		if (!table.includes(`iifname "${zone.ifname}"`))
			throw new SteeringUnavailableError(
				"ruleset_reload_failed",
				`client zone readback failed for ${zone.ifname}`,
			);
	}
}
