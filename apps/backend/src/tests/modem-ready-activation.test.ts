import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../helpers/logger.ts";
import * as runner from "../helpers/run.ts";
import { resetGsmAutoconfigProbe } from "../modules/modems/gsm-autoconfig.ts";
import { resetGsmConnections } from "../modules/modems/gsm-connections.ts";
import {
	forgetModemReadyActivation,
	runModemReadyActivations,
	setModemReadyActivationDepsForTest,
} from "../modules/modems/modem-ready-activation.ts";
import {
	isUsbModem,
	refreshModemStatus,
	registerModemSafe,
	resolveLateModemConfig,
	setPresentSimDepsForTest,
} from "../modules/modems/modem-registration.ts";
import {
	discoverModems,
	initModemUpdateLoop,
	runModemStatusPoll,
	setModemPresenceDepsForTest,
	stopModemUpdateLoop,
	whenModemUpdatesSettled,
} from "../modules/modems/modem-update-loop.ts";
import {
	refreshModemIdPaths,
	resetModemWireProducer,
	setModemIdPathReader,
} from "../modules/modems/modem-wire-producer.ts";
import {
	getModem,
	getModemIds,
	type Modem,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";
import { refreshMutationBlocks } from "../modules/modems/mutation-blocks.ts";
import {
	defaultMutationJournalFs,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { settlePendingMutationRemovals } from "../modules/modems/mutation-journal-retirement.ts";
import { beginModemMutation } from "../modules/modems/mutation-lease.ts";
import {
	captureModemState,
	resetMutationCaptureDeps,
	rollbackMutation,
	setMutationCaptureDeps,
} from "../modules/modems/mutation-rollback.ts";
import { setModemsState } from "../modules/modems/state/modems-state-cache.ts";
import { withModemUpdateLock } from "../modules/network/state/device-lock.ts";
import {
	isModemMutationHeld,
	resetLifecycleInterlock,
	tryAcquireLifecycle,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	completeRecoveryBarrier,
	isRecoveryPending,
	resetRecoveryBarrier,
} from "../modules/streaming/recovery-barrier.ts";
import { assertNmDeviceShowFields } from "./helpers/nm-device-show-fixture.ts";

const UUID = "d848da09-f700-4530-b888-be8b99ec8c85";
const KEY = "platform-xhci-hcd.0.auto-usb-0:1.4.1";
const DEVICE_ID = "synthetic-mbim-device";
const SIM_ID = "89000000000000000001";
const USB_PATH = "/sys/devices/platform/xhci-hcd.0.auto/usb1/1-4/1-4.1";
/** The modem as the USB enumeration describes it. */
const USB_DEVICE = {
	vendorId: "2C7C",
	productId: "0801",
	model: "MBIM modem",
	firmwareRevision: "1",
	bDeviceClass: 0,
	interfaces: [],
	physicalUid: KEY,
	sysfsPath: USB_PATH,
	ifname: "wwan0",
};
const DESCRIPTOR = (await captureModemState(KEY, {
	enumerate: async () => [USB_DEVICE],
})) as Record<string, unknown>;
/** The poll's clock; a takeover's settle wait advances it instead of sleeping. */
const baseDeps = {
	now: () => now,
	captureState: async () => DESCRIPTOR,
	sleep: async (ms: number) => {
		now += ms;
	},
};
let dir: string;
let now = 0;
let roster: number[];
let nmState: string;
let mmState: string;
let autoconnect: string;
let simReadable: boolean;
let existingProfile: boolean;
let activationFails: boolean;
let realRegistration: boolean;
let profileAddFails: boolean;
let simReadFails: boolean;
let profileReadFails: boolean;
let profileFieldsFailure: "none" | "unreadable" | "incomplete";
let commands: string[][];
let unexpected: string[];
let onStateRead: (() => Promise<void>) | undefined;
let onConnect: (() => Promise<void>) | undefined;
let onModemRead: (() => Promise<void>) | undefined;
let onModify: (() => Promise<void>) | undefined;
let activeUuid: string;
let activeSimId: string | undefined;
let modemIccid: string | undefined;
let otherProfile: boolean;
let otherAutoconnect: string;
let modifies: string[][];

function modem(): Modem {
	return {
		ifname: "wwan0",
		name: "MBIM modem",
		sim_network: "Test",
		network_type: { supported: {}, active: null },
		...(modemIccid ? { iccid: modemIccid } : {}),
		config: {
			conn: UUID,
			autoconfig: false,
			apn: "internet",
			username: "",
			password: "",
			roaming: false,
			network: "",
		},
	};
}

function activations(): string[][] {
	return commands.filter(
		([binary, ...args]) => binary === "nmcli" && args.includes("up"),
	);
}

function profileWrites(): string[][] {
	return commands.filter(
		([binary, ...args]) =>
			binary === "nmcli" &&
			args.some((arg) => ["add", "modify", "del"].includes(arg)),
	);
}

function holdLease(): { release(): void } {
	const acquired = beginModemMutation(KEY);
	if (!acquired.ok) throw new Error(`Lease refused: ${acquired.refusal}`);
	return acquired.lease;
}

beforeEach(async () => {
	now = 0;
	roster = [2];
	nmState = "30 (disconnected)";
	mmState = "registered";
	autoconnect = "yes";
	simReadable = true;
	existingProfile = true;
	activationFails = false;
	realRegistration = false;
	profileAddFails = false;
	simReadFails = false;
	profileReadFails = false;
	profileFieldsFailure = "none";
	commands = [];
	unexpected = [];
	onStateRead = undefined;
	onConnect = undefined;
	onModemRead = undefined;
	onModify = undefined;
	activeUuid = "";
	activeSimId = undefined;
	modemIccid = undefined;
	otherProfile = false;
	otherAutoconnect = "yes";
	modifies = [];
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	resetGsmConnections();
	resetGsmAutoconfigProbe();
	setModemReadyActivationDepsForTest(baseDeps);
	dir = await mkdtemp(join(tmpdir(), "modem-ready-"));
	setMutationJournalDeps({ dir });
	for (const id of getModemIds()) removeModem(id);
	setModemsState({});
	setModemIdPathReader(async () => new Map([["wwan0", KEY]]));
	setMutationCaptureDeps({ enumerate: async () => [USB_DEVICE] });
	setPresentSimDepsForTest({
		usbDevices: async () => [
			{ vidPid: DESCRIPTOR.vidPid, sysfsPath: USB_PATH },
		],
		resolvePath: async (path) => path,
	});
	setModemPresenceDepsForTest({
		listModems: async () => roster,
		registerModem: async (id) => {
			if (realRegistration) await registerModemSafe(id);
			else setModem(id, modem());
		},
		refreshStatus: refreshModemStatus,
		refreshIdPaths: refreshModemIdPaths,
	});
	spyOn(runner, "run").mockImplementation(async (binary, args) => {
		commands.push([binary, ...args]);
		if (binary === "mmcli") {
			if (args.includes("-i") && simReadFails)
				throw new Error("SIM read failed");
			if (args.includes("-i"))
				return `sim.properties.iccid : ${simReadable ? SIM_ID : "--"}
sim.properties.operator-name : Test`;
			if (args.join(" ") === "-K -L")
				return [
					`modem-list.length : ${roster.length}`,
					...roster.map(
						(id, i) =>
							`modem-list.value[${i + 1}] : /org/freedesktop/ModemManager1/Modem/${id}`,
					),
				].join("\n");
			await onModemRead?.();
			return `modem.generic.model : MBIM modem
modem.generic.state : ${mmState}
modem.generic.device-identifier : ${DEVICE_ID}
modem.generic.device : ${USB_PATH}
modem.generic.sim : /org/freedesktop/ModemManager1/SIM/1
modem.generic.ports.length : 1
modem.generic.ports.value[1] : wwan0 (net)`;
		}
		if (binary === "nmcli") {
			if (args.includes("device") && args.includes("show")) {
				const fields = args[args.indexOf("--get-values") + 1];
				if (fields === undefined) throw new Error("missing device show fields");
				assertNmDeviceShowFields(fields);
			}
			if (args.includes("DEVICE,TYPE")) return "cdc-wdm0:gsm";
			if (args.includes("GENERAL.CON-UUID")) return activeUuid;
			if (args[args.indexOf("--get-values") + 1] === "gsm.sim-id") {
				if (activeSimId === undefined) throw new Error("sim-id unreadable");
				return activeSimId;
			}
			if (args.includes("CONNECTIONS.AVAILABLE-CONNECTIONS")) {
				expect(args.slice(0, 2)).toEqual(["--mode", "multiline"]);
				return `CONNECTIONS.AVAILABLE-CONNECTIONS[1]:${UUID} | profile-a`;
			}
			if (args.includes("GENERAL.IP-IFACE")) return "";
			if (args[0] === "con" && args[1] === "modify") {
				expect(isModemMutationHeld(KEY)).toBe(true);
				modifies.push(args.slice(2));
				await onModify?.();
				if (args[2] === OTHER_UUID && args[3] === "connection.autoconnect")
					otherAutoconnect = args[4] ?? otherAutoconnect;
				return "";
			}
			if (args.includes("GENERAL.STATE")) {
				await onStateRead?.();
				return nmState;
			}
			if (args.includes("connection.autoconnect")) return autoconnect;
			if (args.includes("uuid,type,state")) {
				if (profileReadFails) throw new Error("Profile lookup failed");
				// Like nmcli, every record ends with LF, the last one included.
				return [
					...(existingProfile ? [`${UUID}:gsm:`] : []),
					...(otherProfile ? [`${OTHER_UUID}:gsm:`] : []),
				]
					.map((row) => `${row}\n`)
					.join("");
			}
			if (args.includes("add")) {
				if (profileAddFails) throw new Error("Profile creation failed");
				return `Connection 'gsm' (${UUID}) successfully added.`;
			}
			if (args.includes("gsm.auto-config")) return "no";
			if (
				args.includes(
					"gsm.device-id,gsm.sim-id,connection.autoconnect,connection.timestamp",
				)
			)
				return args.at(-1) === OTHER_UUID
					? `${DEVICE_ID}\n${OTHER_SIM_ID}\n${otherAutoconnect}\n100`
					: `${DEVICE_ID}\n${SIM_ID}\nyes\n0`;
			if (
				args.some((arg) =>
					arg.startsWith("gsm.device-id,gsm.sim-id,gsm.sim-operator-id"),
				)
			) {
				if (profileFieldsFailure === "unreadable")
					throw new Error("Profile fields unreadable");
				if (profileFieldsFailure === "incomplete")
					return `${DEVICE_ID}\n${SIM_ID}`;
				return `${DEVICE_ID}\n${SIM_ID}\n\ninternet\n\n\nyes\n\nno`;
			}
			if (args[0] === "conn" && args[1] === "down") {
				expect(isModemMutationHeld(KEY)).toBe(true);
				nmState = "30 (disconnected)";
				return `Connection '${args[2]}' successfully deactivated`;
			}
			if (args.includes("up")) {
				expect(isModemMutationHeld(KEY)).toBe(true);
				// A connection wait must never hold the global reconciliation lock.
				let entered = false;
				await withModemUpdateLock(async () => {
					entered = true;
				});
				expect(entered).toBe(true);
				await onConnect?.();
				if (activationFails) throw new Error("Connection activation failed");
				return "Connection successfully activated";
			}
		}
		const command = `${binary} ${args.join(" ")}`;
		unexpected.push(command);
		throw new Error(`Unexpected command: ${command}`);
	});
});

afterEach(async () => {
	stopModemUpdateLoop();
	spyOn(runner, "run").mockRestore();
	setModemPresenceDepsForTest(null);
	setModemReadyActivationDepsForTest(null);
	setPresentSimDepsForTest(null);
	resetMutationCaptureDeps();
	setModemIdPathReader(null);
	resetModemWireProducer();
	resetMutationJournalDeps();
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	resetGsmConnections();
	resetGsmAutoconfigProbe();
	for (const id of getModemIds()) removeModem(id);
	setModemsState({});
	await rm(dir, { recursive: true, force: true });
	expect(unexpected).toEqual([]);
});

test("a newly registered idle modem gets one activation after discovery", async () => {
	await discoverModems();
	expect(activations()).toEqual([]);
	await runModemStatusPoll();
	await runModemStatusPoll();
	expect(activations()).toEqual([["nmcli", "-w", "45", "conn", "up", UUID]]);
});

test("an empty active UUID reaches ready activation through the available profile", async () => {
	await runModemStatusPoll();
	expect(commands).toContainEqual([
		"nmcli",
		"--terse",
		"--escape",
		"no",
		"--get-values",
		"GENERAL.CON-UUID",
		"device",
		"show",
		"cdc-wdm0",
	]);
	expect(commands).toContainEqual([
		"nmcli",
		"--mode",
		"multiline",
		"--terse",
		"--escape",
		"no",
		"--get-values",
		"CONNECTIONS.AVAILABLE-CONNECTIONS",
		"device",
		"show",
		"cdc-wdm0",
	]);
	expect(activations()).toEqual([["nmcli", "-w", "45", "conn", "up", UUID]]);
});

test("an unavailable device stays pending until a disconnected poll", async () => {
	nmState = "20 (unavailable)";
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
	nmState = "30 (disconnected)";
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
});

test("NM success consumes intent before MM state eligibility", async () => {
	nmState = "100 (connected)";
	mmState = "searching";
	await runModemStatusPoll();
	nmState = "30 (disconnected)";
	mmState = "registered";
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
});

const OTHER_UUID = "0b9c6d3e-2f41-4a7b-9c55-6e1d2a3b4c5d";
const OTHER_SIM_ID = "89000000000000000002";
/** A takeover dial is bound to the device its settle wait reads. */
const TAKEOVER_DIAL = [
	"nmcli",
	"-w",
	"45",
	"conn",
	"up",
	"uuid",
	UUID,
	"ifname",
	"cdc-wdm0",
];

test("a device up on another SIM's profile gets its own profile once", async () => {
	modemIccid = SIM_ID;
	nmState = "100 (connected)";
	mmState = "connected";
	activeUuid = OTHER_UUID;
	activeSimId = OTHER_SIM_ID;
	await runModemStatusPoll();
	expect(activations()).toEqual([TAKEOVER_DIAL]);
	// The takeover is the one first activation: it is never repeated.
	now = 600_000;
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
});

for (const [label, sim] of [
	["the same SIM", SIM_ID],
	["no SIM id", ""],
] as const) {
	test(`a device up on another profile for ${label} is left alone`, async () => {
		modemIccid = SIM_ID;
		nmState = "100 (connected)";
		mmState = "connected";
		activeUuid = OTHER_UUID;
		activeSimId = sim;
		await runModemStatusPoll();
		now = 600_000;
		nmState = "30 (disconnected)";
		mmState = "registered";
		await runModemStatusPoll();
		expect(activations()).toEqual([]);
	});
}

test("a device up on its own profile is not dialled again", async () => {
	modemIccid = SIM_ID;
	nmState = "100 (connected)";
	activeUuid = UUID;
	activeSimId = OTHER_SIM_ID;
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
	expect(commands.some((command) => command.includes("gsm.sim-id"))).toBe(
		false,
	);
});

test("another SIM's profile is not replaced while its modem's SIM is unknown", async () => {
	nmState = "100 (connected)";
	mmState = "connected";
	activeUuid = OTHER_UUID;
	activeSimId = OTHER_SIM_ID;
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
});

test("a takeover still needs a dialable profile", async () => {
	modemIccid = SIM_ID;
	nmState = "100 (connected)";
	mmState = "connected";
	activeUuid = OTHER_UUID;
	activeSimId = OTHER_SIM_ID;
	autoconnect = "no";
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
});

test("an unreadable active profile keeps the takeover pending until it reads", async () => {
	modemIccid = SIM_ID;
	nmState = "100 (connected)";
	mmState = "connected";
	activeUuid = OTHER_UUID;
	activeSimId = undefined;
	await runModemStatusPoll();
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
	activeSimId = OTHER_SIM_ID;
	await runModemStatusPoll();
	expect(activations()).toEqual([TAKEOVER_DIAL]);
});

test("the takeover journals a descriptor pre-state that replay on any build restores", async () => {
	modemIccid = SIM_ID;
	nmState = "100 (connected)";
	mmState = "connected";
	activeUuid = OTHER_UUID;
	activeSimId = OTHER_SIM_ID;
	let entry: { kind: string; preState: Record<string, unknown> } | undefined;
	onConnect = async () => {
		const [name] = (await readdir(dir)).filter((file) =>
			file.endsWith(".json"),
		);
		if (name) entry = JSON.parse(await readFile(join(dir, name), "utf8"));
	};
	await runModemStatusPoll();
	expect(entry?.kind).toBe("modem-config");
	expect(entry?.preState).toEqual(DESCRIPTOR);
	// No `format`: rollback never consults a format inverse, so a build that
	// does not know this change replays it through the same generic path.
	expect(entry?.preState.format).toBeUndefined();
	setMutationCaptureDeps({ enumerate: async () => [USB_DEVICE] });
	try {
		expect(
			await rollbackMutation("modem-config", KEY, entry?.preState ?? {}),
		).toBe("restored");
	} finally {
		resetMutationCaptureDeps();
	}
});

test("a takeover dial that times out holds the lease until NetworkManager settles", async () => {
	modemIccid = SIM_ID;
	nmState = "100 (connected)";
	mmState = "connected";
	activeUuid = OTHER_UUID;
	activeSimId = OTHER_SIM_ID;
	activationFails = true;
	const states = [
		"70 (connecting (getting IP configuration))",
		"70 (connecting (getting IP configuration))",
		"100 (connected)",
	];
	const held: boolean[] = [];
	onConnect = async () => {
		onStateRead = async () => {
			held.push(isModemMutationHeld(KEY));
			nmState = states.shift() ?? nmState;
		};
	};
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
	expect(held.length).toBeGreaterThanOrEqual(3);
	expect(held.every(Boolean)).toBe(true);
	expect(commands.some((command) => command.includes("down"))).toBe(false);
	expect((await readdir(dir)).filter((name) => name.endsWith(".json"))).toEqual(
		[],
	);
});

test("a takeover activation that never settles is journaled failed, never taken down", async () => {
	modemIccid = SIM_ID;
	nmState = "100 (connected)";
	mmState = "connected";
	activeUuid = OTHER_UUID;
	activeSimId = OTHER_SIM_ID;
	activationFails = true;
	onConnect = async () => {
		nmState = "0 (unknown)";
	};
	const started = now;
	await runModemStatusPoll();
	expect(now - started).toBeGreaterThanOrEqual(180_000);
	expect(
		commands.filter(
			([binary, ...args]) => binary === "nmcli" && args.includes("down"),
		),
	).toEqual([]);
	const [name] = (await readdir(dir)).filter((file) => file.endsWith(".json"));
	expect(JSON.parse(await readFile(join(dir, name ?? ""), "utf8")).state).toBe(
		"failed",
	);
});

test("a takeover holds the lease at most 180 s from its device resolve, plus one state read", async () => {
	modemIccid = SIM_ID;
	nmState = "100 (connected)";
	mmState = "connected";
	activeUuid = OTHER_UUID;
	activeSimId = OTHER_SIM_ID;
	const READ_MS = 30_000;
	let resolvedAt = 0;
	let dialResolvedAt: number | undefined;
	const readDevices: string[] = [];
	setModemReadyActivationDepsForTest({
		...baseDeps,
		// Each resolve, the dial and each state read take time on the clock.
		resolveDevice: async () => {
			resolvedAt = now;
			now += 25_000;
			return "ttyUSB2";
		},
		readDevice: async (device, field) => {
			if (dialResolvedAt !== undefined && field === "GENERAL.STATE") {
				readDevices.push(device);
				now += READ_MS;
				return ["70 (connecting (getting IP configuration))"];
			}
			if (field === "GENERAL.STATE") return [nmState];
			if (field === "GENERAL.CON-UUID") return [activeUuid];
			return undefined;
		},
		connect: async (...args) => {
			dialResolvedAt = resolvedAt;
			commands.push(["connect", ...args.map(String)]);
			now += 45_000;
			return false;
		},
	});
	await runModemStatusPoll();
	expect(commands.filter(([binary]) => binary === "connect")).toEqual([
		["connect", UUID, "45", "undefined", "undefined", "ttyUSB2"],
	]);
	expect(readDevices.length).toBeGreaterThan(0);
	expect(readDevices.every((device) => device === "ttyUSB2")).toBe(true);
	const held = now - (dialResolvedAt ?? Number.NaN);
	expect(held).toBeGreaterThanOrEqual(180_000);
	expect(held).toBeLessThanOrEqual(180_000 + READ_MS);
	const [name] = (await readdir(dir)).filter((file) => file.endsWith(".json"));
	expect(JSON.parse(await readFile(join(dir, name ?? ""), "utf8")).state).toBe(
		"failed",
	);
});

test("a takeover wait ends when the registration does", async () => {
	modemIccid = SIM_ID;
	nmState = "100 (connected)";
	mmState = "connected";
	activeUuid = OTHER_UUID;
	activeSimId = OTHER_SIM_ID;
	activationFails = true;
	let reads = 0;
	onConnect = async () => {
		nmState = "70 (connecting (getting IP configuration))";
		onStateRead = async () => {
			reads += 1;
			if (reads === 2) forgetModemReadyActivation(2);
		};
	};
	await runModemStatusPoll();
	expect(reads).toBe(2);
	expect((await readdir(dir)).filter((name) => name.endsWith(".json"))).toEqual(
		[],
	);
});

test("a late SIM on a modem another SIM's profile already connected still resolves and takes over", async () => {
	simReadable = false;
	realRegistration = true;
	await discoverModems();
	expect(getModem(2)?.config).toBeUndefined();
	simReadable = true;
	mmState = "connected";
	nmState = "100 (connected)";
	activeUuid = OTHER_UUID;
	activeSimId = OTHER_SIM_ID;
	await runModemStatusPoll();
	await runModemStatusPoll();
	expect(getModem(2)?.config?.conn).toBe(UUID);
	expect(activations()).toEqual([TAKEOVER_DIAL]);
});

test("the takeover holds an armed journal entry while it dials", async () => {
	modemIccid = SIM_ID;
	nmState = "100 (connected)";
	mmState = "connected";
	activeUuid = OTHER_UUID;
	activeSimId = OTHER_SIM_ID;
	let entries: string[] = [];
	onConnect = async () => {
		entries = (await readdir(dir)).filter((name) => name.endsWith(".json"));
	};
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
	expect(entries).toHaveLength(1);
	expect((await readdir(dir)).filter((name) => name.endsWith(".json"))).toEqual(
		[],
	);
});

test("a takeover waits while another mutation of the modem runs", async () => {
	modemIccid = SIM_ID;
	nmState = "100 (connected)";
	mmState = "connected";
	activeUuid = OTHER_UUID;
	activeSimId = OTHER_SIM_ID;
	await discoverModems();
	const lease = holdLease();
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
	lease.release();
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
});

test("a takeover held back by the dial cooldown is logged once", async () => {
	modemIccid = SIM_ID;
	nmState = "100 (connected)";
	mmState = "connected";
	activeUuid = OTHER_UUID;
	activeSimId = OTHER_SIM_ID;
	// A dial 10 s ago on the same physical modem starts the cooldown.
	await runModemStatusPoll();
	roster = [];
	await runModemStatusPoll();
	roster = [9];
	now = 10_000;
	const warn = spyOn(logger, "warn");
	try {
		for (let poll = 0; poll < 4; poll++) await runModemStatusPoll();
		const notices = warn.mock.calls.filter(
			([message]) =>
				message ===
				"modem is up on a profile for another SIM; a switch to its own is pending",
		);
		expect(notices).toHaveLength(1);
		expect(activations()).toHaveLength(1);
	} finally {
		warn.mockRestore();
	}
});

test("the settle step parks another SIM's profile under the lease, once per registration", async () => {
	modemIccid = SIM_ID;
	otherProfile = true;
	await runModemStatusPoll();
	expect(modifies).toEqual([[OTHER_UUID, "connection.autoconnect", "no"]]);
	const audits = (): number =>
		commands.filter((command) => command.includes("uuid,type,state")).length;
	const after = audits();
	await runModemStatusPoll();
	expect(audits()).toBe(after);
	expect((await readdir(dir)).filter((name) => name.endsWith(".json"))).toEqual(
		[],
	);
});

test("a held lease defers the settle step to a later poll", async () => {
	modemIccid = SIM_ID;
	otherProfile = true;
	await discoverModems();
	const lease = holdLease();
	await runModemStatusPoll();
	expect(modifies).toEqual([]);
	lease.release();
	// A refused settle is spaced out, not retried on the very next poll.
	await runModemStatusPoll();
	expect(modifies).toEqual([]);
	now += 30_000;
	await runModemStatusPoll();
	expect(modifies).toEqual([[OTHER_UUID, "connection.autoconnect", "no"]]);
});

test("a refused settle still runs after readiness consumed the intent", async () => {
	modemIccid = SIM_ID;
	otherProfile = true;
	// Up on its own profile: the first poll consumes the intent.
	nmState = "100 (connected)";
	activeUuid = UUID;
	await discoverModems();
	const lease = holdLease();
	await runModemStatusPoll();
	expect(modifies).toEqual([]);
	lease.release();
	now += 30_000;
	await runModemStatusPoll();
	expect(modifies).toEqual([[OTHER_UUID, "connection.autoconnect", "no"]]);
	expect(activations()).toEqual([]);
});

test("an incomplete settle is tried again, spaced out, until it finishes", async () => {
	const answers: Array<"retry" | "done"> = ["retry", "retry", "done"];
	const settles: number[] = [];
	setModemReadyActivationDepsForTest({
		...baseDeps,
		settleSwap: async () => {
			settles.push(now);
			return answers.shift() ?? "done";
		},
	});
	for (const at of [
		0, 10_000, 30_000, 60_000, 89_000, 90_000, 200_000, 900_000,
	]) {
		now = at;
		await runModemStatusPoll();
	}
	expect(settles).toEqual([0, 30_000, 90_000]);
});

test("the settle step journals a descriptor pre-state and retires it", async () => {
	modemIccid = SIM_ID;
	otherProfile = true;
	const seen: Array<{ kind: string; preState: Record<string, unknown> }> = [];
	onModify = async () => {
		for (const name of (await readdir(dir)).filter((file) =>
			file.endsWith(".json"),
		))
			seen.push(JSON.parse(await readFile(join(dir, name), "utf8")));
	};
	await runModemStatusPoll();
	expect(modifies).toEqual([[OTHER_UUID, "connection.autoconnect", "no"]]);
	expect(seen.map((entry) => [entry.kind, entry.preState])).toEqual([
		["modem-config", DESCRIPTOR],
	]);
	expect((await readdir(dir)).filter((name) => name.endsWith(".json"))).toEqual(
		[],
	);
});

test("a USB modem whose descriptor cannot be captured yet settles later", async () => {
	modemIccid = SIM_ID;
	otherProfile = true;
	const sysfs = await mkdtemp(join(dir, "usb-"));
	await writeFile(join(sysfs, "idVendor"), "2c7c\n");
	setPresentSimDepsForTest({
		usbDevices: async () => [
			{ vidPid: DESCRIPTOR.vidPid as string, sysfsPath: USB_PATH },
		],
		resolvePath: async (path) => (path === USB_PATH ? sysfs : path),
	});
	setMutationCaptureDeps({ enumerate: async () => [] });
	await runModemStatusPoll();
	expect(modifies).toEqual([]);
	setMutationCaptureDeps({ enumerate: async () => [USB_DEVICE] });
	setPresentSimDepsForTest({
		usbDevices: async () => [
			{ vidPid: DESCRIPTOR.vidPid as string, sysfsPath: USB_PATH },
		],
		resolvePath: async (path) => path,
	});
	now += 30_000;
	await runModemStatusPoll();
	expect(modifies).toEqual([[OTHER_UUID, "connection.autoconnect", "no"]]);
});

test("a takeover on a USB modem whose descriptor cannot be captured yet stays pending", async () => {
	modemIccid = SIM_ID;
	nmState = "100 (connected)";
	mmState = "connected";
	activeUuid = OTHER_UUID;
	activeSimId = OTHER_SIM_ID;
	let descriptor: Record<string, unknown> | undefined;
	setModemReadyActivationDepsForTest({
		...baseDeps,
		captureState: async () => descriptor,
		isUsb: async () => true,
	});
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
	descriptor = DESCRIPTOR;
	await runModemStatusPoll();
	expect(activations()).toEqual([TAKEOVER_DIAL]);
});

test("a takeover on a modem positively off USB is consumed without a dial or journal entry", async () => {
	modemIccid = SIM_ID;
	nmState = "100 (connected)";
	mmState = "connected";
	activeUuid = OTHER_UUID;
	activeSimId = OTHER_SIM_ID;
	let usbReads = 0;
	setModemReadyActivationDepsForTest({
		...baseDeps,
		captureState: async () => undefined,
		isUsb: async () => {
			usbReads += 1;
			return false;
		},
	});
	await runModemStatusPoll();
	now += 600_000;
	await runModemStatusPoll();
	expect(usbReads).toBe(1);
	expect(activations()).toEqual([]);
	expect((await readdir(dir)).filter((name) => name.endsWith(".json"))).toEqual(
		[],
	);
});

test("a modem that is not on USB settles without parking or a journal entry", async () => {
	modemIccid = SIM_ID;
	otherProfile = true;
	// A physdev that is there and has no USB level above it.
	const platform = await mkdtemp(join(dir, "platform-"));
	setPresentSimDepsForTest({
		usbDevices: async () => [],
		resolvePath: async (path) => (path === USB_PATH ? platform : path),
	});
	let captures = 0;
	setMutationCaptureDeps({
		enumerate: async () => {
			captures += 1;
			return [];
		},
	});
	await runModemStatusPoll();
	now += 900_000;
	await runModemStatusPoll();
	// Settled once: a modem that is not on USB will not become one.
	expect(captures).toBe(1);
	expect(modifies).toEqual([]);
	expect(
		commands.filter((command) => command.includes("uuid,type,state")),
	).toEqual([]);
});

test("a USB interface or a child of a USB device reads as USB, a vanished path as unknown", async () => {
	const usb = await mkdtemp(join(dir, "usb-"));
	const device = join(usb, "1-4.1");
	const iface = join(device, "1-4.1:1.0");
	const bus = join(usb, "bus", "usb");
	await mkdir(iface, { recursive: true });
	await mkdir(bus, { recursive: true });
	await writeFile(join(device, "idVendor"), "2c7c\n");
	let resolved = iface;
	setPresentSimDepsForTest({ resolvePath: async () => resolved });
	// The interface has no ids of its own; its parent device has.
	expect(await isUsbModem(2)).toBe(true);
	// The interface's own subsystem link says USB too.
	await rm(join(device, "idVendor"));
	await symlink(bus, join(iface, "subsystem"));
	expect(await isUsbModem(2)).toBe(true);
	// A net device below the interface.
	resolved = join(iface, "net", "wwan0");
	await mkdir(resolved, { recursive: true });
	expect(await isUsbModem(2)).toBe(true);
	// Unplugged between the realpath and the reads: not proof of "not USB".
	await rm(join(iface, "subsystem"));
	resolved = join(usb, "gone", "1-4.2:1.0");
	expect(await isUsbModem(2)).toBeUndefined();
	// There, with no USB level up to the root: not on USB.
	resolved = device;
	expect(await isUsbModem(2)).toBe(false);
});

test("registration alone parks nothing", async () => {
	modemIccid = SIM_ID;
	otherProfile = true;
	realRegistration = true;
	await discoverModems();
	expect(modifies).toEqual([]);
});

test("twenty registered and connecting polls never rearm a dispatched intent", async () => {
	await runModemStatusPoll();
	for (let poll = 0; poll < 20; poll++) {
		mmState = poll % 2 === 0 ? "connecting" : "registered";
		await runModemStatusPoll();
	}
	expect(activations()).toHaveLength(1);
});

test("searching then registered after 301 seconds does not rearm", async () => {
	await runModemStatusPoll();
	mmState = "searching";
	await runModemStatusPoll();
	now = 301_000;
	mmState = "registered";
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
});

test("remove and re-add with a new MM index preserves the physical cooldown", async () => {
	await runModemStatusPoll();
	roster = [];
	await runModemStatusPoll();
	now = 299_999;
	roster = [9];
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
	now = 300_000;
	await runModemStatusPoll();
	expect(activations()).toHaveLength(2);
});

for (const guard of [
	"autoconnect",
	"inhibit",
	"scanning",
	"identity",
	"lease",
] as const) {
	test(`a ${guard} refusal preserves pending intent without dispatch`, async () => {
		await discoverModems();
		const row = getModem(2);
		if (!row) throw new Error("Modem not registered");
		const lease = guard === "lease" ? holdLease() : undefined;
		if (guard === "autoconnect") autoconnect = "no";
		if (guard === "inhibit") row.inhibit = true;
		if (guard === "scanning") row.is_scanning = true;
		if (guard === "identity") {
			setModemIdPathReader(async () => new Map());
			await refreshModemIdPaths();
		}
		await runModemStatusPoll();
		expect(activations()).toEqual([]);
		lease?.release();
		autoconnect = "yes";
		const current = getModem(2);
		if (current) {
			delete current.inhibit;
			delete current.is_scanning;
		}
		setModemIdPathReader(async () => new Map([["wwan0", KEY]]));
		await refreshModemIdPaths();
		await runModemStatusPoll();
		expect(activations()).toHaveLength(1);
	});
}

test("a failed activation is consumed and never retried", async () => {
	activationFails = true;
	await runModemStatusPoll();
	now = 600_000;
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
});

test("a failed activation records data-call evidence for the modem warning", async () => {
	activationFails = true;

	await runModemStatusPoll();

	expect(getModem(2)?.data_connection_failed).toBe(true);
});

test("a successful connection clears failed data-call evidence", async () => {
	activationFails = true;
	await runModemStatusPoll();
	mmState = "connected";

	await runModemStatusPoll();

	expect(getModem(2)?.data_connection_failed).toBeUndefined();
});

test("a SIM readable after registration resolves the existing UUID without creation", async () => {
	simReadable = false;
	realRegistration = true;
	await discoverModems();
	expect(getModem(2)?.config).toBeUndefined();
	simReadable = true;
	await runModemStatusPoll();
	await runModemStatusPoll();
	expect(getModem(2)?.config?.conn).toBe(UUID);
	expect(activations()).toEqual([["nmcli", "-w", "45", "conn", "up", UUID]]);
	expect(profileWrites()).toEqual([]);
});

test("monitor event refreshes and resync discovery never dispatch", async () => {
	const monitor = new EventEmitter();
	await initModemUpdateLoop({
		monitor: Object.assign(monitor, { start() {}, stop() {} }),
		autoDiscover: false,
		autoUnlock: false,
		startPoll: false,
	});
	await discoverModems();
	monitor.emit("monitor-event", {
		type: "device-state",
		device: "wwan0",
		state: "disconnected",
	});
	await whenModemUpdatesSettled();
	await discoverModems();
	expect(activations()).toEqual([]);
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
});

test("a monitor-driven registration cannot arm activation intent", async () => {
	const monitor = new EventEmitter();
	await initModemUpdateLoop({
		monitor: Object.assign(monitor, { start() {}, stop() {} }),
		autoDiscover: false,
		autoUnlock: false,
		startPoll: false,
	});
	monitor.emit("monitor-event", { type: "modem-added", id: "2" });
	await whenModemUpdatesSettled();
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
	roster = [];
	await runModemStatusPoll();
	roster = [2];
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
});

test("MM connected and NM connected consumes intent before a later disconnect", async () => {
	mmState = "connected";
	nmState = "100 (connected)";
	await runModemStatusPoll();
	mmState = "registered";
	nmState = "30 (disconnected)";
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
});

test("overlapping polls after a failed activation cannot dispatch again", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	activationFails = true;
	onConnect = async () => {
		started.resolve();
		await release.promise;
	};
	const first = runModemStatusPoll();
	await started.promise;
	await Promise.all([runModemStatusPoll(), runModemStatusPoll()]);
	release.resolve();
	await first;
	expect(activations()).toHaveLength(1);
});

test("late config writes stay pending under lease refusal and journal failure", async () => {
	simReadable = false;
	existingProfile = false;
	realRegistration = true;
	await discoverModems();
	simReadable = true;
	const lease = holdLease();
	await runModemStatusPoll();
	expect(profileWrites()).toEqual([]);
	expect(getModem(2)?.config).toBeUndefined();
	lease.release();
	setMutationJournalDeps({
		dir,
		fs: {
			...defaultMutationJournalFs,
			writeTemp: async () => {
				throw new Error("journal fault");
			},
		},
	});
	await runModemStatusPoll();
	expect(profileWrites()).toEqual([]);
	expect(getModem(2)?.config).toBeUndefined();
	expect(isRecoveryPending()).toBe(true);
	setMutationJournalDeps({ dir, fs: defaultMutationJournalFs });
	await settlePendingMutationRemovals();
	await refreshMutationBlocks();
	expect(completeRecoveryBarrier()).toBe(true);
	await runModemStatusPoll();
	expect(profileWrites()).toHaveLength(1);
	expect(getModem(2)?.config?.conn).toBe(UUID);
	expect(activations()).toHaveLength(1);
});

for (const state of [
	"",
	"30garbage",
	"30 (disconnected)\n100",
	"activating",
	"40 (prepare)",
	"120 (failed)",
]) {
	test(`unparsed or non-disconnected NM state ${JSON.stringify(state)} stays pending`, async () => {
		nmState = state;
		await runModemStatusPoll();
		expect(activations()).toEqual([]);
		nmState = "30 (disconnected)";
		await runModemStatusPoll();
		expect(activations()).toHaveLength(1);
	});
}

test("readiness accepts a terminated state record only when it is the sole record", async () => {
	nmState = "30 (disconnected)\n\n";
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
	nmState = "30 (disconnected)\n";
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
});

test("lease recheck refuses a changed config UUID", async () => {
	let reads = 0;
	onStateRead = async () => {
		if (++reads !== 2) return;
		const row = getModem(2);
		if (row?.config) row.config.conn = "091ca73b-9f75-42bd-a737-2c447ca44533";
	};
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
});

test("late config attempts once per readable SIM edge and read failure cannot rearm it", async () => {
	simReadable = false;
	existingProfile = false;
	realRegistration = true;
	profileAddFails = true;
	await discoverModems();
	simReadable = true;
	await runModemStatusPoll();
	await runModemStatusPoll();
	expect(profileWrites()).toHaveLength(1);
	simReadFails = true;
	await runModemStatusPoll();
	simReadFails = false;
	await runModemStatusPoll();
	expect(profileWrites()).toHaveLength(1);
	simReadable = false;
	await runModemStatusPoll();
	simReadable = true;
	profileAddFails = false;
	await runModemStatusPoll();
	expect(profileWrites()).toHaveLength(2);
	expect(activations()).toHaveLength(1);
});

test("a failed late profile lookup preserves pending work until a readable poll", async () => {
	realRegistration = true;
	simReadable = false;
	await discoverModems();
	simReadable = true;
	profileReadFails = true;
	await runModemStatusPoll();
	expect(getModem(2)?.config).toBeUndefined();
	expect(profileWrites()).toEqual([]);
	expect(activations()).toEqual([]);
	profileReadFails = false;
	await runModemStatusPoll();
	expect(getModem(2)?.config?.conn).toBe(UUID);
	expect(activations()).toHaveLength(1);
});

test("an overlapping status refresh preserves late-resolved SIM configuration", async () => {
	simReadable = false;
	realRegistration = true;
	let resolvedUuid: string | undefined;
	setModemReadyActivationDepsForTest({
		...baseDeps,
		resolveConfig: async (...args) => {
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let intercepted = false;
			onModemRead = async () => {
				if (intercepted) return;
				intercepted = true;
				started.resolve();
				await release.promise;
			};
			const second = runModemStatusPoll();
			await started.promise;
			try {
				const result = await resolveLateModemConfig(...args);
				resolvedUuid = getModem(2)?.config?.conn;
				return result;
			} finally {
				release.resolve();
				await second;
				onModemRead = undefined;
			}
		},
	});
	await discoverModems();
	simReadable = true;
	await runModemStatusPoll();
	const afterOverlap = getModem(2)?.config?.conn;
	for (let poll = 0; poll < 3; poll++) await runModemStatusPoll();
	expect(resolvedUuid).toBe(UUID);
	expect(afterOverlap).toBe(UUID);
	expect(getModem(2)?.config).toEqual(modem().config);
	expect(getModem(2)?.iccid).toBe(SIM_ID);
	expect(profileWrites()).toEqual([]);
	expect(activations()).toEqual([["nmcli", "-w", "45", "conn", "up", UUID]]);
});

for (const failure of ["unreadable", "incomplete"] as const) {
	test(`${failure} existing profile details keep late configuration pending without a clone`, async () => {
		simReadable = false;
		realRegistration = true;
		await discoverModems();
		simReadable = true;
		profileFieldsFailure = failure;
		await runModemStatusPoll();
		await runModemStatusPoll();
		expect(profileWrites()).toEqual([]);
		expect(getModem(2)?.config).toBeUndefined();
		expect(activations()).toEqual([]);
		profileFieldsFailure = "none";
		await runModemStatusPoll();
		expect(getModem(2)?.config?.conn).toBe(UUID);
		expect(getModem(2)?.config?.roaming).toBe(false);
		expect(profileWrites()).toEqual([]);
		expect(activations()).toEqual([["nmcli", "-w", "45", "conn", "up", UUID]]);
	});
}

test("consumption precedes connection await when the physical key changes in flight", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let connects = 0;
	onConnect = async () => {
		if (++connects !== 1) return;
		started.resolve();
		await release.promise;
	};
	const first = runModemStatusPoll();
	await started.promise;
	try {
		setModemIdPathReader(
			async () => new Map([["wwan0", `${KEY}-replacement`]]),
		);
		await refreshModemIdPaths();
		await runModemStatusPoll();
	} finally {
		release.resolve();
		await first;
	}
	expect(activations()).toEqual([["nmcli", "-w", "45", "conn", "up", UUID]]);
});

