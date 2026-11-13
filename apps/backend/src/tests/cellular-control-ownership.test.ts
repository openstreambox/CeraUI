import { expect, test } from "bun:test";
import type {
	DbusTransport,
	MethodCall,
	SignalListener,
} from "@ceralive/modem-control/transport";
import {
	acquireCellularControl,
	type CellularControlAcquireDeps,
	type CellularControlTarget,
	parseCellularSubscriber,
} from "../modules/modems/modems.ts";

const target = {
	key: "synthetic-key",
	id: 1,
	deviceId: "synthetic-device",
	simId: "89000000000000000000",
	subscriber: "000000000000001",
	usbDevice: "synthetic-usb",
	generation: "epoch-one",
	serial: {
		usbDevice: "synthetic-usb",
		usbInterface: "02",
		generation: "epoch-one",
	},
	identity: {
		model: "RM520N-GL",
		firmware: "RM520NGLAAR01A08M4G",
		mode: "qmi",
	},
	sim: { modemInfo: { "modem.generic.device": "synthetic-usb" }, simInfo: {} },
} as CellularControlTarget;
function fixture() {
	let connected = false,
		ack = true,
		subscriber = "000000000000001";
	let signal: SignalListener | undefined;
	let disconnected: (() => void) | undefined;
	const calls: MethodCall[] = [];
	const serial: string[] = [];
	const transport: DbusTransport = {
		connect: async () => {
			connected = true;
		},
		disconnect: async () => {
			connected = false;
		},
		isConnected: () => connected,
		callMethod: async (call) => {
			calls.push(call);
			return { signature: ack ? "" : "s", body: ack ? [] : ["unexpected"] };
		},
		subscribeSignal: async (_spec, listener) => {
			signal = listener;
			return { unsubscribe: async () => {} };
		},
		on: (event, handler) => {
			if (event === "disconnected") disconnected = handler;
		},
		off: () => {},
		subscriptionCount: () => (signal ? 1 : 0),
	};
	const deps: CellularControlAcquireDeps = {
		present: async () => true,
		pair: async () => true,
		resolveUid: async () => "synthetic-usb",
		transport: (options) => {
			expect(options?.reconnect?.enabled).toBe(false);
			return transport;
		},
		exchange: async (_identity, command, valid) => {
			expect(await valid()).toBe(true);
			serial.push(command);
			if (command === "AT+CIMI") return `\r\n${subscriber}\r\nOK\r\n`;
			if (command === 'AT+QMAP="auto_connect"')
				return '\r\n+QMAP: "auto_connect",0,0\r\nOK\r\n';
			return "\r\nOK\r\n";
		},
	};
	return {
		deps,
		transport,
		calls,
		serial,
		connected: () => connected,
		badAck: () => {
			ack = false;
		},
		subscriber: (value: string) => {
			subscriber = value;
		},
		lostOwner: () =>
			signal?.({
				interface: "org.freedesktop.DBus",
				member: "NameOwnerChanged",
				path: "/org/freedesktop/DBus",
				signature: "sss",
				sender: "org.freedesktop.DBus",
				body: ["org.freedesktop.ModemManager1", ":1.1", ":1.2"],
			}),
		disconnect: () => disconnected?.(),
	};
}
test("inhibition is acknowledged with the long timeout and held until explicit release", async () => {
	const f = fixture();
	const control = await acquireCellularControl(target, undefined, f.deps);
	expect(f.calls[0]).toMatchObject({
		member: "InhibitDevice",
		args: ["synthetic-usb", true],
		timeoutMs: 300000,
	});
	expect(await control.valid()).toBe(true);
	expect(await control.readAutoConnect()).toBe(0);
	await control.close();
	expect(f.calls[1]).toMatchObject({
		args: ["synthetic-usb", false],
		timeoutMs: 10000,
	});
	expect(f.connected()).toBe(false);
	expect(await control.valid()).toBe(false);
});
test("a malformed grant or subscriber mismatch closes ownership before any setter", async () => {
	for (const fail of ["ack", "subscriber"]) {
		const f = fixture();
		if (fail === "ack") f.badAck();
		else f.subscriber("not-a-subscriber");
		await expect(
			acquireCellularControl(target, undefined, f.deps),
		).rejects.toThrow();
		expect(f.connected()).toBe(false);
		expect(f.serial.every((command) => command === "AT+CIMI")).toBe(true);
	}
});
test("service ownership loss revokes the serial session and never uninhibits its replacement", async () => {
	const f = fixture();
	const control = await acquireCellularControl(target, undefined, f.deps);
	f.lostOwner();
	expect(await control.valid()).toBe(false);
	await control.close();
	expect(f.calls).toHaveLength(1);
	expect(f.connected()).toBe(false);
});
test("subscriber matching is whole-field digits only", () => {
	expect(parseCellularSubscriber("AT+CIMI\r\n000000000000001\r\nOK\r\n")).toBe(
		"000000000000001",
	);
	for (const reply of [
		"+CIMI: 000000000000001\r\nOK\r\n",
		"000000000000001 trailing\r\nOK\r\n",
		"000000000000001\r\n000000000000002\r\nOK\r\n",
		"ERROR",
	])
		expect(parseCellularSubscriber(reply)).toBeUndefined();
});

