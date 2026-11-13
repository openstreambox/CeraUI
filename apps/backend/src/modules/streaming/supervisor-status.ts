import { HEAT_SETTINGS, plausibleTemperature } from "./heat-ladder";

/** Same plausible range as the ladder, so a value is never kept here and rejected there. */
function temperature(value: string | undefined): number | null {
	if (!value || !/^-?\d+(\.\d+)?C$/.test(value)) return null;
	const n = Number(value.slice(0, -1));
	return plausibleTemperature(n) ? n : null;
}

/** CRC-16/CCITT-FALSE, UTF-8 bytes, initial FFFF, polynomial 1021, no reflection or final XOR. */
export function supervisorCrc16(payload: string): string {
	let crc = 0xffff;
	for (const byte of new TextEncoder().encode(payload)) {
		crc ^= byte << 8;
		for (let bit = 0; bit < 8; bit++)
			crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
	}
	return crc.toString(16).toUpperCase().padStart(4, "0");
}
function counter(
	value: string | undefined,
	max = Number.MAX_SAFE_INTEGER,
): number | null {
	if (!value || !/^\d+$/.test(value)) return null;
	const n = Number(value);
	return Number.isSafeInteger(n) && n <= max ? n : null;
}
function matching(value: string | undefined, pattern: RegExp): string | null {
	return value !== undefined && pattern.test(value) ? value : null;
}
/** No transport: receipt time belongs to the future link reader, not supervisor uptime. */
export function parseSupervisor(line: string, receivedAt: number, now: number) {
	const frame = line.replace(/\r?\n$/, "");
	if (
		!Number.isFinite(now) ||
		!Number.isFinite(receivedAt) ||
		/[\r\n]/.test(frame) ||
		now < receivedAt ||
		now - receivedAt > HEAT_SETTINGS.staleMs ||
		!frame.startsWith("OSB1 ") ||
		frame.startsWith("OSB1 EVT ") ||
		line.length > 2048
	)
		return null;
	const fields: Record<string, string> = Object.create(null);
	for (const field of frame.split(/\s+/).slice(1)) {
		const separator = field.indexOf("=");
		if (separator <= 0) return null;
		const key = field.slice(0, separator);
		if (fields[key] !== undefined) return null;
		fields[key] = field.slice(separator + 1);
	}
	if (
		!/^\d+$/.test(fields.up ?? "") ||
		!fields.a ||
		!fields.b ||
		!fields.pack ||
		!fields.thermal
	)
		return null;
	if (fields.crc !== undefined) {
		const suffix = / crc=([0-9A-Fa-f]{4})$/.exec(frame);
		if (
			!suffix ||
			supervisorCrc16(frame.slice(0, suffix.index)) !== fields.crc.toUpperCase()
		)
			return null;
	}
	const hot = fields.hot === "none" ? [] : fields.hot?.split(",");
	const bank = (value: string) => {
		const parts = value.split("/");
		return parts[0] === "healthy" ? temperature(parts[3]) : null;
	};
	const packCalibration = matching(fields.pack_cal, /^(datasheet|bench|none)$/);
	const gapsText = matching(fields.gaps, /^[0-9a-fA-F]{4}$/);
	const gaps = gapsText === null ? null : Number.parseInt(gapsText, 16);
	// A present but malformed field is never read as full protection.
	const gapsMalformed = fields.gaps !== undefined && gapsText === null;
	const gaps2Text = matching(fields.gaps2, /^[0-9a-fA-F]{4}$/);
	const gaps2 = gaps2Text === null ? null : Number.parseInt(gaps2Text, 16);
	const gaps2Malformed = fields.gaps2 !== undefined && gaps2Text === null;
	const packFlags = fields.pack.split("/")[2];
	const packJump =
		(gaps2 !== null && (gaps2 & 0x0002) !== 0) ||
		(packFlags !== undefined &&
			/^[0-9a-fA-F]{2}$/.test(packFlags) &&
			(Number.parseInt(packFlags, 16) & 0x40) !== 0);
	const packDatasheet =
		packCalibration === "datasheet" ||
		(packFlags !== undefined &&
			/^[0-9a-fA-F]{2}$/.test(packFlags) &&
			(Number.parseInt(packFlags, 16) & 0x10) !== 0);
	return {
		packCalibration,
		packDatasheet,
		start: matching(
			fields.start,
			/^(on|off|settling|no_bank|too_hot|temp_unknown|latched|unarmed)$/,
		),
		gaps,
		gaps2,
		supplyUnproven: gaps2 !== null && (gaps2 & 0x0001) !== 0,
		packJump,
		protectionReduced:
			gapsMalformed ||
			gaps2Malformed ||
			packJump ||
			(gaps !== null && gaps !== 0) ||
			(gaps2 !== null && gaps2 !== 0)
				? true
				: gaps === null && gaps2 === null
					? null
					: false,
		temperatures: {
			pack: temperature(fields.pack.split("/")[1]),
			bankA: bank(fields.a),
			bankB: bank(fields.b),
		},
		seq: counter(fields.seq, 0xffffffff),
		boot: matching(fields.boot, /^[0-9a-fA-F]{8}$/),
		rst: matching(fields.rst, /^(poweron|wdt|brownout|panic|sw|other)$/),
		alive: fields.alive === "1" ? true : fields.alive === "0" ? false : null,
		hot: hot?.every((probe) => ["a", "b", "pack"].includes(probe)) ? hot : null,
		shutdowns: counter(fields.shutdowns),
		fw: matching(fields.fw, /^(field|bench)-[0-9a-fA-F]{8}$/),
		crc: fields.crc?.toUpperCase() ?? null,
		thermal: fields.thermal,
		fan: fields.fan ?? "unknown",
		sbc: fields.sbc ?? "unknown",
	};
}