test("a modem just reset is skipped for the rest of the poll", async () => {
	await discoverModems();
	await runModemReadyActivations(getModemIds());
	expect(activations()).toEqual([]);
	await runModemReadyActivations();
	expect(activations()).toHaveLength(1);
});

// Prepared automatic carrier profiles carry autoconnect=no, so NetworkManager
// never brings them back; the redial path does, spaced out per physical modem.
async function connectAutomaticProfile(): Promise<void> {
	autoconnect = "no";
	setModemReadyActivationDepsForTest({
		...baseDeps,
		automaticReady: async () => automaticGrant,
	});
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
	nmState = "100 (connected)";
	await runModemStatusPoll();
}

let automaticGrant = true;
beforeEach(() => {
	automaticGrant = true;
});

/** Polls 15 s apart until `until`, starting at the current `now`. */
async function pollUntil(until: number): Promise<void> {
	while (now < until) {
		now += 15_000;
		await runModemStatusPoll();
	}
}

test("a dropped automatic profile is dialled again after two disconnected polls", async () => {
	await connectAutomaticProfile();
	now = 60_000;
	nmState = "30 (disconnected)";
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
	now = 75_000;
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
	now = 80_000;
	await runModemStatusPoll();
	expect(activations()).toEqual([
		["nmcli", "-w", "45", "conn", "up", UUID],
		["nmcli", "-w", "45", "conn", "up", UUID],
	]);
});

