import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "./fixtures/index.js";

// The image checker's line for a lost cluster on the /boot FAT partition.
const LINE =
	"Shared /boot FAT check needs attention: read-only fsck.fat reported filesystem diagnostics (exit 1)\n";
const COPY =
	"The box started normally. Its startup files need a check at the next service visit. Nothing to do now.";
const saved = process.env.CERALIVE_BOOT_FAT_FAULT;
let dir: string;

test.beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "boot-fat-fault-"));
	const marker = join(dir, "boot-fat-fault");
	writeFileSync(marker, LINE);
	// Each worker backend inherits this, so it reads the fixture marker.
	process.env.CERALIVE_BOOT_FAT_FAULT = marker;
});

test.afterAll(() => {
	if (saved === undefined) delete process.env.CERALIVE_BOOT_FAT_FAULT;
	else process.env.CERALIVE_BOOT_FAT_FAULT = saved;
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
	await notice.getByTestId("persistent-notice-dismiss").click();
	await expect(notice).toHaveCount(0);
	// The backend dropped it, so the standing-notice replay an authenticated
	// connection opens with does not bring it back. Wait for that frame first.
	const replay = new Promise<string>((resolve) => {
		page.on("websocket", (socket) => {
			socket.on("framereceived", ({ payload }) => {
				const text = typeof payload === "string" ? payload : payload.toString();
				if (text.includes('"notification"') && text.includes('"replay":true'))
					resolve(text);
			});
		});
	});
	await page.reload();
	expect(await replay).not.toContain("boot-fat-fault");
	await expect(notice).toHaveCount(0);
});
