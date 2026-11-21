/**
 * A schema_version skew between the engine and the bindings CeraUI was built
 * against is the same fact for every probe and capability read, so repeated
 * observations of the same skew are logged once. The warning comes back after
 * an observed boundary: a failed probe, a current capability read that finds
 * the engine unreachable, a retired session connection, or an observed
 * matching schema. A different pair of versions logs at once. An engine
 * restart with the same versions that CeraUI never sees fail is not a
 * boundary: the hello carries versions, not a process identity.
 */

interface SkewLogger {
	warn(message: string, meta?: unknown): void;
}

let reported: string | undefined;

/** Record the engine schema seen on a live connection; warn on a new skew. */
export function observeEngineSchema(
	logger: SkewLogger,
	versions: { engine: string; bindings: string; engineVersion?: string },
): void {
	if (versions.engine === versions.bindings) {
		reported = undefined;
		return;
	}
	const key = `${versions.engine}\u0000${versions.bindings}`;
	if (reported === key) return;
	reported = key;
	logger.warn(
		"cerastream: engine schema_version differs from bindings (additive-only, informational)",
		versions,
	);
}

/** The engine connection that showed the skew is gone; warn on the next one. */
export function forgetEngineSchemaSkew(): void {
	reported = undefined;
}

/**
 * How the engine's `schema_version` relates to the bindings' one. The wire
 * schema is additive-only within protocol major `cerastream-ipc/1`, and CeraUI
 * gates every feature newer than its oldest supported engine on the engine's
 * own `get-capabilities.features` tokens, so the two directions differ:
 *
 *  - `older`: every field the engine sends parses exactly; newer features are
 *    absent and their UI stays off. Nothing shown is approximate.
 *  - `newer`, or `unknown` (a different major or a version that does not
 *    parse): the engine may send fields the bindings strip, so what CeraUI
 *    offers can trail what the engine can do.
 */
export type EngineSchemaSkew = "match" | "older" | "newer" | "unknown";

function parseSchemaVersion(
	version: string,
): readonly [number, number, number] | undefined {
	const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (parts === null) return undefined;
	return [Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

export function classifyEngineSchemaSkew(
	engine: string,
	bindings: string,
): EngineSchemaSkew {
	if (engine === bindings) return "match";
	const e = parseSchemaVersion(engine);
	const b = parseSchemaVersion(bindings);
	if (e === undefined || b === undefined) return "unknown";
	// A different schema major is outside the additive-only promise.
	if (e[0] !== b[0]) return "unknown";
	if (e[1] !== b[1]) return e[1] < b[1] ? "older" : "newer";
	if (e[2] !== b[2]) return e[2] < b[2] ? "older" : "newer";
	return "match";
}

/** Whether the skew can make the offered capabilities trail the engine. */
export function skewMayHideCapabilities(skew: EngineSchemaSkew): boolean {
	return skew === "newer" || skew === "unknown";
}