test("redials that keep failing are spaced 30, 60, 120, 240, 300 s, then 30 min apart", async () => {
	await connectAutomaticProfile();
	nmState = "30 (disconnected)";
	activationFails = true;
	const dialTimes: number[] = [];
	onConnect = async () => {
		dialTimes.push(now);
	};
	now = 0;
	await pollUntil(4 * 3_600_000);
	const gaps = dialTimes.slice(1).map((time, index) => time - dialTimes[index]);
	expect(dialTimes[0]).toBeGreaterThanOrEqual(30_000);
	expect(gaps.slice(0, 4)).toEqual([60_000, 120_000, 240_000, 300_000]);
	expect(gaps.length).toBeGreaterThan(5);
	for (const gap of gaps.slice(4)) expect(gap).toBe(1_800_000);
	expect(getModem(2)?.data_connection_failed).toBe(true);
}, 60_000);

test("five connected minutes reset the redial spacing", async () => {
	await connectAutomaticProfile();
	nmState = "30 (disconnected)";
	activationFails = true;
	await pollUntil(240_000);
	const failedDials = activations().length;
	expect(failedDials).toBeGreaterThan(2);
	activationFails = false;
	nmState = "100 (connected)";
	await pollUntil(now + 300_000);
	nmState = "30 (disconnected)";
	const dropAt = now;
	const before = activations().length;
	// First disconnected poll, the dwell poll, then the dial: well inside the
	// 240 s spacing the failed dials had reached before the stable spell.
	await pollUntil(dropAt + 45_000);
	expect(activations().length).toBe(before + 1);
});

