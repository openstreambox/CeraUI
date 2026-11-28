import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFileJournalStore,
	emptyJournal,
} from "./network-change-journal.ts";

const dirs: string[] = [];
function scratch() {
	const dir = mkdtempSync(join(tmpdir(), "network-change-journal-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("network-change journal file", () => {
	it("starts empty, writes privately and atomically, and reads back", async () => {
		const dir = join(scratch(), "state");
		const store = createFileJournalStore(join(dir, "network-change.json"));
		expect(await store.read()).toEqual(emptyJournal());
		const journal = emptyJournal();
		journal.notice = {
			id: "n1",
			reason: "restart",
			createdAt: 1,
			plan: {
				summary: { key: "k" },
				devices: ["eth0"],
				profiles: [],
				effects: [],
			},
		};
		await store.write(journal);
		expect(await store.read()).toEqual(journal);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, "network-change.json")).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir)).toEqual(["network-change.json"]);
	});
	it("refuses a damaged record instead of forgetting a recorded undo", async () => {
		const dir = scratch();
		const path = join(dir, "network-change.json");
		writeFileSync(path, '{"version":2}');
		await expect(createFileJournalStore(path).read()).rejects.toThrow(
			"unavailable",
		);
		writeFileSync(path, "{");
		await expect(createFileJournalStore(path).read()).rejects.toThrow(
			"unavailable",
		);
	});
});
