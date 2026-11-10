import { beforeEach, expect, test } from "bun:test";
import {
	getHotspotCredentials,
	rememberHotspotCredentials,
	resetHotspotCredentialsForTest,
} from "../modules/wifi/hotspot-credentials.ts";
import {
	configureHotspotProfile,
	deleteHotspotProfile,
	type HotspotProfileDeps,
} from "../modules/wifi/wifi-hotspot-profile.ts";

const mac = "02:00:00:00:00:01";
let profiles: Map<string, Record<string, string>>;
let calls: string[];
let deps: HotspotProfileDeps;
beforeEach(() => {
	resetHotspotCredentialsForTest();
	profiles = new Map();
	calls = [];
	deps = {
		settings: async (uuid, keys) =>
			Object.fromEntries(
				keys.map((key) => [key, profiles.get(uuid)?.[key] ?? ""]),
			),
		active: async () => false,
		list: async () => [...profiles.keys()],
		read: async (uuid) => {
			const p = profiles.get(uuid);
			return (
				p && [
					p["connection.id"] ?? "",
					p["802-11-wireless.mode"] ?? "",
					p["802-11-wireless.mac-address"] ?? "",
				]
			);
		},
		add: async (p) => {
			calls.push("add");
			const uuid = p["connection.uuid"];
			if (!uuid) throw new Error("missing UUID");
			profiles.set(uuid, p);
			return p["connection.uuid"];
		},
		update: async (uuid, p) => {
			calls.push("update");
			const profile = profiles.get(uuid);
			if (!profile) return false;
			Object.assign(profile, p);
			return true;
		},
		delete: async (uuid) => {
			calls.push(`delete:${uuid}`);
			return profiles.delete(uuid);
		},
	};
});
const settings = {
	"802-11-wireless.ssid": "Example",
	"802-11-wireless-security.psk": "example-password",
};
test("configure off creates one inactive shared AP and updates it after restart without activation", async () => {
	const uuid = await configureHotspotProfile(mac, settings, deps);
	expect(profiles.get(uuid)).toMatchObject({
		"connection.autoconnect": "no",
		"802-11-wireless.mode": "ap",
		"ipv4.method": "shared",
	});
	resetHotspotCredentialsForTest();
	expect(
		await configureHotspotProfile(
			mac,
			{ ...settings, "802-11-wireless.ssid": "Updated" },
			deps,
		),
	).toBe(uuid);
	expect(calls).toEqual(["add", "update"]);
	expect(profiles.size).toBe(1);
});
test("delete restores no setup, is idempotent and preserves foreign profiles including an adopted UUID", async () => {
	profiles.set("foreign", {
		"connection.id": "Personal AP",
		"802-11-wireless.mode": "ap",
		"802-11-wireless.mac-address": mac,
	});
	rememberHotspotCredentials(mac, {
		ssid: "Example",
		password: "example-password",
		conn: "foreign",
	});
	const uuid = await configureHotspotProfile(mac, settings, deps);
	await deleteHotspotProfile(mac, deps);
	await deleteHotspotProfile(mac, deps);
	expect(getHotspotCredentials(mac)).toBeUndefined();
	expect([...profiles.keys()]).toEqual(["foreign"]);
	expect(calls).toEqual(["add", `delete:${uuid}`]);
});
test("prepared-only identity can be forgotten", async () => {
	rememberHotspotCredentials(mac, {
		ssid: "Example",
		password: "example-password",
	});
	await deleteHotspotProfile(mac, deps);
	expect(getHotspotCredentials(mac)).toBeUndefined();
	expect(calls).toEqual([]);
});
test("failed delete retains identity for retry and never touches a foreign profile", async () => {
	const uuid = await configureHotspotProfile(mac, settings, deps);
	rememberHotspotCredentials(mac, {
		ssid: "Example",
		password: "example-password",
		conn: uuid,
	});
	const failing = { ...deps, delete: async () => false };
	await expect(deleteHotspotProfile(mac, failing)).rejects.toThrow();
	expect(getHotspotCredentials(mac)?.conn).toBe(uuid);
	await deleteHotspotProfile(mac, deps);
	expect(profiles.size).toBe(0);
});
test("failed creation readback rolls back only the allocated UUID", async () => {
	await expect(
		configureHotspotProfile(mac, settings, {
			...deps,
			read: async () => undefined,
		}),
	).rejects.toThrow();
	expect(profiles.size).toBe(0);
	expect(calls[0]).toBe("add");
	expect(calls[1]).toStartWith("delete:");
});
test("uncertain enumeration does not forget ownership or write profiles", async () => {
	rememberHotspotCredentials(mac, {
		ssid: "Example",
		password: "example-password",
	});
	await expect(
		deleteHotspotProfile(mac, { ...deps, list: async () => undefined }),
	).rejects.toThrow();
	expect(getHotspotCredentials(mac)).toBeDefined();
	expect(calls).toEqual([]);
});

test("restart cannot delete an active or uncertain NM profile even with no runtime state", async () => {
	const uuid = await configureHotspotProfile(mac, settings, deps);
	for (const state of [true, undefined]) {
		await expect(
			deleteHotspotProfile(mac, { ...deps, active: async () => state }),
		).rejects.toThrow();
		expect(profiles.has(uuid)).toBe(true);
	}
});

test("failed durable save rolls back a new profile and restores an existing profile", async () => {
	const fail = () => {
		throw new Error("storage unavailable");
	};
	await expect(
		configureHotspotProfile(mac, settings, deps, fail),
	).rejects.toThrow();
	expect(profiles.size).toBe(0);
	const uuid = await configureHotspotProfile(mac, settings, deps);
	const before = { ...profiles.get(uuid) };
	await expect(
		configureHotspotProfile(
			mac,
			{ ...settings, "802-11-wireless.ssid": "Changed" },
			deps,
			fail,
		),
	).rejects.toThrow();
	expect(profiles.get(uuid)).toEqual(before);
});
