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
