import { spyOn } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { call } from "@orpc/server";
import {
	getConfig,
	getLocalClaimDigest,
	isRuntimeConfigAvailable,
	loadConfig,
} from "../../modules/config.ts";
import {
	awaitRuntimeConfig,
	bootRuntimeConfig,
	stopRuntimeConfigRecovery,
} from "../../modules/config-boot.ts";
import { addClient, createContext } from "../../rpc/context.ts";
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

function socket(senderId?: string) {
	const closes: number[] = [];
	const ws = {
		data: { senderId, isAuthenticated: false, lastActive: 0 },
		close: (code: number) => {
			closes.push(code);
		},
	} as unknown as AppWebSocket;
	return { ws, closes };
}

function context(senderId?: string, ws = socket(senderId).ws) {
	return createContext(ws);
}

const claim = (
	secret = ownerSecret,
	submitted = code,
	senderId?: string,
	ws?: AppWebSocket,
) =>
	call(
		claimLocalOwnerProcedure,
		{ code: submitted, ownerSecret: secret },
		{
			context: context(senderId, ws),
		},
	);

const loginWith = async (password: string) =>
	(await call(loginProcedure, { password }, { context: context() })).success;

const savedConfig = async () =>
	JSON.parse(await Bun.file("config.json").text()) as Record<string, unknown>;

const isConfigTarget = (target: fs.PathLike) =>
	String(target).endsWith("config.json") &&
	!String(target).endsWith("auth_tokens.json");

/** Fail the next durable config publication at the chosen step, once. */
function failConfigWrite(step: "rename" | "directory-fsync" | "unreadable") {
	const rename = fs.renameSync;
	const fsync = fs.fsyncSync;
	let armed = false;
	const renameSpy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
		if (!isConfigTarget(to)) return rename(from, to);
		renameSpy.mockRestore();
		if (step === "rename") {
			throw Object.assign(new Error("injected rename fault"), {
				code: "EIO",
			});
		}
		rename(from, to);
		if (step === "unreadable") {
			fs.chmodSync(to, 0o000);
			throw Object.assign(new Error("injected unreadable fault"), {
				code: "EIO",
			});
		}
		armed = true;
	});
	const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
		if (!armed || !fs.fstatSync(fd).isDirectory()) return fsync(fd);
		fsyncSpy.mockRestore();
		throw Object.assign(new Error("injected directory fsync fault"), {
			code: "EIO",
		});
	});
	return () => {
		renameSpy.mockRestore();
		fsyncSpy.mockRestore();
	};
}

const legacySetPassword = (socket = context()) =>
	call(
		setPasswordProcedure,
		{ password: "regular-password" },
		{ context: socket },
	);

const scenario = process.argv[2];
if (scenario === "restart-verify") {
	// A fresh process boots from whatever the previous one left on disk.
	assert.equal(await bootRuntimeConfig(), "loaded");
	assert.equal(getConfig().max_br, 9000);
	assert.equal(getLocalClaimDigest(), undefined);
	assert.ok(getPasswordHash());
	assert.ok(!("local_claim_digest" in (await savedConfig())));
	assert.equal((await claim(alternateSecret)).success, false);
	assert.equal(await loginWith(alternateSecret), false);
	assert.equal(await loginWith(ownerSecret), true);
	process.exit(0);
}
await Bun.write(
	"config.json",
	JSON.stringify(
		scenario === "unavailable"
			? {}
			: { local_claim_digest: digest(code), max_br: 9000 },
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
	case "pre-rename": {
		// The old file stays authoritative: the code is not spent and config
		// writes are not frozen.
		const restore = failConfigWrite("rename");
		assert.equal((await claim()).success, false);
		restore();
		assert.ok(isRuntimeConfigAvailable());
		assert.equal(getPasswordHash(), undefined);
		assert.equal((await savedConfig()).local_claim_digest, digest(code));
		assert.equal(await loginWith(ownerSecret), false);
		assert.equal((await claim(alternateSecret)).success, true);
		assert.equal(await loginWith(alternateSecret), true);
		break;
	}
	case "post-rename": {
		// The new file landed before the fault, so the claim did commit.
		const restore = failConfigWrite("directory-fsync");
		assert.equal((await claim()).success, true);
		restore();
		assert.ok(isRuntimeConfigAvailable());
		assert.equal(getLocalClaimDigest(), undefined);
		assert.ok(!("local_claim_digest" in (await savedConfig())));
		assert.equal((await savedConfig()).max_br, 9000);
		assert.equal(await loginWith(ownerSecret), true);
		assert.equal((await claim(alternateSecret)).success, false);
		break;
	}
	case "unreadable-after-failure": {
		// Unknown on-disk state: refuse, then let the recovery owner settle it
		// without a restart.
		const restore = failConfigWrite("unreadable");
		await assert.rejects(claim());
		restore();
		assert.equal(isRuntimeConfigAvailable(), false);
		assert.equal(getPasswordHash(), undefined);
		assert.equal((await claim(alternateSecret)).success, false);
		fs.chmodSync("config.json", 0o600);
		await awaitRuntimeConfig();
		stopRuntimeConfigRecovery();
		assert.ok(isRuntimeConfigAvailable());
		assert.equal(getLocalClaimDigest(), undefined);
		assert.equal(await loginWith(ownerSecret), true);
		assert.equal(await loginWith(alternateSecret), false);
		break;
	}
	case "restart-claim":
		assert.equal((await claim()).success, true);
		break;
	case "restart-post-rename": {
		const restore = failConfigWrite("directory-fsync");
		assert.equal((await claim()).success, true);
		restore();
		break;
	}
	case "stale-peers": {
		// Other pre-claim pages reconnect into the normal sign-in view.
		const caller = socket();
		const stale = socket();
		const owner = socket();
		owner.ws.data.isAuthenticated = true;
		owner.ws.data.authToken = "unrelated";
		const relay = socket("relay");
		for (const peer of [caller, stale, owner, relay]) addClient(peer.ws);
		assert.equal(
			(await claim(ownerSecret, code, undefined, caller.ws)).success,
			true,
		);
		assert.deepEqual(caller.closes, []);
		assert.deepEqual(stale.closes, [1012]);
		break;
	}
	default:
		throw new Error("Unknown local claim fixture");
}
