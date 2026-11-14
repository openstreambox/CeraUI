import { expect, test } from "bun:test";
import type { DbusTransportOptions } from "@ceralive/modem-control/transport";
import { createCellularSystemTransport } from "../modules/modems/modems.ts";

test("the cellular facade pins the system bus and cannot inherit a session socket", () => {
	const previous = process.env.DBUS_SYSTEM_BUS_ADDRESS;
	const seen: DbusTransportOptions[] = [];
	try {
		delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
		const options = {
			reconnect: { enabled: false },
			callTimeoutMs: 5000,
			socket: "/synthetic/session",
		};
		createCellularSystemTransport(options, (value) => {
			seen.push(value ?? {});
			return {} as never;
		});
		expect(seen[0]).toEqual({
			reconnect: { enabled: false },
			callTimeoutMs: 5000,
			busAddress: "unix:path=/run/dbus/system_bus_socket",
		});
		process.env.DBUS_SYSTEM_BUS_ADDRESS = "unix:path=/synthetic/system";
		createCellularSystemTransport(options, (value) => {
			seen.push(value ?? {});
			return {} as never;
		});
		expect(seen[1]?.busAddress).toBe("unix:path=/synthetic/system");
		expect(seen[1]).not.toHaveProperty("socket");
	} finally {
		if (previous === undefined) delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
		else process.env.DBUS_SYSTEM_BUS_ADDRESS = previous;
	}
});
