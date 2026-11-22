import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseCompanionWifiInput } from "../src/modules/wifi/companion-wifi-input.ts";

class ImportError extends Error {}

function rpc(socket: WebSocket, path: string[], input: unknown) {
	const id = crypto.randomUUID();
	return new Promise<Record<string, unknown>>((resolve, reject) => {
		const finish = (result?: Record<string, unknown>) => {
			clearTimeout(timer);
			socket.removeEventListener("message", onMessage);
			if (result) resolve(result);
			else reject(Error("Request failed or timed out"));
		};
		const onMessage = ({ data }: MessageEvent) => {
			try {
				const response = JSON.parse(String(data));
				if (response.id === id) finish(response.result);
				if (response.type === "ping")
					socket.send(JSON.stringify({ pong: true }));
			} catch {
				finish();
			}
		};
		const timer = setTimeout(finish, 8000);
		socket.addEventListener("message", onMessage);
		socket.send(JSON.stringify({ id, path, input }));
	});
}

async function main() {
	const url = new URL(process.argv[2] ?? "ws://127.0.0.1:8080/ws");
	if (
		url.protocol !== "ws:" ||
		!["127.0.0.1", "[::1]"].includes(url.hostname) ||
		url.pathname !== "/ws" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new ImportError(
			"Use a loopback /ws URL, with SSH forwarding for a remote box.",
		);
	}
	if (process.stdin.isTTY)
		throw new ImportError(
			"Provide the request on stdin from a private source.",
		);
	const { token, ...candidate } = JSON.parse(await Bun.stdin.text());
	if (typeof token !== "string" || !token)
		throw new ImportError("A CeraUI session token is required.");
	const input = { ...candidate, consent: true };
	const network = parseCompanionWifiInput(input);
	if (!network)
		throw new ImportError("The network or Wi-Fi QR is unsupported or invalid.");

	const tty = createReadStream("/dev/tty");
	const output = createWriteStream("/dev/tty");
	const prompt = createInterface({ input: tty, output });
	try {
		const answer = await prompt.question(
			`Save ${JSON.stringify(network.ssid)} (${network.security}) on the box? [y/N] `,
		);
		if (answer.toLowerCase() !== "y") return;
	} finally {
		prompt.close();
		tty.destroy();
		output.end();
	}

	const socket = new WebSocket(url);
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(Error()), 5000);
			socket.addEventListener(
				"open",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
			socket.addEventListener(
				"error",
				() => {
					clearTimeout(timer);
					reject(Error());
				},
				{ once: true },
			);
		});
		const auth = await rpc(socket, ["auth", "login"], { token });
		if (auth.success !== true) throw new ImportError("CeraUI login failed.");
		const result = await rpc(socket, ["wifi", "addFromCompanion"], input);
		switch (result.status) {
			case "saved":
				console.log("Network saved. Select it in CeraUI to join.");
				break;
			case "disabled":
				throw new ImportError("Companion Wi-Fi import is disabled.");
			case "local_only":
				throw new ImportError(
					"Companion Wi-Fi import requires direct loopback access.",
				);
			default:
				throw new ImportError(
					"Network could not be saved. Check CeraUI before retrying.",
				);
		}
	} finally {
		socket.close();
	}
}

// Never let an exception from parsing, transport or NetworkManager print input.
try {
	await main();
} catch (error) {
	console.error(
		error instanceof ImportError
			? error.message
			: "Wi-Fi import failed. Check the request, session and box configuration.",
	);
	process.exitCode = 1;
}
