/*
  NAT64 ADDRESS ARITHMETIC (RFC 6052) AND PREFIX DISCOVERY (RFC 7050).

  An IPv6-only uplink reaches an IPv4-only host through the carrier's NAT64 by
  sending to an IPv6 address that embeds the IPv4 one in the carrier's prefix.
  The prefix is a property of ONE uplink: two carriers in the same bond use
  different ones, and a wired uplink has none. It is therefore discovered per
  uplink and never hardcoded or shared.

  Discovery asks the uplink's own resolver for `AAAA ipv4only.arpa`. That name
  has no AAAA record, so any answer is a DNS64 synthesis of its two well-known
  IPv4 addresses, and the prefix can be read back out of the answer.

  Pure functions only; sockets and resolvers are the caller's.
*/

export type Nat64PrefixLength = 32 | 40 | 48 | 56 | 64 | 96;

export type Nat64Prefix = {
	/** The 16 address bytes with every bit past `length` cleared. */
	readonly bytes: Uint8Array;
	readonly length: Nat64PrefixLength;
};

const PREFIX_LENGTHS: readonly Nat64PrefixLength[] = [32, 40, 48, 56, 64, 96];

/** `ipv4only.arpa` — 192.0.0.170 and 192.0.0.171 (RFC 7050 section 2.2). */
const WELL_KNOWN_IPV4: readonly (readonly number[])[] = [
	[192, 0, 0, 170],
	[192, 0, 0, 171],
];

export function parseIpv4(text: string): Uint8Array | undefined {
	const parts = text.split(".");
	if (parts.length !== 4) return undefined;
	const bytes = new Uint8Array(4);
	for (let index = 0; index < 4; index += 1) {
		const part = parts[index] ?? "";
		if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
		const value = Number(part);
		if (value > 255) return undefined;
		bytes[index] = value;
	}
	return bytes;
}

export function parseIpv6(text: string): Uint8Array | undefined {
	let source = text;
	const zone = source.indexOf("%");
	if (zone !== -1) source = source.slice(0, zone);
	if (source.length === 0 || !/^[0-9a-fA-F:.]+$/.test(source)) return undefined;

	// A trailing dotted quad stands for the last two groups.
	let tail: Uint8Array | undefined;
	const lastColon = source.lastIndexOf(":");
	if (source.includes(".")) {
		tail = parseIpv4(source.slice(lastColon + 1));
		if (tail === undefined) return undefined;
		source = `${source.slice(0, lastColon + 1)}0:0`;
	}

	const halves = source.split("::");
	if (halves.length > 2) return undefined;
	const groupsOf = (half: string): string[] | undefined => {
		if (half === "") return [];
		const groups = half.split(":");
		return groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))
			? groups
			: undefined;
	};
	const head = groupsOf(halves[0] ?? "");
	const rest = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
	if (head === undefined || rest === undefined) return undefined;
	const missing = 8 - head.length - rest.length;
	if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;

	const groups = [
		...head,
		...Array.from({ length: Math.max(missing, 0) }, () => "0"),
		...rest,
	];
	const bytes = new Uint8Array(16);
	groups.forEach((group, index) => {
		const value = Number.parseInt(group, 16);
		bytes[index * 2] = value >> 8;
		bytes[index * 2 + 1] = value & 0xff;
	});
	if (tail !== undefined) bytes.set(tail, 12);
	return bytes;
}

