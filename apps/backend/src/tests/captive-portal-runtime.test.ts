import { expect, mock, spyOn, test } from "bun:test";

const commands: string[] = [];
const configs: Array<{ action: string; config: Record<string, unknown> }> = [];
let failOpen = false;
let unavailable = false;
let webAvailable = false;
let failSweep = false;
let failCleanupAfterOpen = false;
let aps = ["ap0"];
let routeDev = "ap0";
const binding = {
	link: {
		ifname: "venue0",
		address: "198.51.100.1",
		gateway: "198.51.100.2",
		dnsServers: ["198.51.100.2"],
	},
};
// The venue row's published incarnation; the system reader refuses any other.
const VENUE = "venue-incarnation-1";
let venueToken = VENUE;
// The phone's AP: one exact hotspot row, its kernel and netif lifetimes.
let apIfindex = 7;
let apEpoch = 41;
// NM's activation of the AP profile: a same-profile reactivation on the same
// netdev keeps the name, ifindex and UUID but gets a new active path.
let apActivePath = "/org/freedesktop/NetworkManager/ActiveConnection/5";
const apProfile = {
	path: "/org/freedesktop/NetworkManager/Settings/9",
	fingerprint: "ap-profile-fingerprint",
	file: { filename: "ap.nmconnection", device: "1", inode: "2", ctime: "3" },
};
// One-shot hooks a test sets to change the world in the middle of a request.
let duringSweep: (() => void) | undefined;
let duringNeigh: (() => void) | undefined;
let duringOpen: (() => void) | undefined;
const apRow = {
	id: 3,
	ifname: "ap0",
	hw: "Synthetic AP radio",
	conn: "ap-profile" as string | null,
	activeConn: "ap-profile" as string | null,
	activeMode: "ap",
	available: new Map(),
	saved: {},
	savedAll: {},
	hotspot: { conn: "ap-profile", warnings: {} },
};
// Partial replacements keep every other export: the AP pin pulls in modules
// that import more of these than the runtime itself does.
const realRun = { ...(await import("../helpers/run.ts")) };
const realMocks = { ...(await import("../mocks/mock-service.ts")) };
const realProbe = {
	...(await import("../modules/network/device-bound-probe.ts")),
};
const realTarget = {
	...(await import("../modules/network/uplink-health/connectivity-target.ts")),
};
const realHealth = {
	...(await import("../modules/network/uplink-health/state.ts")),
};
const realReaders = {
	...(await import("../modules/wifi/captive-portal-readers.ts")),
};
const realConnections = {
	...(await import("../modules/wifi/wifi-connections.ts")),
};
mock.module("../helpers/run.ts", () => ({
	...realRun,
	run: async (bin: string, args: string[]) => {
		if (bin === "curl") return "204";
		if (bin === "iw") return "Station 02:00:00:00:00:02 (on ap0)";
		if (args.includes("neigh")) {
			duringNeigh?.();
			duringNeigh = undefined;
		}
		if (args.includes("neigh"))
			return JSON.stringify([
				{ lladdr: "02:00:00:00:00:02", state: ["REACHABLE"] },
			]);
		if (args.includes("link"))
			return JSON.stringify([{ ifname: args.at(-1), ifindex: apIfindex }]);
		return JSON.stringify([{ dev: routeDev }]);
	},
	runWithStdin: async (_bin: string, args: string[], stdin: string) => {
		expect(args[0]).toBe("-I");
		const action = args[2]!;
		commands.push(action);
		configs.push({ action, config: JSON.parse(stdin) });
		const hook = action === "open" ? duringOpen : duringSweep;
		if (action === "open") duringOpen = undefined;
		else duringSweep = undefined;
		hook?.();
		if (action === "open" && failOpen) {
			failSweep = failCleanupAfterOpen;
			throw Error("timeout");
		}
		if (action === "sweep" && failSweep) throw Error("cleanup failure");
		return "{}";
	},
}));
mock.module("../mocks/mock-service.ts", () => ({
	...realMocks,
	shouldUseMocks: () => false,
}));
mock.module("../modules/network/device-bound-probe.ts", () => ({
	...realProbe,
	checkConnectivityViaDevice: async () => webAvailable,
}));
mock.module("../modules/network/uplink-health/connectivity-target.ts", () => ({
	...realTarget,
	createConnectivityTargetResolver: () => async () =>
		webAvailable ? "192.0.2.1" : undefined,
}));
mock.module("../modules/network/uplink-health/state.ts", () => ({
	...realHealth,
	getUplinkHealthEngine: () => ({ get: () => ({ reason: "captive_portal" }) }),
}));
mock.module("../modules/wifi/captive-portal-readers.ts", () => ({
	...realReaders,
	captureWifiPortalBindingFromSystem: async (
		_id: number,
		incarnation: string,
	) =>
		unavailable
			? { ok: false }
			: incarnation === venueToken
				? { ok: true, binding }
				: { ok: false, reason: "binding_changed" },
	createSystemPortalReaderDeps: () => ({}),
}));
mock.module("../modules/wifi/wifi-connections.ts", () => ({
	...realConnections,
	getWifiInterfacesByMacAddress: () => ({
		radio: { id: 2, activeMode: "infrastructure", ifname: "venue0" },
		// Every running AP in `aps` is a hotspot row; `ap0` is the one pinned.
		...Object.fromEntries(
			aps.map((ifname) => [
				ifname,
				ifname === "ap0" ? apRow : { ...apRow, id: 4, ifname },
			]),
		),
	}),
}));
const netifs = await import("../modules/network/network-interfaces.ts");
spyOn(netifs, "getNetworkInterfaceIncarnation").mockImplementation((name) =>
	aps.includes(name) ? apEpoch : undefined,
);
const { advanceHotspotOperation, defaultHotspotSteeringDeps } = await import(
	"../modules/wifi/wifi-hotspot-readiness.ts"
);
spyOn(defaultHotspotSteeringDeps, "readActivation").mockImplementation(
	async (ifname: string, uuid: string) =>
		aps.includes(ifname) && apRow.hotspot.conn === uuid && apRow.conn === uuid
			? { activePath: apActivePath, profile: structuredClone(apProfile) }
			: undefined,
);
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
	await expect(signInWindow.start("10.42.0.2", "2", VENUE)).rejects.toThrow(
		"timeout",
	);
	expect(commands).toEqual(["sweep", "sweep", "open", "sweep"]);
	expect(signInWindow.status("10.42.0.2").phase).toBe("idle");
	expect(await portalHealthProbe("venue0", async () => "success")).toBe(
		"success",
	);
});

