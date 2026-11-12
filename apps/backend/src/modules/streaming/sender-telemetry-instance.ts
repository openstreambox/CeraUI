import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";

export interface SenderTelemetryInstance {
	readonly statsFile: string;
	readonly controlSocket: string;
}

const instances = new WeakSet<SenderTelemetryInstance>();

/** Strict launches cannot inherit a previous producer's file or control socket.
 * The token is process-local; matching path strings alone are not ownership.
 */
export function createSenderTelemetryInstance(
	statsFile: string,
	controlSocket: string,
): SenderTelemetryInstance {
	const nonce = randomBytes(12).toString("hex"),
		instance = Object.freeze({
			statsFile: `${statsFile}.${nonce}`,
			controlSocket: `${controlSocket}.${nonce}`,
		});
	if (Buffer.byteLength(instance.controlSocket) > 107)
		throw new Error("Sender control socket path is too long");
	instances.add(instance);
	return instance;
}

export function ownsSenderTelemetryInstance(
	instance: SenderTelemetryInstance | undefined,
	statsFile: string,
	controlSocket: string | undefined,
): boolean {
	return (
		!!instance &&
		instances.has(instance) &&
		instance.statsFile === statsFile &&
		instance.controlSocket === controlSocket
	);
}

/** Call only after the captured producer's exit has positively resolved. */
export async function removeSenderTelemetryInstance(
	instance: SenderTelemetryInstance,
): Promise<void> {
	if (!instances.has(instance))
		throw new Error("Unknown sender telemetry instance");
	await Promise.all(
		[instance.statsFile, instance.controlSocket].map(async (path) => {
			try {
				await unlink(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}),
	);
}
