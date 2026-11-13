import { chmodSync, lstatSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { ingressAdmission } from "../modules/system/button-ingress.ts";
import { createServerWebSocketHandler, initSocketData } from "./adapter.ts";
import type { ServerSocketData } from "./types.ts";

const directory = "/run/ceralive-button-ingress";

/** Image provisioning is opt-in: absence leaves the ordinary password path. */
export function startButtonIngress() {
	let dir: ReturnType<typeof lstatSync>;
	try {
		dir = lstatSync(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	if (
		!dir.isDirectory() ||
		dir.isSymbolicLink() ||
		dir.uid !== 0 ||
		(dir.mode & 0o777) !== 0o700 ||
		process.getuid?.() !== 0
	)
		throw new Error(
			"Button ingress requires a root-owned private runtime directory",
		);
	// Never unlink an existing socket: a second backend must not steal its owner.
	const socket = `${directory}/rpc.sock`;
	try {
		lstatSync(socket);
		throw new Error("Button ingress socket already exists");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const server = serveButtonIngress(socket);
	try {
		chmodSync(`${directory}/rpc.sock`, 0o600);
	} catch (error) {
		server.stop(true);
		throw error;
	}
	return server;
}

/** Separated listener construction for isolated Unix-socket integration tests. */
export function serveButtonIngress(
	socket: string,
	links: () => readonly {
		name: string;
		address: string;
		netmask: string;
	}[] = () =>
		Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
			(addresses ?? []).map((address) => ({ name, ...address })),
		),
) {
	return Bun.serve<ServerSocketData>({
		unix: socket,
		fetch(request, server) {
			if (
				new URL(request.url).pathname !== "/ws" ||
				request.headers.get("upgrade")?.toLowerCase() !== "websocket"
			)
				return new Response("Not found", { status: 404 });
			const check = ingressAdmission(request, links);
			if (!check) return new Response("Direct path required", { status: 403 });
			if (
				server.upgrade(request, {
					data: {
						...initSocketData(),
						buttonLocal: true,
						buttonPathValid: check,
					},
				})
			)
				return;
			return new Response("Upgrade failed", { status: 500 });
		},
		websocket: createServerWebSocketHandler(),
	});
}
