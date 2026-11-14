import { createInterface } from "node:readline";
import {
	LinkFamilySelector,
	validateClatSnapshot,
} from "../../../modules/streaming/link-family.ts";

const selector = new LinkFamilySelector();
for await (const line of createInterface({ input: process.stdin })) {
	const input = JSON.parse(line);
	if (input.reset) selector.reset();
	const clat = validateClatSnapshot(
		input.snapshot,
		"wan0",
		input.index,
		Date.now() / 1000,
		input.active,
		input.tunExists,
	);
	const path = selector.choose(
		"wan0",
		input.source,
		input.receiver,
		clat,
		Date.now(),
	);
	process.stdout.write(`${JSON.stringify(path ?? null)}\n`);
}
