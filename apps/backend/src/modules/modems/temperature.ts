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
export function parseModemTemperature(raw: string): number | null {
	const lines = raw.split(/\r?\n/).map((l) => l.trim());
	if (
		!lines.includes("OK") ||
		lines.some((l) => /^(ERROR|\+CME ERROR|\+CMS ERROR)/.test(l))
	)
		return null;
	const values = lines.flatMap((line) => {
		const match =
			/^\+QTEMP:\s*"([^"]+)",\s*(?:"(-?\d+(?:\.\d+)?)"|(-?\d+(?:\.\d+)?))$/.exec(
				line,
			);
		if (!match || !SENSORS.has(match[1] ?? "")) return [];
		const value = Number(match[2] ?? match[3]);
		return Number.isFinite(value) && value >= -50 && value <= 150
			? [value]
			: [];
	});
	return values.length ? Math.max(...values) : null;
}
interface Target {
	id: number;
	identity: unknown;
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
		}
	>();
	constructor(private read: (id: number) => Promise<string>) {}
	sample(targets: readonly Target[], now: number): number | null {
		for (const id of this.states.keys())
			if (!targets.some((t) => t.id === id)) this.states.delete(id);
		const values: number[] = [];
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
							current.value = parseModemTemperature(raw);
							current.at = now;
						},
						() => {
							current.value = null;
						},
					)
					.finally(() => {
						current.pending = false;
					});
			}
			if (
				current.value !== null &&
				now >= current.at &&
				now - current.at <= MODEM_TEMPERATURE_INTERVAL_MS + 2000
			)
				values.push(current.value);
		}
		return values.length === targets.length && values.length > 0
			? Math.max(...values)
			: null;
	}
}
