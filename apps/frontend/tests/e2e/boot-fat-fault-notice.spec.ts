import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "./fixtures/index.js";

// The image checker's line for a lost cluster on the /boot FAT partition.
const LINE =
	"Shared /boot FAT check needs attention: read-only fsck.fat reported filesystem diagnostics (exit 1)\n";
const COPY =
	"The box started normally. Its startup files need a check at the next service visit. Nothing to do now.";
const saved = {
	marker: process.env.CERALIVE_BOOT_FAT_FAULT,
	dismissals: process.env.CERALIVE_DISMISSALS_FILE,
};
const evidence = process.env.BOOT_FAT_FAULT_SCREENSHOTS;
let dir: string;

function restore(name: string, value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

test.beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "boot-fat-fault-"));
	const marker = join(dir, "boot-fat-fault");
	writeFileSync(marker, LINE);
	// Each worker backend inherits these, so it reads the fixture marker and
	// keeps its dismissal away from the host's own store.
	process.env.CERALIVE_BOOT_FAT_FAULT = marker;
	process.env.CERALIVE_DISMISSALS_FILE = join(dir, "dismissals.json");
});

test.afterAll(() => {
	restore("CERALIVE_BOOT_FAT_FAULT", saved.marker);
	restore("CERALIVE_DISMISSALS_FILE", saved.dismissals);
	rmSync(dir, { recursive: true, force: true });
});

test("a /boot FAT fault marker shows one calm, dismissable notice", async ({
	authedPage: page,
}) => {
	const notice = page
		.getByTestId("persistent-notice")
		.and(page.locator('[data-notification="boot-fat-fault"]'));
	await expect(notice).toHaveText(COPY, { timeout: 30_000 });
	await expect(notice).toHaveAttribute("data-notification-type", "warning");
	if (evidence) {
		mkdirSync(evidence, { recursive: true });
		for (const width of [390, 1280]) {
			await page.setViewportSize({ width, height: width < 600 ? 844 : 800 });
			await page.screenshot({ path: join(evidence, `boot-fat-fault-${width}.png`) });
		}
	}
	await notice.getByTestId("persistent-notice-dismiss").click();
	await expect(notice).toHaveCount(0);
	// The dismissal is held for this boot only: its key names the boot ID.
	await expect
		.poll(() => {
			try {
				return readFileSync(join(dir, "dismissals.json"), "utf8");
			} catch {
				return "";
			}
		})
		.toMatch(/"boot-fat-fault:[0-9a-f]{32}"/);
});
