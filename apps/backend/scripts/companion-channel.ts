/**
 * Companion stub for the experimental paired channel (`osb-companion/1`).
 *
 *   bun scripts/companion-channel.ts pair    <url> --state <dir>   # setup link on stdin
 *   bun scripts/companion-channel.ts devices <url> --state <dir>
 *   bun scripts/companion-channel.ts invite  <url> --state <dir>   # prints a join link
 *   bun scripts/companion-channel.ts join    <url> --state <dir>   # join link on stdin
 *   bun scripts/companion-channel.ts revoke  <url> --state <dir> <device-id>
 *   bun scripts/companion-channel.ts wifi    <url> --state <dir>   # network JSON on stdin
 *
 * `<url>` is `wss://<box>/ws` through the image's front door, or
 * `ws://127.0.0.1:<port>/ws` on a development box without it. The state
 * directory stands in for a platform key store: `device.key` (P-256, 0600)
 * and `box.json` (the pinned box fingerprint, generation and access
 * sequence). Secrets come from stdin, never from arguments.
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
	closeSync,
	createReadStream,
	createWriteStream,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import {
	buildAuth,
	buildClaim,
	buildJoin,
	CompanionClientError,
	type DeviceKey,
	newClientNonce,
	verifyHello,
} from "../src/modules/companion/client.ts";
import { generateP256, spkiOf } from "../src/modules/companion/keys.ts";
import {
	formatJoinLink,
	parseJoinLink,
	parseSetupLink,
} from "../src/modules/companion/setup-link.ts";
import {
	type CompanionConnection,
	connectCompanion,
} from "../src/modules/companion/stub-transport.ts";
import { keyFingerprint } from "../src/modules/companion/transcript.ts";
import {
	companionConsentPrompt,
	parseCompanionWifiInput,
} from "../src/modules/wifi/companion-wifi-input.ts";

class StubError extends Error {}

interface PinnedBox {
	fingerprint: string;
	generation: number;
	access_seq: number;
	device: string;
}

function writePrivate(path: string, text: string, exclusive = false) {
	const temp = exclusive ? path : `${path}.tmp`;
	const fd = openSync(temp, exclusive ? "wx" : "w", 0o600);
	try {
		writeFileSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	if (!exclusive) renameSync(temp, path);
}

function loadDevice(state: string, create: boolean): DeviceKey {
	const path = join(state, "device.key");
	try {
		const privateKey = createPrivateKey(readFileSync(path, "utf8"));
		return { privateKey, publicKey: spkiOf(createPublicKey(privateKey)) };
	} catch (error) {
		if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT")
			throw new StubError("No usable device key in the state directory.");
	}
	// Saved before the claim is sent, so a lost reply never strands it.
	const made = generateP256();
	writePrivate(
		path,
		String(made.privateKey.export({ type: "pkcs8", format: "pem" })),
		true,
	);
	return made;
}

function loadPin(state: string): PinnedBox {
	try {
		return JSON.parse(readFileSync(join(state, "box.json"), "utf8"));
	} catch {
		throw new StubError("This state directory is not paired with a box.");
	}
}

function savePin(state: string, pin: PinnedBox) {
	writePrivate(join(state, "box.json"), `${JSON.stringify(pin, null, 2)}\n`);
}

async function hello(
	connection: CompanionConnection,
	expect: Omit<
		Parameters<typeof verifyHello>[1],
		"clientNonce" | "observedBinding"
	>,
) {
	const clientNonce = newClientNonce();
	const reply = await connection.rpc(["companion", "hello"], {
		client_nonce: clientNonce.toString("base64"),
	});
	return verifyHello(reply, {
		clientNonce,
		observedBinding: connection.binding,
		...expect,
	});
}

/** Connect, check the pinned box and sign in with the device key. */
async function signIn(url: URL, state: string) {
	const pin = loadPin(state);
	const device = loadDevice(state, false);
	const connection = await connectCompanion(url);
	try {
		const verified = await hello(connection, {
			fingerprint: pin.fingerprint,
			minGeneration: pin.generation,
			minAccessSeq: pin.access_seq,
		});
		const result = (await connection.rpc(
			["companion", "auth"],
			buildAuth(verified, device),
		)) as { status?: string };
		if (result?.status !== "ok")
			throw new StubError(`The box refused this device (${result?.status}).`);
		savePin(state, {
			...pin,
			generation: verified.reply.generation,
			access_seq: verified.reply.access_seq,
		});
		return { connection, device, pin };
	} catch (error) {
		connection.close();
		throw error;
	}
}

async function stdinText(): Promise<string> {
	if (process.stdin.isTTY)
		throw new StubError("Provide the input on stdin from a private source.");
	return (await Bun.stdin.text()).trim();
}

