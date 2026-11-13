import { expect, spyOn, test } from "bun:test";
import * as recovery from "../modules/modems/cellular-host-recovery.ts";
import * as adapters from "../modules/modems/modem-wire-adapters.ts";
import { buildProjectedModemsMessage } from "../modules/modems/modem-wire-producer.ts";
import { removeModem, setModem } from "../modules/modems/modems-state.ts";

test("quarantine reason reaches full and partial modem snapshots and retracts after recovery", () => {
	let existingReason = false;
	const originalAdapter = adapters.fromMmcliModem;
	const adapter = spyOn(adapters, "fromMmcliModem").mockImplementation(
		(...args) => {
			const source = originalAdapter(...args);
			return existingReason
				? {
						...source,
						additive: {
							...source.additive,
							availability_reason: "modem_initializing",
						},
					}
				: source;
		},
	);
	const status = spyOn(recovery, "cellularRecoveryStatus").mockImplementation(
		(iface) => (iface === "wwan999" ? "withdrawal-incomplete" : undefined),
	);
	setModem(999, {
		ifname: "wwan999",
		name: "Synthetic modem",
		sim_network: "",
		network_type: { supported: {}, active: null },
		status: {
			connection: "connected",
			network: "",
			network_type: "LTE",
			signal: 50,
			roaming: false,
		},
	});
	try {
		expect(buildProjectedModemsMessage()["999"]?.availability_reason).toContain(
			"host_recovery_pending",
		);
		expect(
			buildProjectedModemsMessage({})["999"]?.availability_reason,
		).toContain("host_recovery_pending");
		existingReason = true;
		expect(buildProjectedModemsMessage()["999"]?.availability_reason).toBe(
			"modem_initializing",
		);
		expect(buildProjectedModemsMessage({})["999"]?.availability_reason).toBe(
			"modem_initializing",
		);
		existingReason = false;
		status.mockReturnValue(undefined);
		expect(buildProjectedModemsMessage({})["999"]?.availability_reason).toBe(
			"",
		);
		removeModem(999);
		buildProjectedModemsMessage();
		setModem(999, {
			ifname: "new999",
			name: "Replacement",
			sim_network: "",
			network_type: { supported: {}, active: null },
			status: {
				connection: "connected",
				network: "",
				network_type: "LTE",
				signal: 50,
				roaming: false,
			},
		});
		expect(
			buildProjectedModemsMessage({})["999"]?.availability_reason,
		).toBeUndefined();
	} finally {
		status.mockRestore();
		adapter.mockRestore();
		removeModem(999);
	}
});
