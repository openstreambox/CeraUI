import { expect, test } from "bun:test";
import { admitCellularForwarding } from "./cellular-forwarding-admission.ts";

test("global host mode needs both per-link capabilities; missing, unknown and stale reads stay refused", async () => {
	let current = true,
		global = "0",
		second: string | undefined = "0";
	const physical = { ifname: "wwan0", current: async () => current },
		tun = { ifname: "cclat1", current: async () => current },
		deps = {
			global: async () => global,
			force: async (link: { ifname: string }) =>
				link.ifname === "wwan0" ? "1" : second,
		};
	expect(await admitCellularForwarding(physical, tun, deps)).toEqual({
		ok: true,
		mode: "per-link",
		original: ["1", "0"],
	});
	for (const value of [undefined, "", "true", "2"]) {
		second = value;
		expect(await admitCellularForwarding(physical, tun, deps)).toEqual({
			ok: false,
			reason: "forwarding-unavailable",
		});
	}
	global = "1";
	expect(
		await admitCellularForwarding(physical, tun, {
			...deps,
			force: async () => {
				throw new Error("old kernel");
			},
		}),
	).toEqual({ ok: false, reason: "forwarding-unavailable" });
	second = "0";
	expect(await admitCellularForwarding(physical, tun, deps)).toEqual({
		ok: true,
		mode: "per-link",
		original: ["1", "0"],
	});
	global = "0";
	second = "0";
	expect(
		await admitCellularForwarding(physical, tun, {
			...deps,
			force: async () => {
				current = false;
				return "0";
			},
		}),
	).toEqual({ ok: false, reason: "identity-unavailable" });
});
test("a changing global prerequisite and unreadable sysctls do not grant admission", async () => {
	const physical = { ifname: "wwan0", current: async () => true },
		tun = { ifname: "cclat1", current: async () => true };
	let reads = 0;
	expect(
		await admitCellularForwarding(physical, tun, {
			global: async () => (reads++ === 0 ? "0" : "1"),
			force: async () => "0",
		}),
	).toEqual({ ok: false, reason: "forwarding-unavailable" });
	expect(
		await admitCellularForwarding(physical, tun, {
			global: async () => {
				throw new Error("unreadable");
			},
			force: async () => "1",
		}),
	).toEqual({ ok: false, reason: "forwarding-unavailable" });
	await expect(
		admitCellularForwarding({ ...physical, ifname: "all" }, tun),
	).rejects.toThrow("instance");
});