test("a short connected spell keeps the redial spacing growing", async () => {
	await connectAutomaticProfile();
	nmState = "30 (disconnected)";
	activationFails = true;
	await pollUntil(240_000);
	activationFails = false;
	nmState = "100 (connected)";
	await pollUntil(now + 60_000);
	nmState = "30 (disconnected)";
	const before = activations().length;
	await pollUntil(now + 60_000);
	expect(activations().length).toBe(before);
});

for (const guard of [
	"manual profile",
	"no preparation grant",
	"not registered",
	"inhibit",
	"scanning",
	"lease",
] as const) {
	test(`a dropped automatic profile is not redialled under ${guard}`, async () => {
		await connectAutomaticProfile();
		const lease = guard === "lease" ? holdLease() : undefined;
		if (guard === "manual profile") autoconnect = "yes";
		if (guard === "no preparation grant") automaticGrant = false;
		if (guard === "not registered") mmState = "searching";
		const row = getModem(2);
		if (!row) throw new Error("Modem not registered");
		if (guard === "inhibit") row.inhibit = true;
		if (guard === "scanning") row.is_scanning = true;
		nmState = "30 (disconnected)";
		await pollUntil(600_000);
		expect(activations()).toHaveLength(1);
		lease?.release();
		autoconnect = "no";
		automaticGrant = true;
		mmState = "registered";
		const current = getModem(2);
		if (current) {
			delete current.inhibit;
			delete current.is_scanning;
		}
		await pollUntil(now + 45_000);
		expect(activations()).toHaveLength(2);
	});
}