test("a failed open with uncertain retirement retains ownership and converges on retry", async () => {
	// Pre-open reconciliation succeeds, then simulate cleanup becoming unavailable.
	failOpen = false;
	await signInWindow.start("10.42.0.2", "2", VENUE);
	const beforeLateBoot = commands.length;
	await reconcilePortalWindow();
	expect(commands.length).toBe(beforeLateBoot);
	expect(signInWindow.status("10.42.0.2").phase).toBe("signing_in");
	await signInWindow.finish("10.42.0.2");
	commands.length = 0;
	failOpen = true;
	// Fail only after the pre-open sweep has succeeded.
	failCleanupAfterOpen = true;
	const status = await signInWindow.start("10.42.0.2", "2", VENUE);
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

test("a later pre-config failure never closes the previous phone's config", async () => {
	failOpen = false;
	failCleanupAfterOpen = false;
	await signInWindow.start("10.42.0.2", "2", VENUE);
	await signInWindow.finish("10.42.0.2");
	commands.length = 0;
	unavailable = true;
	await expect(signInWindow.start("10.42.0.3", "2", VENUE)).rejects.toThrow(
		"identity_unavailable",
	);
	expect(commands).toEqual(["sweep"]);
	unavailable = false;
});

test("the post-close check uses the retired binding once without retaining active config", async () => {
	failOpen = false;
	webAvailable = true;
	await signInWindow.start("10.42.0.4", "2", VENUE);
	expect((await signInWindow.finish("10.42.0.4")).phase).toBe("web_available");
	commands.length = 0;
	unavailable = true;
	await expect(signInWindow.start("10.42.0.5", "2", VENUE)).rejects.toThrow(
		"identity_unavailable",
	);
	expect(commands).toEqual(["sweep"]);
	unavailable = false;
	webAvailable = false;
});

// Behind the front door the phone's arrival interface is proven. When the
// hotspot and another link use overlapping networks, the same address seen on
// the other link must not open or drive the window.
test("a proven arrival interface must be the AP the phone routes through", async () => {
	failOpen = false;
	commands.length = 0;
	await expect(
		signInWindow.start("10.42.0.6", "2", VENUE, "eth0"),
	).rejects.toThrow("not_on_box_wifi");
	// Refused before any sweep or identity read: nothing ran for that caller.
	expect(commands).toEqual([]);
	aps = ["ap0", "ap1"];
	await expect(
		signInWindow.start("10.42.0.6", "2", VENUE, "ap1"),
	).rejects.toThrow("not_on_box_wifi");
	expect(commands).not.toContain("open");
	expect((await signInWindow.start("10.42.0.6", "2", VENUE, "ap0")).phase).toBe(
		"signing_in",
	);
	expect(signInWindow.status("10.42.0.6", "eth0").phase).toBe("idle");
	expect((await signInWindow.refresh("10.42.0.6", "eth0")).phase).toBe("idle");
	await expect(signInWindow.finish("10.42.0.6", "eth0")).rejects.toThrow(
		"busy_other_phone",
	);
	expect(signInWindow.status("10.42.0.6", "ap0").phase).toBe("signing_in");
	expect((await signInWindow.finish("10.42.0.6", "ap0")).phase).toBe(
		"needs_sign_in",
	);
	aps = ["ap0"];
	routeDev = "ap0";
});

test("a stale venue incarnation refuses at entry, before any window opens", async () => {
	commands.length = 0;
	await expect(
		signInWindow.start("10.42.0.6", "2", "venue-incarnation-0"),
	).rejects.toThrow("wifi_changed");
	expect(commands).toEqual(["sweep"]);
	expect(signInWindow.status("10.42.0.6").phase).toBe("idle");
});

test("a venue incarnation that rotates before open refuses without opening", async () => {
	commands.length = 0;
	// After the entry capture, while the association evidence is read.
	duringNeigh = () => {
		venueToken = "venue-incarnation-2";
	};
	await expect(signInWindow.start("10.42.0.7", "2", VENUE)).rejects.toThrow(
		"wifi_changed",
	);
	expect(commands).not.toContain("open");
	venueToken = VENUE;
});

test("the helper receives the AP lifetime the phone arrived through", async () => {
	configs.length = 0;
	await signInWindow.start("10.42.0.8", "2", VENUE);
	const open = configs.find((entry) => entry.action === "open");
	expect(open?.config).toMatchObject({ ap: "ap0", ap_ifindex: 7 });
	expect((await signInWindow.refresh("10.42.0.8")).phase).toBe("signing_in");
	await signInWindow.finish("10.42.0.8");
});

const replacements: Record<string, () => () => void> = {
	"AP Stop/Start under the same profile, name and ifindex": () => {
		advanceHotspotOperation(apRow as never);
		return () => undefined;
	},
	"AP stopped": () => {
		apRow.conn = null;
		apRow.activeConn = null;
		return () => {
			apRow.conn = "ap-profile";
			apRow.activeConn = "ap-profile";
		};
	},
	"another AP profile on the same name": () => {
		apRow.hotspot.conn = "other-ap-profile";
		apRow.conn = "other-ap-profile";
		apRow.activeConn = "other-ap-profile";
		return () => {
			apRow.hotspot.conn = "ap-profile";
			apRow.conn = "ap-profile";
			apRow.activeConn = "ap-profile";
		};
	},
	"a new kernel interface under the same name": () => {
		apIfindex = 8;
		return () => {
			apIfindex = 7;
		};
	},
	"a new netif incarnation under the same name": () => {
		apEpoch++;
		return () => undefined;
	},
};
for (const [name, replace] of Object.entries(replacements))
	test(`${name} closes the open window without transferring it`, async () => {
		await signInWindow.start("10.42.0.9", "2", VENUE);
		configs.length = 0;
		const restore = replace();
		expect((await signInWindow.refresh("10.42.0.9")).phase).toBe(
			"needs_sign_in",
		);
		// The retirement names the original lifetime; nothing reopens for the newcomer.
		expect(configs.map((entry) => entry.action)).toEqual(["close"]);
		expect(configs[0]?.config).toMatchObject({ ap: "ap0", ap_ifindex: 7 });
		expect((await signInWindow.refresh("10.42.0.9")).phase).toBe(
			"needs_sign_in",
		);
		expect(configs.map((entry) => entry.action)).toEqual(["close"]);
		restore();
	});

test("a phone behind an AP without a pinned lifetime is refused", async () => {
	const epoch = apEpoch;
	commands.length = 0;
	spyOn(netifs, "getNetworkInterfaceIncarnation").mockImplementation(
		() => undefined,
	);
	await expect(signInWindow.start("10.42.0.10", "2", VENUE)).rejects.toThrow(
		"not_on_box_wifi",
	);
	expect(commands).not.toContain("open");
	spyOn(netifs, "getNetworkInterfaceIncarnation").mockImplementation((name) =>
		aps.includes(name) ? epoch : undefined,
	);
});

test("behind the front door, a replaced arrival AP closes the window without transfer", async () => {
	await signInWindow.start("10.42.0.11", "2", VENUE, "ap0");
	configs.length = 0;
	apIfindex = 8;
	expect((await signInWindow.refresh("10.42.0.11", "ap0")).phase).toBe(
		"needs_sign_in",
	);
	expect(configs.map((entry) => entry.action)).toEqual(["close"]);
	expect(configs[0]?.config).toMatchObject({ ap: "ap0", ap_ifindex: 7 });
	apIfindex = 7;
});

const reactivate = () => {
	apActivePath = "/org/freedesktop/NetworkManager/ActiveConnection/6";
	return () => {
		apActivePath = "/org/freedesktop/NetworkManager/ActiveConnection/5";
	};
};

test("a same-netdev reactivation of the AP profile closes the window on refresh", async () => {
	await signInWindow.start("10.42.0.12", "2", VENUE);
	configs.length = 0;
	// Same name, ifindex, netif incarnation and UUID; only NM's activation is new.
	const restore = reactivate();
	expect((await signInWindow.refresh("10.42.0.12")).phase).toBe(
		"needs_sign_in",
	);
	expect(configs.map((entry) => entry.action)).toEqual(["close"]);
	expect(configs[0]?.config).toMatchObject({ ap: "ap0", ap_ifindex: 7 });
	restore();
});

test("the arrival AP is pinned at entry, before any cleanup", async () => {
	commands.length = 0;
	const restore = reactivate();
	// An AP NM does not report active for its profile is no proven arrival.
	const original = apRow.activeConn;
	apRow.activeConn = null;
	apRow.conn = null;
	await expect(signInWindow.start("10.42.0.13", "2", VENUE)).rejects.toThrow(
		"not_on_box_wifi",
	);
	expect(commands).toEqual([]);
	apRow.activeConn = original;
	apRow.conn = original;
	restore();
	// Reactivated while the pre-open sweeps ran: the later AP is never adopted.
	duringSweep = reactivate;
	await expect(signInWindow.start("10.42.0.13", "2", VENUE)).rejects.toThrow(
		"not_on_box_wifi",
	);
	expect(commands).not.toContain("open");
	apActivePath = "/org/freedesktop/NetworkManager/ActiveConnection/5";
});

const duringInstall: Record<string, () => () => void> = {
	"the AP is replaced under its name": () => {
		apIfindex = 8;
		return () => {
			apIfindex = 7;
		};
	},
	"the AP profile is reactivated on the same netdev": reactivate,
	"the venue radio's incarnation rotates": () => {
		venueToken = "venue-incarnation-3";
		return () => {
			venueToken = VENUE;
		};
	},
};
for (const [name, change] of Object.entries(duringInstall))
	test(`the backend rechecks both ends after the helper: ${name}`, async () => {
		configs.length = 0;
		let restore: () => void = () => undefined;
		duringOpen = () => {
			restore = change();
		};
		await expect(signInWindow.start("10.42.0.14", "2", VENUE)).rejects.toThrow(
			name.includes("venue") ? "wifi_changed" : "not_on_box_wifi",
		);
		// The installed window is retired under its own pinned lifetime; nothing
		// is installed for the newcomer and nobody owns a window.
		expect(configs.map((entry) => entry.action)).toEqual([
			"sweep",
			"open",
			"close",
		]);
		expect(configs[2]?.config).toMatchObject({ ap: "ap0", ap_ifindex: 7 });
		expect(signInWindow.status("10.42.0.14").phase).toBe("idle");
		expect(await portalHealthProbe("venue0", async () => "success")).toBe(
			"success",
		);
		restore();
	});