test("retained control distinguishes a positively changed subscriber from an unreadable response", async () => {
	const f = fixture(),
		control = await acquireCellularControl(target, undefined, f.deps);
	try {
		expect(await control.readSubscriber()).toBe(target.subscriber);
		f.subscriber("unreadable");
		expect(await control.readSubscriber()).toBeUndefined();
		expect(await control.verifySubscriber()).toBe(false);
		f.subscriber("000000000000002");
		expect(await control.valid()).toBe(true);
		expect(await control.readSubscriber()).toBe("000000000000002");
		expect(await control.verifySubscriber()).toBe(false);
		await expect(control.disableAutoConnect()).rejects.toThrow();
		expect(f.serial.every((command) => command === "AT+CIMI")).toBe(true);
	} finally {
		await control.close();
	}
});

test("a pending close invalidates serial reads immediately and concurrent callers join its release", async () => {
	const f = fixture(),
		control = await acquireCellularControl(target, undefined, f.deps),
		disconnect = f.transport.disconnect;
	let unblock: () => void = () => {},
		disconnects = 0;
	let entered: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	f.transport.disconnect = async () => {
		disconnects++;
		entered();
		await new Promise<void>((resolve) => {
			unblock = resolve;
		});
		await disconnect();
	};
	const first = control.close(),
		second = control.close();
	expect(await control.valid()).toBe(false);
	await started;
	expect(disconnects).toBe(1);
	expect(f.calls.filter((call) => call.args?.[1] === false)).toHaveLength(1);
	unblock();
	await Promise.all([first, second]);
	expect(f.connected()).toBe(false);
});

test("an uncertain disconnect is retained for retry without repeating uninhibition", async () => {
	const f = fixture(),
		control = await acquireCellularControl(target, undefined, f.deps),
		disconnect = f.transport.disconnect;
	let attempts = 0;
	f.transport.disconnect = async () => {
		if (++attempts === 1) throw new Error("Disconnect not acknowledged");
		await disconnect();
	};
	await expect(control.close()).rejects.toThrow("not acknowledged");
	expect(await control.valid()).toBe(false);
	expect(f.connected()).toBe(true);
	await control.close();
	expect(attempts).toBe(2);
	expect(f.calls.filter((call) => call.args?.[1] === false)).toHaveLength(1);
	expect(f.connected()).toBe(false);
});

test("a lost uninhibition reply still closes its connection and retries only closure", async () => {
	const f = fixture(),
		control = await acquireCellularControl(target, undefined, f.deps);
	f.badAck();
	await expect(control.close()).rejects.toThrow("acknowledgement");
	expect(f.connected()).toBe(false);
	await control.close();
	expect(f.calls.filter((call) => call.args?.[1] === false)).toHaveLength(1);
});
