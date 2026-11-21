/**
 * A schema_version skew between the engine and the bindings CeraUI was built
 * against is the same fact for every probe, capability read and reconnect
 * handshake on one engine connection, so it is logged once per connection.
 * A retired connection or a failed probe re-arms the warning, so the next
 * connection logs it again; a different pair of versions logs at once.
 */

interface SkewLogger {
	warn(message: string, meta?: unknown): void;
}

let reported: string | undefined;

export function reportEngineSchemaSkew(
	logger: SkewLogger,
	versions: { engine: string; bindings: string; engineVersion?: string },
): void {
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
