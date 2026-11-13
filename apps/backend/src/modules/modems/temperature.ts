import { plausibleTemperature } from "../streaming/heat-ladder.ts";

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
/** After ModemManager refuses AT commands, look again this rarely. */
export const MODEM_COMMAND_RECHECK_MS = 600000;

/**
 * Hottest known sensor in an `AT+QTEMP` reply. ModemManager returns a
 * `--command` reply with the final result code removed (it reports failure as
 * an error instead), so a final `OK` is accepted but not required. A value
 * outside the ladder's plausible range is dropped here, so it can never make
 * the ladder's whole state unknown.
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

/** The reply text from `mmcli --command=… -J`; empty when absent or not JSON. */
export function qtempResponseFromMmcli(json: string): string {
	try {
		const response: unknown = JSON.parse(json)?.modem?.command?.response;
		return typeof response === "string" ? response : "";
	} catch {
		return "";
	}
}

/**
 * Stock ModemManager answers `--command` only when the daemon runs with
 * `--debug` (or was built with AT commands over D-Bus).
 */
export function isAtCommandRefusal(text: string): boolean {
	return /only allowed in debug mode/i.test(text);
}

/** ModemManager on this box does not accept AT commands. */
export class ModemCommandUnavailableError extends Error {
	constructor() {
		super("ModemManager does not accept AT commands (not in debug mode)");
		this.name = "ModemCommandUnavailableError";
	}
}

export interface ModemHeatSample {
	/** Hottest fresh plausible reading across present modems; null when none. */
	value: number | null;
	/** A present modem that has given readings has none now: cooling must wait. */
	missing: boolean;
	/** ModemManager refuses AT commands, so no modem temperature can be read. */
	unavailable: boolean;
}

interface Target {
	id: number;
	identity: unknown;
}
interface ReaderLogger {
	warn: (message: string, meta?: Record<string, unknown>) => void;
	info?: (message: string, meta?: Record<string, unknown>) => void;
}

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
		}
	>();
	private unavailableUntil = -Infinity;
	private refused = false;
	constructor(
		private read: (id: number) => Promise<string>,
		private logger?: ReaderLogger,
	) {}
	sample(targets: readonly Target[], now: number): ModemHeatSample {
		for (const id of this.states.keys())
			if (!targets.some((t) => t.id === id)) this.states.delete(id);
		if (!targets.length)
			return { value: null, missing: false, unavailable: false };
		if (now < this.unavailableUntil)
			return { value: null, missing: false, unavailable: true };
		const values: number[] = [];
		let missing = false;
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
				};
				this.states.set(target.id, state);
			}
			const current = state;
			if (now >= current.next && !current.pending) {
				current.pending = true;
				current.next = now + MODEM_TEMPERATURE_INTERVAL_MS;
				void this.read(target.id)
					.then(
						(raw) => {
							this.noteAvailable();
							current.value = parseModemTemperature(raw);
							current.at = now;
							if (current.value !== null) current.seen = true;
						},
						(error: unknown) => {
							current.value = null;
							if (error instanceof ModemCommandUnavailableError)
								this.noteRefused(now);
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
		return {
			value: values.length ? Math.max(...values) : null,
			missing,
			unavailable: false,
		};
	}
	private noteRefused(at: number): void {
		this.unavailableUntil = at + MODEM_COMMAND_RECHECK_MS;
		if (this.refused) return;
		this.refused = true;
		this.logger?.warn(
			"modem temperature: ModemManager does not accept AT commands (it needs --debug); modem temperature is not available",
		);
	}
	private noteAvailable(): void {
		if (!this.refused) return;
		this.refused = false;
		this.unavailableUntil = -Infinity;
		this.logger?.info?.(
			"modem temperature: ModemManager accepts AT commands again",
		);
	}
}