test("activating, unavailable or unreadable device states never count as a drop", async () => {
	await connectAutomaticProfile();
	for (const state of ["40 (connecting (prepare))", "20 (unavailable)", ""]) {
		nmState = state;
		await pollUntil(now + 600_000);
	}
	expect(activations()).toHaveLength(1);
});

test("a registration loss between the two disconnected polls restarts the dwell", async () => {
	await connectAutomaticProfile();
	now = 60_000;
	nmState = "30 (disconnected)";
	await runModemStatusPoll();
	now = 75_000;
	mmState = "searching";
	await runModemStatusPoll();
	now = 90_000;
	mmState = "registered";
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
	now = 110_000;
	await runModemStatusPoll();
	expect(activations()).toHaveLength(2);
});

test("overlapping polls dial a dropped automatic profile once", async () => {
	await connectAutomaticProfile();
	nmState = "30 (disconnected)";
	now = 60_000;
	await runModemStatusPoll();
	now = 90_000;
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	onConnect = async () => {
		started.resolve();
		await release.promise;
	};
	const first = runModemStatusPoll();
	await started.promise;
	await Promise.all([runModemStatusPoll(), runModemStatusPoll()]);
	release.resolve();
	await first;
	expect(activations()).toHaveLength(2);
});

test("a failing redial raises the data-call warning once, not on every dial", async () => {
	await connectAutomaticProfile();
	nmState = "30 (disconnected)";
	activationFails = true;
	const reported: number[][] = [];
	while (now < 1_200_000) {
		now += 15_000;
		reported.push([...(await runModemReadyActivations())]);
	}
	expect(activations().length).toBeGreaterThan(3);
	expect(reported.filter((ids) => ids.includes(2))).toHaveLength(1);
	expect(getModem(2)?.data_connection_failed).toBe(true);
});

