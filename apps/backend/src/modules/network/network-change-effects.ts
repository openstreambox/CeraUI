/**
 * Effects a NetworkManager checkpoint cannot undo, each with its own recorded
 * undo.
 *
 * A driver first READS the state it will change (`prepare`) with no side
 * effect. The owner writes that undo record to the journal and syncs it, and
 * only then calls `apply`. `undo` must be idempotent: it is replayed after a
 * timeout, a NetworkManager or backend restart, or a reboot, possibly after a
 * partial apply or a previous partial undo.
 *
 * This draft ships no real drivers. Hotspot-interface teardown and modem
 * radio-mode writes are expressed through this interface; their device-facing
 * implementations come with the wiring change.
 */

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

/** Removing a virtual hotspot interface the AP profile runs on. */
export const HOTSPOT_INTERFACE_EFFECT = "hotspot-interface";
/** Writing a modem's allowed/preferred radio modes. */
export const MODEM_RADIO_MODE_EFFECT = "modem-radio-mode";

export interface EffectDriver {
	readonly kind: string;
	prepare(spec: JsonValue): Promise<JsonValue>;
	apply(spec: JsonValue): Promise<void>;
	undo(recorded: JsonValue): Promise<void>;
}

export interface EffectRegistry {
	get(kind: string): EffectDriver;
}

export function createEffectRegistry(
	drivers: readonly EffectDriver[],
): EffectRegistry {
	const byKind = new Map<string, EffectDriver>();
	for (const driver of drivers) {
		if (byKind.has(driver.kind))
			throw new Error(`Duplicate effect driver: ${driver.kind}`);
		byKind.set(driver.kind, driver);
	}
	return {
		get(kind) {
			const driver = byKind.get(kind);
			// An effect without a driver could never be undone: refuse it.
			if (!driver) throw new Error(`No recorded undo for effect: ${kind}`);
			return driver;
		},
	};
}