/** RFC 5952 text form: lowercase, longest zero run (two or more) compressed. */
export function formatIpv6(bytes: Uint8Array): string {
	const groups: number[] = [];
	for (let index = 0; index < 16; index += 2) {
		groups.push(((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0));
	}
	let bestStart = -1;
	let bestLength = 0;
	for (let start = 0; start < 8; ) {
		if (groups[start] !== 0) {
			start += 1;
			continue;
		}
		let end = start;
		while (end < 8 && groups[end] === 0) end += 1;
		if (end - start > bestLength && end - start >= 2) {
			bestStart = start;
			bestLength = end - start;
		}
		start = end;
	}
	const hex = (list: number[]) => list.map((g) => g.toString(16)).join(":");
	if (bestStart === -1) return hex(groups);
	return `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLength))}`;
}

/**
 * Where the four IPv4 bytes sit for each prefix length (RFC 6052 section 2.2).
 * Byte 8 (bits 64..71) is reserved and skipped by every length shorter than 96.
 */
function embedOffsets(length: Nat64PrefixLength): readonly number[] {
	switch (length) {
		case 32:
			return [4, 5, 6, 7];
		case 40:
			return [5, 6, 7, 9];
		case 48:
			return [6, 7, 9, 10];
		case 56:
			return [7, 9, 10, 11];
		case 64:
			return [9, 10, 11, 12];
		case 96:
			return [12, 13, 14, 15];
	}
}

export function nat64Prefix(
	address: Uint8Array,
	length: Nat64PrefixLength,
): Nat64Prefix {
	const bytes = new Uint8Array(16);
	bytes.set(address.subarray(0, length / 8));
	return { bytes, length };
}

export function parseNat64Prefix(cidr: string): Nat64Prefix | undefined {
	const [address, lengthText, extra] = cidr.split("/");
	if (address === undefined || lengthText === undefined || extra !== undefined)
		return undefined;
	const length = PREFIX_LENGTHS.find((l) => String(l) === lengthText);
	const bytes = parseIpv6(address);
	if (length === undefined || bytes === undefined) return undefined;
	return nat64Prefix(bytes, length);
}

export function formatNat64Prefix(prefix: Nat64Prefix): string {
	return `${formatIpv6(prefix.bytes)}/${prefix.length}`;
}

/** The IPv6 address that reaches `ipv4` through the NAT64 owning `prefix`. */
export function synthesizeNat64(
	prefix: Nat64Prefix,
	ipv4: string,
): string | undefined {
	const v4 = parseIpv4(ipv4);
	if (v4 === undefined) return undefined;
	const bytes = new Uint8Array(prefix.bytes);
	embedOffsets(prefix.length).forEach((offset, index) => {
		bytes[offset] = v4[index] ?? 0;
	});
	return formatIpv6(bytes);
}

function prefixOfAnswer(address: Uint8Array): Nat64Prefix | undefined {
	for (const length of PREFIX_LENGTHS) {
		const offsets = embedOffsets(length);
		const embedded = offsets.map((offset) => address[offset]);
		const wellKnown = WELL_KNOWN_IPV4.some((known) =>
			known.every((byte, index) => embedded[index] === byte),
		);
		if (!wellKnown) continue;
		// Everything that is neither prefix nor embedded address must be zero,
		// otherwise the match is a coincidence inside an unrelated address.
		const clean = address.every(
			(byte, index) =>
				index < length / 8 || offsets.includes(index) || byte === 0,
		);
		if (clean) return nat64Prefix(address, length);
	}
	return undefined;
}

/**
 * The NAT64 prefix implied by a resolver's AAAA answers for `ipv4only.arpa`.
 *
 * Answers that do not embed a well-known address are ignored. Answers that
 * disagree return `undefined`: a network may legitimately run several prefixes,
 * but choosing one without knowing which the path honours is a guess, and a
 * wrong guess blackholes the stream.
 */
export function pref64FromIpv4OnlyArpa(
	answers: readonly string[],
): Nat64Prefix | undefined {
	let found: Nat64Prefix | undefined;
	for (const answer of answers) {
		const bytes = parseIpv6(answer);
		if (bytes === undefined) continue;
		const prefix = prefixOfAnswer(bytes);
		if (prefix === undefined) continue;
		if (found === undefined) {
			found = prefix;
		} else if (formatNat64Prefix(found) !== formatNat64Prefix(prefix)) {
			return undefined;
		}
	}
	return found;
}

/** The fixed question of the discovery, as a DNS wire-format query. */
export function buildIpv4OnlyArpaQuery(id: number): Uint8Array {
	const labels = ["ipv4only", "arpa"];
	const name = labels.flatMap((label) => [
		label.length,
		...new TextEncoder().encode(label),
	]);
	return Uint8Array.from([
		(id >> 8) & 0xff,
		id & 0xff,
		0x01, // recursion desired
		0x00,
		0x00,
		0x01, // one question
		0x00,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00,
		...name,
		0x00,
		0x00,
		0x1c, // AAAA
		0x00,
		0x01, // IN
	]);
}

function skipName(message: Uint8Array, start: number): number | undefined {
	let offset = start;
	for (;;) {
		const length = message[offset];
		if (length === undefined) return undefined;
		if ((length & 0xc0) === 0xc0) {
			const low = message[offset + 1];
			if (low === undefined || (((length & 0x3f) << 8) | low) >= message.length)
				return undefined;
			return offset + 2;
		}
		if ((length & 0xc0) !== 0 || offset + 1 + length > message.length)
			return undefined;
		if (length === 0) return offset + 1;
		offset += 1 + length;
	}
}

/**
 * The IN/AAAA records of a response to our fixed discovery query `id`.
 *
 * `undefined` means "not an answer to this question" (wrong id, not a response,
 * an error code, truncated or malformed); an empty list is a valid "no AAAA".
 */
export function parseAaaaResponse(
	message: Uint8Array,
	id: number,
): string[] | undefined {
	if (message.length < 12) return undefined;
	const view = new DataView(
		message.buffer,
		message.byteOffset,
		message.byteLength,
	);
	if (view.getUint16(0) !== id) return undefined;
	const flags = view.getUint16(2);
	if (
		(flags & 0x8000) === 0 ||
		(flags & 0x7800) !== 0 ||
		(flags & 0x0200) !== 0 ||
		(flags & 0x000f) !== 0
	)
		return undefined;
	const questions = view.getUint16(4);
	const answers = view.getUint16(6);

	// Accept only an echo of our fixed discovery question (DNS names ignore case).
	const question = buildIpv4OnlyArpaQuery(id).subarray(12);
	if (questions !== 1 || message.length < 12 + question.length)
		return undefined;
	const fold = (byte: number) =>
		byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
	if (
		question.some(
			(byte, index) => fold(message[12 + index] ?? 0xff) !== fold(byte),
		)
	)
		return undefined;
	let offset: number | undefined = 12 + question.length;
	const addresses: string[] = [];
	for (let index = 0; index < answers; index += 1) {
		offset = skipName(message, offset);
		if (offset === undefined || offset + 10 > message.length) return undefined;
		const type = view.getUint16(offset);
		const length = view.getUint16(offset + 8);
		const data = offset + 10;
		if (data + length > message.length) return undefined;
		if (type === 0x1c && view.getUint16(offset + 2) !== 1) return undefined;
		if (type === 0x1c && length === 16) {
			addresses.push(formatIpv6(message.subarray(data, data + 16)));
		}
		offset = data + length;
	}
	return addresses;
}
