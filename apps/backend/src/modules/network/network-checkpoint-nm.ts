import { run } from "../../helpers/run.ts";

const DESTINATION = "org.freedesktop.NetworkManager";
const MANAGER = "/org/freedesktop/NetworkManager";
const CONNECTION = `${DESTINATION}.Settings.Connection`;
export type NmCheckpointRunner = (
	bin: string,
	args: string[],
) => Promise<string>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,14}$/;
const PROPERTY = /^[a-z0-9-]+\.[a-z0-9-]+$/;
const CHECKPOINT_PATH =
	/^\/org\/freedesktop\/NetworkManager\/Checkpoint\/[0-9]{1,10}$/;
const OWNED_NAME = /^ceralive-(candidate|backup)-[0-9a-f]{8}-[0-9]{1,3}$/;

function uuid(value: string) {
	if (!UUID.test(value)) throw new Error("Invalid network profile");
	return value;
}
function device(value: string) {
	if (!DEVICE.test(value)) throw new Error("Invalid network device");
	return value;
}

/** nmcli terse output escapes ':' and '\\'. */
export function unescapeTerse(value: string) {
	return value.replace(/\\(.)/g, "$1");
}

/** Split one terse line at unescaped colons. */
export function splitTerse(line: string) {
	const fields: string[] = [];
	let current = "";
	for (let i = 0; i < line.length; i++) {
		const char = line[i] as string;
		if (char === "\\" && i + 1 < line.length) {
			current += line[i + 1];
			i++;
		} else if (char === ":") {
			fields.push(current);
			current = "";
		} else current += char;
	}
	fields.push(current);
	return fields;
}

/** D-Bus calls use the same bounded argv runner as other system operations. */
export function createNmCheckpointAdapter(runner: NmCheckpointRunner = run) {
	const nmcli = (...args: string[]) => runner("nmcli", args);
	async function profiles() {
		const output = await nmcli("-t", "-f", "UUID,NAME", "connection", "show");
		return output
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [id = "", ...name] = splitTerse(line);
				return { uuid: id, name: name.join(":") };
			});
	}
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
				devices.some((name) => !DEVICE.test(name)) ||
				!Number.isInteger(timeout) ||
				timeout < 1
			)
				throw new Error("Invalid network checkpoint request");
			const paths: string[] = [];
			for (const name of devices) {
				const [path] = await call(
					MANAGER,
					DESTINATION,
					"GetDeviceByIpIface",
					"s",
					[name],
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
				// Flags 0: no DELETE_NEW_CONNECTIONS. That flag deletes every
				// profile created anywhere during the window (a Wi-Fi network
				// joined meanwhile, another port's shared profile). The owner
				// removes its own candidates by name and UUID instead.
				[String(paths.length), ...paths, String(timeout), "0"],
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
		async checkpointCreated(path: string) {
			if (!CHECKPOINT_PATH.test(path))
				throw new Error("Invalid network checkpoint");
			const output = await runner("busctl", [
				"--system",
				"--json=short",
				"get-property",
				DESTINATION,
				path,
				`${DESTINATION}.Checkpoint`,
				"Created",
			]);
			const value: unknown = JSON.parse(output).data;
			// int64 milliseconds of CLOCK_BOOTTIME; kept as a string so a journal
			// round-trip cannot lose precision.
			return typeof value === "number" && Number.isInteger(value)
				? String(value)
				: undefined;
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
		async describe(profile: string) {
			const id = await nmcli(
				"-g",
				"connection.id",
				"connection",
				"show",
				"uuid",
				uuid(profile),
			);
			const autoconnect = await nmcli(
				"-g",
				"connection.autoconnect",
				"connection",
				"show",
				"uuid",
				profile,
			);
			return {
				id: unescapeTerse(id.replace(/\n$/, "")),
				autoconnect: autoconnect.trim() === "yes",
			};
		},
		async cloneCandidate(profile: string, name: string) {
			if (!OWNED_NAME.test(name)) throw new Error("Invalid candidate name");
			// --temporary: the clone lives in memory (a /run keyfile) only.
			await nmcli(
				"connection",
				"clone",
				"--temporary",
				"uuid",
				uuid(profile),
				name,
			);
			const matches = (await profiles()).filter((p) => p.name === name);
			if (matches.length !== 1 || !matches[0])
				throw new Error("Candidate profile unavailable");
			return uuid(matches[0].uuid);
		},
		async modifyInMemory(
			profile: string,
			set: ReadonlyArray<readonly [string, string]>,
		) {
			if (!set.length || set.some(([key]) => !PROPERTY.test(key)))
				throw new Error("Invalid network profile edit");
			await nmcli(
				"connection",
				"modify",
				"--temporary",
				"uuid",
				uuid(profile),
				...set.flat(),
			);
		},
		async activate(profile: string, name: string) {
			await nmcli(
				"--wait",
				"30",
				"connection",
				"up",
				"uuid",
				uuid(profile),
				"ifname",
				device(name),
			);
		},
		async activeOn(name: string) {
			device(name);
			const output = await nmcli(
				"-t",
				"-f",
				"UUID,DEVICE",
				"connection",
				"show",
				"--active",
			);
			for (const line of output.split("\n").filter(Boolean)) {
				const [id, dev] = splitTerse(line);
				if (dev === name) return id;
			}
			return undefined;
		},
		async persist(profile: string, id: string, autoconnect: boolean) {
			if (!id || id.length > 255) throw new Error("Invalid profile name");
			// Without --temporary nmcli updates with TO_DISK: an in-memory
			// candidate moves to /etc in place, without reactivation.
			await nmcli(
				"connection",
				"modify",
				"uuid",
				uuid(profile),
				"connection.id",
				id,
				"connection.autoconnect",
				autoconnect ? "yes" : "no",
			);
		},
		async remove(profile: string) {
			uuid(profile);
			if (!(await profiles()).some((p) => p.uuid === profile)) return;
			await nmcli("connection", "delete", "uuid", profile);
		},
		async exists(profile: string) {
			uuid(profile);
			return (await profiles()).some((p) => p.uuid === profile);
		},
		async listByPrefix(prefix: string) {
			return (await profiles())
				.filter((p) => p.name.startsWith(prefix) && OWNED_NAME.test(p.name))
				.map((p) => p.uuid);
		},
	};
}

export const nmCheckpointAdapter = createNmCheckpointAdapter();