async function pair(url: URL, state: string) {
	const setup = parseSetupLink(await stdinText());
	if (!setup) throw new StubError("That is not a box setup link.");
	const device = loadDevice(state, true);
	const connection = await connectCompanion(url);
	try {
		const verified = await hello(connection, {
			setup,
			...(setup.fingerprint ? { fingerprint: setup.fingerprint } : {}),
		});
		// Pinned before the claim is sent: if the reply is lost, `devices`
		// signs in and shows whether the claim committed.
		savePin(state, {
			fingerprint: verified.identityFingerprint,
			generation: verified.reply.generation,
			access_seq: verified.reply.access_seq,
			device: keyFingerprint(device.publicKey),
		});
		const result = (await connection.rpc(
			["companion", "claim"],
			buildClaim(verified, setup, device, "Companion stub", "pc"),
		)) as { status?: string };
		if (result?.status !== "ok")
			throw new StubError(`The box refused setup (${result?.status}).`);
		console.log(
			`Box claimed. Box fingerprint ${verified.identityFingerprint.slice(0, 16)}.`,
		);
	} finally {
		connection.close();
	}
}

async function joinBox(url: URL, state: string) {
	const link = parseJoinLink(await stdinText());
	if (!link) throw new StubError("That is not a box invite link.");
	const device = loadDevice(state, true);
	const connection = await connectCompanion(url);
	try {
		const verified = await hello(connection, { fingerprint: link.fingerprint });
		savePin(state, {
			fingerprint: verified.identityFingerprint,
			generation: verified.reply.generation,
			access_seq: verified.reply.access_seq,
			device: keyFingerprint(device.publicKey),
		});
		const result = (await connection.rpc(
			["companion", "join"],
			buildJoin(verified, link.ticket, device, "Companion stub", "pc"),
		)) as { status?: string };
		if (result?.status !== "ok")
			throw new StubError(`The box refused the invite (${result?.status}).`);
		console.log("Joined the box.");
	} finally {
		connection.close();
	}
}

async function confirmNetwork(input: unknown, url: URL) {
	const network = parseCompanionWifiInput(input);
	if (!network)
		throw new StubError("The network or Wi-Fi QR is unsupported or invalid.");
	const tty = createReadStream("/dev/tty");
	const output = createWriteStream("/dev/tty");
	const prompt = createInterface({ input: tty, output });
	try {
		const answer = await prompt.question(companionConsentPrompt(network, url));
		return answer.toLowerCase() === "y";
	} finally {
		prompt.close();
		tty.destroy();
		output.end();
	}
}

async function main() {
	const [command, endpoint, ...rest] = process.argv.slice(2);
	const stateIndex = rest.indexOf("--state");
	const state = stateIndex >= 0 ? rest[stateIndex + 1] : undefined;
	const extra = rest.filter((_, i) => i !== stateIndex && i !== stateIndex + 1);
	if (!command || !endpoint || !state)
		throw new StubError(
			"Usage: companion-channel.ts <pair|join|devices|invite|revoke|wifi> <url> --state <dir> [device-id]",
		);
	const url = new URL(endpoint);
	mkdirSync(state, { recursive: true, mode: 0o700 });
	if (command === "pair") return pair(url, state);
	if (command === "join") return joinBox(url, state);

	let input: unknown;
	if (command === "wifi") {
		input = { ...JSON.parse(await stdinText()), consent: true };
		if (!(await confirmNetwork(input, url))) return;
	}
	const { connection, pin } = await signIn(url, state);
	try {
		if (command === "devices") {
			console.log(
				JSON.stringify(
					await connection.rpc(["companion", "devices"], {}),
					null,
					2,
				),
			);
		} else if (command === "invite") {
			const result = (await connection.rpc(["companion", "invite"], {})) as {
				status?: string;
				ticket?: string;
				fingerprint?: string;
			};
			if (result?.status !== "ok" || !result.ticket || !result.fingerprint)
				throw new StubError(`No invite (${result?.status}).`);
			if (result.fingerprint !== pin.fingerprint)
				throw new StubError("The invite names a different box.");
			console.log(
				formatJoinLink({
					fingerprint: result.fingerprint,
					ticket: Buffer.from(result.ticket, "base64"),
				}),
			);
		} else if (command === "revoke") {
			const result = (await connection.rpc(["companion", "revoke"], {
				device: extra[0],
			})) as { status?: string };
			if (result?.status !== "ok")
				throw new StubError(`The box did not revoke it (${result?.status}).`);
			console.log(`Revoked ${extra[0]}.`);
		} else if (command === "wifi") {
			const result = (await connection.rpc(
				["companion", "wifiImport"],
				input,
			)) as { status?: string };
			if (result?.status === "saved")
				console.log("Network saved. Select it in CeraUI to join.");
			else throw new StubError(`Network not saved (${result?.status}).`);
		} else {
			throw new StubError(`Unknown command ${command}.`);
		}
	} finally {
		connection.close();
	}
}

// Never print input: parsing, transport and box errors are summarized.
try {
	await main();
} catch (error) {
	console.error(
		error instanceof StubError || error instanceof CompanionClientError
			? error.message
			: "The companion stub failed. Check the URL, the state directory and the box.",
	);
	process.exitCode = 1;
}
