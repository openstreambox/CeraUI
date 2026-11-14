import { run } from "../../helpers/run.ts";
import { createNetworkCheckpointOwner } from "./network-checkpoint.ts";

const DESTINATION = "org.freedesktop.NetworkManager";
const MANAGER = "/org/freedesktop/NetworkManager";
const CONNECTION = `${DESTINATION}.Settings.Connection`;
export type NmCheckpointRunner = (
	bin: string,
	args: string[],
) => Promise<string>;

/** D-Bus calls use the same bounded argv runner as other system operations. */
export function createNmCheckpointAdapter(runner: NmCheckpointRunner = run) {
	async function call(
		path: string,
		iface: string,
		method: string,
		signature: string,
		args: string[],
	) {
		const output = await runner("busctl", [
			"--system",
			"--json=short",
			"call",
			DESTINATION,
			path,
			iface,
			method,
			...(signature ? [signature, ...args] : []),
		]);
		return output.trim() ? (JSON.parse(output).data as unknown[]) : [];
	}
	return {
		now: () => Date.now(),
		async create(devices: string[], timeout: number) {
			if (
				!devices.length ||
				devices.some(
					(device) => !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,14}$/.test(device),
				) ||
				!Number.isInteger(timeout) ||
				timeout < 1
			)
				throw new Error("Invalid network checkpoint request");
			const paths: string[] = [];
			for (const device of devices) {
				const [path] = await call(
					MANAGER,
					DESTINATION,
					"GetDeviceByIpIface",
					"s",
					[device],
				);
				if (typeof path !== "string")
					throw new Error("Network device unavailable");
				paths.push(path);
			}
			const [path] = await call(
				MANAGER,
				DESTINATION,
				"CheckpointCreate",
				"aouu",
				[String(paths.length), ...paths, String(timeout), "2"],
			);
			if (typeof path !== "string")
				throw new Error("Network checkpoint unavailable");
			return path;
		},
		async live(path: string) {
			const output = await runner("busctl", [
				"--system",
				"--json=short",
				"get-property",
				DESTINATION,
				MANAGER,
				DESTINATION,
				"Checkpoints",
			]);
			const value: unknown = JSON.parse(output).data;
			if (!Array.isArray(value))
				throw new Error("Network checkpoint state unavailable");
			return value.includes(path);
		},
		async destroy(path: string) {
			await call(MANAGER, DESTINATION, "CheckpointDestroy", "o", [path]);
		},
		async rollback(path: string) {
			const [results] = await call(
				MANAGER,
				DESTINATION,
				"CheckpointRollback",
				"o",
				[path],
			);
			if (
				!results ||
				typeof results !== "object" ||
				Object.values(results).some((code) => code !== 0)
			)
				throw new Error("Network rollback incomplete");
		},
		async save(uuid: string) {
			const [path] = await call(
				`${MANAGER}/Settings`,
				`${DESTINATION}.Settings`,
				"GetConnectionByUuid",
				"s",
				[uuid],
			);
			if (typeof path !== "string")
				throw new Error("Network profile unavailable");
			await call(path, CONNECTION, "Save", "", []);
		},
	};
}

export const nmCheckpointAdapter = createNmCheckpointAdapter();
export const networkCheckpointOwner =
	createNetworkCheckpointOwner(nmCheckpointAdapter);
