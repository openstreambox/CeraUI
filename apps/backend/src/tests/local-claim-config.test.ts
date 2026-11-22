import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getConfig,
	getLocalClaimDigest,
	loadConfig,
	saveConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	bootRuntimeConfig,
	stopRuntimeConfigRecovery,
} from "../modules/config-boot.ts";
import { notificationRemove } from "../modules/ui/notifications.ts";
import { getPasswordHash, setPasswordHash } from "../rpc/state/password.ts";

// A cost-4 bcrypt digest; the boot step only checks its shape.
const HASH = "$2b$04$C6UzMDM.H6dfI/f/IKxGhuRk2bVv8OkCmJrE2BMjX1MSUb4ki3PLW";
const DIGEST = "ab".repeat(32);

let root: string;
let path: string;
let damaged: string[];
const previousFlag = process.env.CERALIVE_LOCAL_CLAIM;

const deps = {
	sleep: () => Promise.resolve(),
	onDamagedReset: (copy: string) => {
		damaged.push(copy);
	},
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "local-claim-config-"));
	path = join(root, "config.json");
	setConfigFilePath(path);
	damaged = [];
});

afterEach(async () => {
	if (previousFlag === undefined) delete process.env.CERALIVE_LOCAL_CLAIM;
	else process.env.CERALIVE_LOCAL_CLAIM = previousFlag;
	stopRuntimeConfigRecovery();
	setPasswordHash(undefined);
	notificationRemove("config_damaged_reset");
	writeFileSync(path, "{}");
	await loadConfig();
	setConfigFilePath("config.json");
	rmSync(root, { recursive: true, force: true });
});

const malformed: unknown[] = ["invalid", "AB".repeat(32), 42, { x: 1 }, null];

for (const flag of ["0", "1"]) {
	test.each(malformed)(
		`flag ${flag}: a malformed claim digest %p never resets an owned config`,
		async (digest) => {
			process.env.CERALIVE_LOCAL_CLAIM = flag;
			writeFileSync(
				path,
				JSON.stringify({
					password_hash: HASH,
					max_br: 9000,
					local_claim_digest: digest,
				}),
			);
			expect(await bootRuntimeConfig(deps)).toBe("loaded");
			expect(damaged).toEqual([]);
			expect(readdirSync(root).filter((n) => n.includes(".damaged-"))).toEqual(
				[],
			);
			expect(getConfig().max_br).toBe(9000);
			expect(getPasswordHash()).toBe(HASH);
			expect(getLocalClaimDigest()).toBeUndefined();
		},
	);

	test.each(malformed)(
		`flag ${flag}: a malformed claim digest %p on a fresh box keeps settings and withholds the claim`,
		async (digest) => {
			process.env.CERALIVE_LOCAL_CLAIM = flag;
			writeFileSync(
				path,
				JSON.stringify({ max_br: 9000, local_claim_digest: digest }),
			);
			expect(await bootRuntimeConfig(deps)).toBe("loaded");
			expect(damaged).toEqual([]);
			expect(getConfig().max_br).toBe(9000);
			expect(getLocalClaimDigest()).toBeUndefined();
		},
	);
}

test("a valid digest loads only while no owner hash exists", async () => {
	writeFileSync(path, JSON.stringify({ local_claim_digest: DIGEST }));
	await loadConfig();
	expect(getLocalClaimDigest()).toBe(DIGEST);
	expect(getConfig()).not.toHaveProperty("local_claim_digest");

	writeFileSync(
		path,
		JSON.stringify({ password_hash: HASH, local_claim_digest: DIGEST }),
	);
	await loadConfig();
	expect(getLocalClaimDigest()).toBeUndefined();
});

test("an unrelated save keeps a valid digest on a fresh box", async () => {
	writeFileSync(path, JSON.stringify({ local_claim_digest: DIGEST }));
	await loadConfig();
	getConfig().max_br = 7000;
	saveConfig();
	const saved = JSON.parse(readFileSync(path, "utf8"));
	expect(saved.local_claim_digest).toBe(DIGEST);
	expect(saved.max_br).toBe(7000);
});

test("every owner hash write removes the claim digest", async () => {
	writeFileSync(path, JSON.stringify({ local_claim_digest: DIGEST }));
	await loadConfig();
	setPasswordHash(HASH);
	saveConfig();
	expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty(
		"local_claim_digest",
	);
	expect(getLocalClaimDigest()).toBeUndefined();

	// Losing the owner hash later must not revive the spent code in memory.
	setPasswordHash(undefined);
	expect(getLocalClaimDigest()).toBeUndefined();
	saveConfig();
	expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty(
		"local_claim_digest",
	);
});

test("a digest beside an owner hash on disk is dropped by the next save", async () => {
	writeFileSync(
		path,
		JSON.stringify({ password_hash: HASH, local_claim_digest: DIGEST }),
	);
	await loadConfig();
	saveConfig();
	expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty(
		"local_claim_digest",
	);
});
