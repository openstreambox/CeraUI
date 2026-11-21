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
	// The selection itself: the marks new client flows get must be exactly
	// the selectable uplinks', or the explicit drop when there are none.
	const expected = state.uplinks
		.filter((uplink) => uplink.selectable && uplink.weight > 0)
		.map((uplink) => uplink.mark >>> 0)
		.sort((a, b) => a - b);
	const live = selectedMarks(table);
	const dropping = table.includes('comment "no selectable client uplink"');
	if (
		live.length !== expected.length ||
		live.some((mark, index) => mark !== expected[index]) ||
		dropping !== (expected.length === 0)
	)
		throw new SteeringUnavailableError(
			"ruleset_reload_failed",
			"client uplink selection readback failed",
		);
}

/** Marks set by the `select_<n>` chains of a listed share table. */
export function selectedMarks(table: string): number[] {
	const marks: number[] = [];
	let inSelect = false;
	for (const line of table.split("\n")) {
		const trimmed = line.trim();
		if (/^chain select_\d+ \{$/.test(trimmed)) inSelect = true;
		else if (trimmed === "}") inSelect = false;
		else if (inSelect && trimmed.startsWith("meta mark set ")) {
			const mark = trimmed.match(/\| (0x[0-9a-f]+)$/i)?.[1];
			if (mark !== undefined) marks.push(Number(mark) >>> 0);
		}
	}
	return marks.sort((a, b) => a - b);
}
