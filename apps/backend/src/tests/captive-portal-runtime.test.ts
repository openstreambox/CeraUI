import { expect, mock, test } from "bun:test";

const commands: string[] = [];
let failOpen = false;
let failSweep = false;
let failCleanupAfterOpen = false;
const binding = {
	link: {
		ifname: "venue0",
		address: "198.51.100.1",
		gateway: "198.51.100.2",
		dnsServers: ["198.51.100.2"],
	},
};
mock.module("../helpers/run.ts", () => ({
	run: async (bin: string, args: string[]) => {
		if (bin === "iw") return "Station 02:00:00:00:00:02 (on ap0)";
		if (args.includes("neigh"))
			return JSON.stringify([
				{ lladdr: "02:00:00:00:00:02", state: ["REACHABLE"] },
			]);
		return JSON.stringify([{ dev: "ap0" }]);
	},
	runWithStdin: async (_bin: string, args: string[]) => {
		expect(args[0]).toBe("-I");
		const action = args[2]!;
		commands.push(action);
		if (action === "open" && failOpen) {
			failSweep = failCleanupAfterOpen;
			throw Error("timeout");
		}
		if (action === "sweep" && failSweep) throw Error("cleanup failure");
		return "{}";
	},
}));
mock.module("../mocks/mock-service.ts", () => ({
	shouldUseMocks: () => false,
}));
mock.module("../modules/network/device-bound-probe.ts", () => ({
	checkConnectivityViaDevice: async () => false,
}));
mock.module("../modules/network/uplink-health/connectivity-target.ts", () => ({
	createConnectivityTargetResolver: () => async () => undefined,
}));
mock.module("../modules/network/uplink-health/state.ts", () => ({
	getUplinkHealthEngine: () => ({ get: () => ({ reason: "captive_portal" }) }),
}));
mock.module("../modules/wifi/captive-portal-readers.ts", () => ({
	captureWifiPortalBindingFromSystem: async () => ({ ok: true, binding }),
	createSystemPortalReaderDeps: () => ({}),
}));
mock.module("../modules/wifi/wifi-connections.ts", () => ({
	getWifiInterfacesByMacAddress: () => ({
		radio: { id: 2, activeMode: "infrastructure", ifname: "venue0" },
	}),
}));
mock.module("../modules/wifi/wifi-hotspot-clients.ts", () => ({
	currentHotspotApIfnames: () => ["ap0"],
}));
const { signInWindow, reconcilePortalWindow } = await import(
	"../modules/wifi/captive-portal-runtime.ts"
);
const { portalHealthProbe } = await import(
	"../modules/wifi/captive-portal-health.ts"
);

test("startup sweeps without an in-memory session; interrupted open sweeps before reporting failure", async () => {
	await reconcilePortalWindow();
	expect(commands).toEqual(["sweep"]);
	failOpen = true;
	await expect(signInWindow.start("10.42.0.2", "2")).rejects.toThrow("timeout");
	expect(commands).toEqual(["sweep", "sweep", "open", "sweep"]);
	expect(signInWindow.status("10.42.0.2").phase).toBe("idle");
	expect(await portalHealthProbe("venue0", async () => "success")).toBe(
		"success",
	);
});

test("a failed open with uncertain retirement retains ownership and converges on retry", async () => {
	// Pre-open reconciliation succeeds, then simulate cleanup becoming unavailable.
	failOpen = false;
	await signInWindow.start("10.42.0.2", "2");
	const beforeLateBoot = commands.length;
	await reconcilePortalWindow();
	expect(commands.length).toBe(beforeLateBoot);
	expect(signInWindow.status("10.42.0.2").phase).toBe("signing_in");
	await signInWindow.finish("10.42.0.2");
	commands.length = 0;
	failOpen = true;
	// Fail only after the pre-open sweep has succeeded.
	failCleanupAfterOpen = true;
	const status = await signInWindow.start("10.42.0.2", "2");
	expect(status.phase).toBe("cleanup_unknown");
	expect(status.expiresAt).toBeGreaterThan(Date.now());
	expect(await portalHealthProbe("venue0", async () => "success")).toBe(
		"captive_portal",
	);
	failSweep = false;
	expect((await signInWindow.refresh("10.42.0.2")).phase).toBe("needs_sign_in");
	expect(await portalHealthProbe("venue0", async () => "success")).toBe(
		"success",
	);
});
