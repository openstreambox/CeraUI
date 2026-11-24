import { afterEach, describe, expect, test } from "bun:test";
import {
	findModemNmDeviceForConnection,
	type ModemNmDeviceReader,
	resolveModemNmDeviceForConnection,
	setModemNmDeviceReaderForTest,
} from "./modem-nm-device.ts";

const UUID = "9b0c1f3e-4f4f-4a51-9a51-3a0d1b7e2c11";

function reader(
	rows: readonly string[] | undefined,
	props: Record<string, readonly string[] | undefined>,
): ModemNmDeviceReader {
	return {
		listDevices: async () => rows,
		deviceProp: async (device, fields) => props[`${device} ${fields}`],
	};
}

/*
  The dead-bearer reconnect keeps a link out of the bond while its device may
  still be deactivating, so it has to tell "NetworkManager says no device
  carries this connection" from "the read failed".
*/
describe("findModemNmDeviceForConnection", () => {
	afterEach(() => setModemNmDeviceReaderForTest(null));

	test("the device carrying the connection", async () => {
		setModemNmDeviceReaderForTest(
			reader(["cdc-wdm0:gsm"], { "cdc-wdm0 GENERAL.CON-UUID": [UUID] }),
		);
		expect(await findModemNmDeviceForConnection(UUID)).toBe("cdc-wdm0");
	});

	test("null when NetworkManager answered and no device carries it", async () => {
		setModemNmDeviceReaderForTest(
			reader(["cdc-wdm0:gsm"], {
				"cdc-wdm0 GENERAL.CON-UUID": [""],
				"cdc-wdm0 CONNECTIONS.AVAILABLE-CONNECTIONS": [],
			}),
		);
		expect(await findModemNmDeviceForConnection(UUID)).toBeNull();
		expect(await resolveModemNmDeviceForConnection(UUID)).toBeUndefined();
	});

	test("undefined when the device list cannot be read", async () => {
		setModemNmDeviceReaderForTest(reader(undefined, {}));
		expect(await findModemNmDeviceForConnection(UUID)).toBeUndefined();
	});

	test("undefined when a candidate's properties cannot be read", async () => {
		setModemNmDeviceReaderForTest(
			reader(["cdc-wdm0:gsm"], {
				"cdc-wdm0 CONNECTIONS.AVAILABLE-CONNECTIONS": [],
			}),
		);
		expect(await findModemNmDeviceForConnection(UUID)).toBeUndefined();
	});
});
