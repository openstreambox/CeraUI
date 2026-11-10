import type { DbusTransport } from "@ceralive/modem-control/transport";
import { createSystemPortalReaderDeps } from "../../wifi/captive-portal-readers.ts";

/** Include the bus generation and NM's unique owner, so a reused activation
 * object path after either daemon restarts cannot reuse a proof epoch. */
export async function readNmEpoch(signal: AbortSignal): Promise<string> {
	const transport = await createSystemPortalReaderDeps().createTransport();
	return captureNmEpoch(transport, signal);
}
export async function captureNmEpoch(
	transport: Pick<DbusTransport, "connect" | "disconnect" | "callMethod">,
	signal: AbortSignal,
): Promise<string> {
	let closed = false;
	const bounded = async <T>(
		work: Promise<T>,
		lateClose = false,
	): Promise<T> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort: () => void = () => undefined;
		try {
			return await Promise.race([
				work,
				new Promise<never>((_, reject) => {
					abort = () => reject(new Error("NM epoch canceled"));
					signal.addEventListener("abort", abort, { once: true });
					if (signal.aborted) abort();
					timer = setTimeout(
						() => reject(new Error("NM epoch deadline")),
						1000,
					);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			void work.then(
				() => {
					if (closed && lateClose)
						void transport.disconnect().catch(() => undefined);
				},
				() => undefined,
			);
		}
	};
	try {
		await bounded(transport.connect(), true);
		const call = async (member: string, args?: string[]) => {
			signal.throwIfAborted();
			const reply = await bounded(
				transport.callMethod({
					destination: "org.freedesktop.DBus",
					path: "/org/freedesktop/DBus",
					interface: "org.freedesktop.DBus",
					member,
					...(args ? { signature: "s", args } : {}),
					timeoutMs: 500,
				}),
			);
			if (
				reply.signature !== "s" ||
				reply.body.length !== 1 ||
				typeof reply.body[0] !== "string"
			)
				throw new Error("NM epoch reply unavailable");
			return reply.body[0];
		};
		const bus = await call("GetId"),
			owner = await call("GetNameOwner", ["org.freedesktop.NetworkManager"]);
		if (
			!/^[a-f0-9]{32}$/.test(bus) ||
			!/^:\d+\.\d+$/.test(owner) ||
			bus !== (await call("GetId"))
		)
			throw new Error("NM epoch changed");
		return `${bus}|${owner}`;
	} finally {
		closed = true;
		// No mutation calls exist on this transport; late read completions are discarded.
		await bounded(transport.disconnect()).catch(() => undefined);
	}
}
