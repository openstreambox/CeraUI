import { plausibleTemperature } from "../streaming/heat-ladder.ts";
import {
	FREE_AT_RECHECK_MS,
	type FreeAtResult,
	type FreeAtUnavailableReason,
} from "./free-at-port.ts";

const SENSORS = new Set([
	"modem-lte-sub6-pa1",
	"aoss-0-usr",
	"cpuss-0-usr",
	"mdmq6-0-usr",
	"mdmss-0-usr",
	"modem-mmw0",
	"mdmss-1-usr",
	"mdmss-2-usr",
	"mdmss-3-usr",
	"modem-lte-sub6-pa2",
	"modem-ambient-usr",
	...[0, 1].flatMap((s) => [0, 1, 2].map((p) => `modem-sdr${s}-pa${p}`)),
]);
export const MODEM_TEMPERATURE_INTERVAL_MS = 10000;
/** After the released AT port is refused, look again this rarely (nothing is sent). */
export const MODEM_PORT_RECHECK_MS = FREE_AT_RECHECK_MS;
/** One `AT+QTEMP` exchange on the released port, including its final OK. */
export const MODEM_TEMPERATURE_TIMEOUT_MS = 2000;

/**
 * Hottest known sensor in an `AT+QTEMP` reply read on the released AT port
 * (`free-at-port.ts`). The lease returns a reply only after its complete final
 * `OK`, echo included; the echoed command line matches no sensor. An error
 * line anywhere means no reading. A value outside the ladder's plausible range
 * is dropped here, so it can never make the ladder's whole state unknown.
 */
export function parseModemTemperature(raw: string): number | null {
	const lines = raw.split(/\r?\n/).map((l) => l.trim());
	if (lines.some((l) => /^(ERROR|\+CME ERROR|\+CMS ERROR)/.test(l)))
		return null;
	const values = lines.flatMap((line) => {
		const match =
			/^\+QTEMP:\s*"([^"]+)",\s*(?:"(-?\d+(?:\.\d+)?)"|(-?\d+(?:\.\d+)?))$/.exec(
				line,
			);
		if (!match || !SENSORS.has(match[1] ?? "")) return [];
		const value = Number(match[2] ?? match[3]);
		return plausibleTemperature(value) ? [value] : [];
	});
	return values.length ? Math.max(...values) : null;
}

export interface ModemHeatSample {
	/** Hottest fresh plausible reading across present modems; null when none. */
	value: number | null;
	/** A present modem that has given readings has none now: cooling must wait. */
	missing: boolean;
	/**
	 * No present modem can be read: every one's released AT port is refused
	 * (not released, owned by ModemManager, in use, …) and none has given a
	 * reading. Heat steps then use the SoC temperature.
	 */
	unavailable: boolean;
	/** The fixed refusal reason when `unavailable`, for logs and diagnostics. */
	reason?: FreeAtUnavailableReason;
}

interface Target {
	id: number;
	identity: unknown;
}
interface ReaderLogger {
	warn: (message: string, meta?: Record<string, unknown>) => void;
	info?: (message: string, meta?: Record<string, unknown>) => void;
}

/** The lease's read for one modem, e.g. `freeAtPorts.read(id, "AT+QTEMP")`. */
export type ModemTemperatureRead = (id: number) => Promise<FreeAtResult>;

export class ModemTemperatureReader {
	private states = new Map<
		number,
		{
			identity: unknown;
			next: number;
			at: number;
			value: number | null;
			pending: boolean;
			/** This modem has given at least one reading. */
			seen: boolean;
			/** Its released port was refused; nothing is read before this time. */
			refusedUntil: number;
			reason?: FreeAtUnavailableReason | undefined;
		}
	>();
	constructor(
		private read: ModemTemperatureRead,
		private logger?: ReaderLogger,
	) {}
	sample(targets: readonly Target[], now: number): ModemHeatSample {
		for (const id of this.states.keys())
			if (!targets.some((t) => t.id === id)) this.states.delete(id);
		if (!targets.length)
			return { value: null, missing: false, unavailable: false };
		const values: number[] = [];
		let missing = false;
		let refused = 0;
		let reason: FreeAtUnavailableReason | undefined;
		for (const target of targets) {
			let state = this.states.get(target.id);
			if (state?.pending && state.identity !== target.identity) continue;
			if (!state || state.identity !== target.identity) {
				state = {
					identity: target.identity,
					next: now,
					at: -Infinity,
					value: null,
					pending: false,
					seen: false,
					refusedUntil: -Infinity,
				};
				this.states.set(target.id, state);
			}
			const current = state;
			if (now < current.refusedUntil) {
				// A modem that has given readings and then loses its port blocks
				// cooling like any other lost reading.
				if (current.seen) missing = true;
				else {
					refused++;
					reason ??= current.reason;
				}
				continue;
			}
			if (now >= current.next && !current.pending) {
				current.pending = true;
				current.next = now + MODEM_TEMPERATURE_INTERVAL_MS;
				void this.read(target.id)
					.then(
						(result) => {
							if (result.ok) {
								current.value = parseModemTemperature(result.raw);
								current.at = now;
								if (current.value !== null) current.seen = true;
								this.noteAvailable(target.id, current);
							} else {
								current.value = null;
								if (result.unavailable) {
									current.refusedUntil = now + MODEM_PORT_RECHECK_MS;
									this.noteRefused(target.id, current, result.reason);
								}
							}
						},
						() => {
							current.value = null;
						},
					)
					.finally(() => {
						current.pending = false;
					});
			}
			const fresh =
				current.value !== null &&
				now >= current.at &&
				now - current.at <= MODEM_TEMPERATURE_INTERVAL_MS + 2000;
			if (fresh && current.value !== null) values.push(current.value);
			else if (current.seen) missing = true;
		}
		const unavailable = refused > 0 && refused === targets.length;
		return {
			value: values.length ? Math.max(...values) : null,
			missing,
			unavailable,
			...(unavailable && reason ? { reason } : {}),
		};
	}
	private noteRefused(
		id: number,
		state: { reason?: FreeAtUnavailableReason | undefined },
		reason: FreeAtUnavailableReason,
	): void {
		if (state.reason === reason) return;
		state.reason = reason;
		this.logger?.warn(
			"modem temperature: the RM520's second AT port is not available; heat steps use the SoC temperature",
			{ modem: id, reason },
		);
	}
	private noteAvailable(
		id: number,
		state: { reason?: FreeAtUnavailableReason | undefined },
	): void {
		if (state.reason === undefined) return;
		state.reason = undefined;
		this.logger?.info?.(
			"modem temperature: the RM520's second AT port is available again",
			{ modem: id },
		);
	}
}