test("a redial in flight never refuses a Stream Start", async () => {
	await connectAutomaticProfile();
	nmState = "30 (disconnected)";
	now = 60_000;
	await runModemStatusPoll();
	now = 90_000;
	let admitted: boolean | undefined;
	onConnect = async () => {
		const admission = tryAcquireLifecycle("streaming");
		admitted = admission.admitted;
		if (admission.admitted) admission.lease.release();
	};
	await runModemStatusPoll();
	expect(activations()).toHaveLength(2);
	expect(admitted).toBe(true);
});

test("no redial starts while a stream is being launched", async () => {
	await connectAutomaticProfile();
	nmState = "30 (disconnected)";
	const launch = tryAcquireLifecycle("streaming");
	if (!launch.admitted) throw new Error("stream admission refused");
	await pollUntil(600_000);
	expect(activations()).toHaveLength(1);
	launch.lease.release();
	await pollUntil(now + 45_000);
	expect(activations()).toHaveLength(2);
});

test("a stale connected bearer in ModemManager with the device disconnected is redialled", async () => {
	await connectAutomaticProfile();
	nmState = "30 (disconnected)";
	mmState = "connected";
	now = 60_000;
	await runModemStatusPoll();
	now = 90_000;
	await runModemStatusPoll();
	expect(activations()).toHaveLength(2);
});

test("real nmcli output, newline-terminated, still dispatches the first activation", async () => {
	nmState = "30 (disconnected)\n";
	await runModemStatusPoll();
	expect(activations()).toEqual([["nmcli", "-w", "45", "conn", "up", UUID]]);
});

test("real nmcli output, newline-terminated, still redials a dropped automatic profile", async () => {
	await connectAutomaticProfile();
	nmState = "30 (disconnected)\n";
	now = 60_000;
	await runModemStatusPoll();
	now = 90_000;
	await runModemStatusPoll();
	expect(activations()).toHaveLength(2);
});

test("two device values are still ambiguous", async () => {
	nmState = "30 (disconnected)\n100 (connected)\n";
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
});

test("a terminated state record is accepted only when it is the sole record", async () => {
	nmState = "30 (disconnected)\n\n";
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
	nmState = "30 (disconnected)\n";
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
});
