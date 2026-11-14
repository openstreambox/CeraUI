import { inspect } from "node:util";

/** Common diagnostic encodings of a retained credential, longest first. */
export function secretVariants(value: string): string[] {
	const variants = new Set([value, inspect(value).slice(1, -1)]);
	const uri = encodeURIComponent(value);
	const strict = uri.replace(
		/[!'()~*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	const form = new URLSearchParams({ value }).toString().slice(6);
	for (const encoded of [uri, strict, form]) {
		variants.add(encoded);
		variants.add(encoded.replace(/%[A-F0-9]{2}/g, (hex) => hex.toLowerCase()));
		variants.add(encodeURIComponent(encoded));
		variants.add(
			encodeURIComponent(encoded).replace(/%[A-F0-9]{2}/g, (hex) =>
				hex.toLowerCase(),
			),
		);
	}
	let escaped = value;
	for (let level = 0; level < 4; level++) {
		escaped = JSON.stringify(escaped).slice(1, -1);
		variants.add(escaped);
	}
	return [...variants].sort((a, b) => b.length - a.length);
}
