import { expect, spyOn, test } from "bun:test";
import * as recovery from "../modules/modems/cellular-host-recovery.ts";
import { buildProjectedModemsMessage } from "../modules/modems/modem-wire-producer.ts";
import { removeModem, setModem } from "../modules/modems/modems-state.ts";

test("quarantine reason reaches full and partial modem snapshots and retracts after recovery", () => {
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
			"withdrawal-incomplete",
		);
		expect(
			buildProjectedModemsMessage({})["999"]?.availability_reason,
		).toContain("retry pending");
		status.mockReturnValue(undefined);
		expect(buildProjectedModemsMessage({})["999"]?.availability_reason).toBe(
			"",
		);
	} finally {
		status.mockRestore();
		removeModem(999);
	}
});
