import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";

import { physicalReset } from "../modules/companion/reset.ts";
import { newSetupSecret } from "../modules/companion/setup-link.ts";
import { loadConfig, setConfigFilePath } from "../modules/config.ts";
import type { RPCContext } from "../rpc/types.ts";
import {
	authenticate,
	claimOwner,
	cleanupCompanionDirs,
	makeBox,
	verifierFor,
} from "./helpers/companion-fixture.ts";

afterEach(cleanupCompanionDirs);

describe("physical reset", () => {
	test("locks legacy setup first, then clears legacy credentials, the roster and companion sockets", async () => {
		const box = makeBox();
		const owner = claimOwner(box);
		const steps: string[] = [];
		const result = await physicalReset({
			store: box.store,
			fresh: verifierFor(newSetupSecret()),
			lockLegacySetup: async () => {
				steps.push("lock");
			},
			clearLegacyCredentials: async () => {
				steps.push("legacy");
				return 3;
			},
			closeCompanionSockets: () => {
				steps.push("sockets");
			},
		});
		expect(steps).toEqual(["lock", "legacy", "sockets"]);
		expect(result).toMatchObject({ generation: 2, legacy_revoked: 3 });
		expect(box.store.read().devices).toEqual([]);
		expect(authenticate(box, owner.device).result.status).toBe("refused");
	});

	test("clears nothing when legacy setup cannot be locked", async () => {
		const box = makeBox();
		claimOwner(box);
		let cleared = false;
		await expect(
			physicalReset({
				store: box.store,
				fresh: verifierFor(newSetupSecret()),
				lockLegacySetup: async () => {
					throw Error("no lock");
				},
				clearLegacyCredentials: async () => {
					cleared = true;
					return 0;
				},
				closeCompanionSockets: () => {},
			}),
		).rejects.toThrow("no lock");
		expect(cleared).toBe(false);
		expect(box.store.read().devices).toHaveLength(1);
	});
});

describe("legacy credentials for reset", () => {
	const cwd = process.cwd();
	let root = "";
	afterEach(() => {
		process.chdir(cwd);
		setConfigFilePath("config.json");
		if (root) rmSync(root, { recursive: true, force: true });
	});

	test("forgets the owner password and every remembered session", async () => {
		const token = "remembered-browser";
		const digest = new Bun.CryptoHasher("sha256").update(token).digest("hex");
		root = mkdtempSync(join(tmpdir(), "companion-reset-"));
		const storeDir = join(root, "tokens");
		mkdirSync(storeDir, { mode: 0o700 });
		process.chdir(storeDir);
		writeFileSync("auth_tokens.json", JSON.stringify({ [digest]: true }));
		chmodSync("auth_tokens.json", 0o600);
		writeFileSync(join(root, "config.json"), "{}");
		setConfigFilePath(join(root, "config.json"));
		await loadConfig();
		const auth = await import("../rpc/procedures/auth.procedure.ts?reset=1");
		try {
			auth.setPasswordHash(
				Bun.password.hashSync("correct-password", {
					algorithm: "bcrypt",
					cost: 4,
				}),
			);
			const { saveConfig } = await import("../modules/config.ts");
			saveConfig();
			expect(readFileSync(join(root, "config.json"), "utf8")).toContain(
				"password_hash",
			);
			const revoked = await auth.clearLegacyCredentialsForReset();
			expect(revoked).toBeGreaterThanOrEqual(1);
			expect(auth.getPasswordHash()).toBeUndefined();
			expect(readFileSync(join(root, "config.json"), "utf8")).not.toContain(
				"password_hash",
			);
			const data = { isAuthenticated: false } as Record<string, unknown>;
			const context = {
				ws: { data },
				isAuthenticated: () => data.isAuthenticated === true,
				authenticate: () => {
					data.isAuthenticated = true;
				},
				deauthenticate: () => {
					data.isAuthenticated = false;
				},
				markActive: () => {},
			} as unknown as RPCContext;
			const login = (await call(
				auth.loginProcedure,
				{ token, persistent_token: false },
				{ context },
			)) as { success?: boolean };
			expect(login.success).not.toBe(true);
		} finally {
			auth.stopLegacyTokenMigration();
		}
	});
});
