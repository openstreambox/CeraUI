import assert from "node:assert/strict";
import { call } from "@orpc/server";
import {
	getConfig,
	getLocalClaimDigest,
	loadConfig,
	setConfigFilePath,
} from "../../modules/config.ts";
import { createContext } from "../../rpc/context.ts";
import {
	claimLocalOwnerProcedure,
	loginProcedure,
	setPasswordProcedure,
} from "../../rpc/procedures/auth.procedure.ts";
import { getPasswordHash, setPasswordHash } from "../../rpc/state/password.ts";
import type { AppWebSocket } from "../../rpc/types.ts";

const code = "abcd".repeat(8);
const ownerSecret = "12345678".repeat(8);
const alternateSecret = "98765432".repeat(8);
const oldToken = "old-test-token";
const digest = (value: string) =>
	new Bun.CryptoHasher("sha256").update(value).digest("hex");

function context(senderId?: string) {
	return createContext({
		data: { senderId, isAuthenticated: false, lastActive: 0 },
	} as AppWebSocket);
}

const claim = (secret = ownerSecret, submitted = code, senderId?: string) =>
	call(
		claimLocalOwnerProcedure,
		{ code: submitted, ownerSecret: secret },
		{
			context: context(senderId),
		},
	);

const legacySetPassword = (socket = context()) =>
	call(
		setPasswordProcedure,
		{ password: "regular-password" },
		{ context: socket },
	);

const scenario = process.argv[2];
await Bun.write(
	"config.json",
	JSON.stringify(
		scenario === "unavailable" ? {} : { local_claim_digest: digest(code) },
	),
);
await loadConfig();
assert.equal(getConfig().local_claim_digest, undefined);

switch (scenario) {
	case "legacy": {
		assert.equal((await claim()).success, false);
		assert.equal((await legacySetPassword()).success, true);
		// Legacy setup spends a seeded code on disk, not only in memory.
		const saved = JSON.parse(await Bun.file("config.json").text());
		assert.ok(saved.password_hash);
		assert.ok(!("local_claim_digest" in saved));
		// Even after the owner hash is lost, the old code never claims again.
		delete saved.password_hash;
		await Bun.write("config.json", JSON.stringify(saved));
		setPasswordHash(undefined);
		process.env.CERALIVE_LOCAL_CLAIM = "1";
		await loadConfig();
		assert.equal(getLocalClaimDigest(), undefined);
		assert.equal((await claim()).success, false);
		assert.equal(getPasswordHash(), undefined);
		break;
	}
	case "unavailable":
		assert.equal((await claim()).success, false);
		assert.equal((await legacySetPassword()).success, false);
		// A malformed verifier withholds setup but keeps the rest of the config.
		await Bun.write(
			"config.json",
			'{"local_claim_digest":"invalid","max_br":9000}',
		);
		await loadConfig();
		assert.equal(getConfig().max_br, 9000);
		assert.equal(getLocalClaimDigest(), undefined);
		assert.equal((await claim()).success, false);
		assert.equal((await legacySetPassword()).success, false);
		assert.equal(getPasswordHash(), undefined);
		break;
	case "competing": {
		await Bun.write(
			"auth_tokens.json",
			JSON.stringify({ [digest(oldToken)]: true }),
		);
		assert.equal((await legacySetPassword()).success, false);
		const initiallyAuthenticated = context();
		initiallyAuthenticated.authenticate();
		assert.equal(
			(await legacySetPassword(initiallyAuthenticated)).success,
			false,
		);
		assert.equal((await claim(ownerSecret, "0".repeat(32))).success, false);
		assert.equal((await claim(ownerSecret, code, "relay")).success, false);
		await assert.rejects(claim(ownerSecret, `${code}\n`));
		const [first, second] = await Promise.all([
			claim(),
			claim(alternateSecret),
		]);
		assert.notEqual(first.success, second.success);
		const saved = await Bun.file("config.json").text();
		assert.ok(!saved.includes("local_claim_digest"));
		assert.ok(!saved.includes(ownerSecret));
		assert.ok(!saved.includes(alternateSecret));
		setPasswordHash(undefined);
		await loadConfig();
		assert.equal(getLocalClaimDigest(), undefined);
		assert.equal((await claim()).success, false);
		assert.equal(
			(
				await call(
					loginProcedure,
					{
						token: oldToken,
					},
					{ context: context() },
				)
			).success,
			false,
		);
		const owner = context();
		assert.equal(
			(
				await call(
					loginProcedure,
					{
						password: first.success ? ownerSecret : alternateSecret,
					},
					{ context: owner },
				)
			).success,
			true,
		);
		assert.equal((await legacySetPassword()).success, false);
		assert.equal((await legacySetPassword(owner)).success, true);
		break;
	}
	case "write-failure":
		setConfigFilePath("missing/config.json");
		await assert.rejects(claim);
		assert.equal(getPasswordHash(), undefined);
		assert.equal((await claim()).success, false);
		setConfigFilePath("config.json");
		await loadConfig();
		assert.equal((await claim()).success, true);
		break;
	default:
		throw new Error("Unknown local claim fixture");
}
