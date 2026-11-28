import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "./fixtures/index.js";

const stableKey = "usb:test-modem";
const slot = createHash("sha256").update(stableKey).digest("hex");
const previous = process.env.CERALIVE_MODEM_MUTATION_DIR;
let journal: string;

test.beforeAll(() => {
	journal = mkdtempSync(join(tmpdir(), "modem-warning-"));
	writeFileSync(join(journal, slot + ".json"), "{damaged");
	process.env.CERALIVE_MODEM_MUTATION_DIR = journal;
});

test.afterAll(() => {
	if (previous === undefined) delete process.env.CERALIVE_MODEM_MUTATION_DIR;
	else process.env.CERALIVE_MODEM_MUTATION_DIR = previous;
	rmSync(journal, { recursive: true, force: true });
});

test("repair withdraws the open modem recovery dialog without a clear request", async ({
	authedPage: page,
}) => {
	const warning = page
		.getByTestId("persistent-notice")
		.and(page.locator('[data-notification="modem_recovery_record"]'));
	await expect(warning).toContainText(slot.slice(0, 8), { timeout: 30_000 });
	await warning.getByRole("button", { name: "Review recovery record" }).click();
	const dialog = page.getByRole("alertdialog");
	await expect(dialog).toBeVisible();

	const repaired = join(journal, "repaired.tmp");
	writeFileSync(
		repaired,
		JSON.stringify({
			version: 1,
			stableKey,
			kind: "usb-mode",
			state: "completed",
			attemptId: "test-attempt",
			startedAt: 1,
			updatedAt: 2,
			preState: {
				vidPid: "2c7c:0801",
				model: "fixture",
				firmwareRevision: "one",
				mode: "qmi",
			},
			history: [{ state: "completed", at: 2 }],
		}),
	);
	renameSync(repaired, join(journal, slot + ".json"));

	await expect(warning).toHaveCount(0, { timeout: 30_000 });
	await expect(dialog).toHaveCount(0);
	expect(readdirSync(journal)).toEqual([]);
});
