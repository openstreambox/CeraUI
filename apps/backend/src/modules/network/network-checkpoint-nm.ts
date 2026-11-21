import { run } from "../../helpers/run.ts";
import type { CheckpointRef } from "./network-checkpoint.ts";

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
/** A D-Bus unique connection name, such as ":1.42". */
const UNIQUE_NAME = /^:[0-9]{1,10}\.[0-9]{1,10}$/;
/** org.freedesktop.DBus.GetId: 32 lowercase hex digits. */
const BUS_ID = /^[0-9a-f]{32}$/;
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
	async function callAt(
		destination: string,
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
			destination,
			path,
			iface,
			method,
			...(signature ? [signature, ...args] : []),
		]);
		return output.trim() ? (JSON.parse(output).data as unknown[]) : [];
	}
	const call = (
		path: string,
		iface: string,
		method: string,
		signature: string,
		args: string[],
	) => callAt(DESTINATION, path, iface, method, signature, args);

	/** NetworkManager's current unique bus name; undefined when it has none. */
	async function currentOwner(): Promise<string | undefined> {
		try {
			const [owner] = await callAt(
				"org.freedesktop.DBus",
				"/org/freedesktop/DBus",
				"org.freedesktop.DBus",
				"GetNameOwner",
				"s",
				[DESTINATION],
			);
			return typeof owner === "string" && UNIQUE_NAME.test(owner)
				? owner
				: undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * The system bus instance id. A unique name is never reused on one bus
	 * instance, but a fresh bus (after a dbus restart) can hand it out again,
	 * so the id is part of the checkpoint's identity.
	 */
	async function busId(): Promise<string> {
		const [id] = await callAt(
			"org.freedesktop.DBus",
			"/org/freedesktop/DBus",
			"org.freedesktop.DBus",
			"GetId",
			"",
			[],
		);
		if (typeof id !== "string" || !BUS_ID.test(id))
			throw new Error("D-Bus instance id unavailable");
		return id;
	}

	/** Refuse to act on a checkpoint whose bus instance is gone. */
	async function sameBus(ref: CheckpointRef) {
		if ((await busId()) !== ref.bus)
			throw new Error("Network checkpoint belongs to another bus instance");
	}

	async function createdStamp(owner: string, path: string) {
		const output = await runner("busctl", [
			"--system",
			"--json=short",
			"get-property",
			owner,
			path,
			`${DESTINATION}.Checkpoint`,
			"Created",
		]);
		const parsed = JSON.parse(output) as { type?: unknown; data?: unknown };
		// int64 milliseconds of CLOCK_MONOTONIC; kept as a string so a journal
		// round-trip cannot lose precision. Anything else is not a stamp.
		if (
			parsed.type !== "x" ||
			typeof parsed.data !== "number" ||
			!Number.isSafeInteger(parsed.data) ||
			parsed.data <= 0
		)
			throw new Error("Network checkpoint identity unavailable");
		return String(parsed.data);
	}

	function checkRef(ref: CheckpointRef) {
		if (
			!CHECKPOINT_PATH.test(ref.path) ||
			!UNIQUE_NAME.test(ref.owner) ||
			!/^[1-9][0-9]{0,18}$/.test(ref.created) ||
			!BUS_ID.test(ref.bus)
		)
			throw new Error("Invalid network checkpoint");
		return ref;
	}

	return {
		now: () => Date.now(),
		/**
		 * Create a checkpoint on the NetworkManager instance that owns the bus
		 * name right now, and return it with that instance's unique bus name and
		 * the checkpoint's creation stamp. Every later operation on it is sent to
		 * that unique name, which no other process can ever hold: after a
		 * NetworkManager restart, a checkpoint at the same path belongs to
		 * someone else, and calls to the old name fail instead of reaching it.
		 */
		async create(devices: string[], timeout: number): Promise<CheckpointRef> {
			if (
				!devices.length ||
				devices.some((name) => !DEVICE.test(name)) ||
				!Number.isInteger(timeout) ||
				timeout < 1
			)
				throw new Error("Invalid network checkpoint request");
			const bus = await busId();
			const owner = await currentOwner();
			if (!owner) throw new Error("NetworkManager unavailable");
			const paths: string[] = [];
			for (const name of devices) {
				const [path] = await callAt(
					owner,
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
			const [path] = await callAt(
				owner,
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
			if (typeof path !== "string" || !CHECKPOINT_PATH.test(path))
				throw new Error("Network checkpoint unavailable");
			return {
				path,
				owner,
				created: await createdStamp(owner, path),
				bus,
			};
		},
		/**
		 * True only while the same NetworkManager instance still holds the bus
		 * name, still lists the checkpoint, and it still carries its stamp.
		 */
		async live(ref: CheckpointRef) {
			checkRef(ref);
			if ((await busId()) !== ref.bus) return false;
			if ((await currentOwner()) !== ref.owner) return false;
			const output = await runner("busctl", [
				"--system",
				"--json=short",
				"get-property",
				ref.owner,
				MANAGER,
				DESTINATION,
				"Checkpoints",
			]);
			const value: unknown = JSON.parse(output).data;
			if (!Array.isArray(value))
				throw new Error("Network checkpoint state unavailable");
			if (!value.includes(ref.path)) return false;
			return (await createdStamp(ref.owner, ref.path)) === ref.created;
		},
		async destroy(ref: CheckpointRef) {
			checkRef(ref);
			await sameBus(ref);
			await callAt(ref.owner, MANAGER, DESTINATION, "CheckpointDestroy", "o", [
				ref.path,
			]);
		},
		async rollback(ref: CheckpointRef) {
			checkRef(ref);
			await sameBus(ref);
			const [results] = await callAt(
				ref.owner,
				MANAGER,
				DESTINATION,
				"CheckpointRollback",
				"o",
				[ref.path],
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
