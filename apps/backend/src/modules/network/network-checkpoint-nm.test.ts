import { describe, expect, it } from "bun:test";
import { createNmCheckpointAdapter } from "./network-checkpoint-nm.ts";

describe("NetworkManager checkpoint D-Bus adapter", () => {
	it("refuses option-shaped device identifiers before dispatch", async () => {
		let dispatched = false;
		const nm = createNmCheckpointAdapter(async () => {
			dispatched = true;
			return "";
		});
		await expect(
			nm.create(["--address=tcp:example.invalid"], 90),
		).rejects.toThrow();
		expect(dispatched).toBe(false);
	});

	it("resolves exact devices and arms cleanup of new profiles without destroying another checkpoint", async () => {
		const calls: string[][] = [];
		const nm = createNmCheckpointAdapter(async (bin, args) => {
			expect(bin).toBe("busctl");
			calls.push(args);
			return JSON.stringify({
				data: [
					args.includes("GetDeviceByIpIface") ? "/device/1" : "/checkpoint/1",
				],
			});
		});
		expect(await nm.create(["eth0"], 90)).toBe("/checkpoint/1");
		expect(calls[0]?.slice(-3)).toEqual(["GetDeviceByIpIface", "s", "eth0"]);
		expect(calls[1]?.slice(-6)).toEqual([
			"CheckpointCreate",
			"aouu",
			"1",
			"/device/1",
			"90",
			"2",
		]);
	});
	it("does not infer liveness from process-local state", async () => {
		let live: string[] = ["/checkpoint/1"];
		const nm = createNmCheckpointAdapter(async () =>
			JSON.stringify({ data: live }),
		);
		expect(await nm.live("/checkpoint/1")).toBe(true);
		live = [];
		expect(await nm.live("/checkpoint/1")).toBe(false);
	});
	it("surfaces per-device rollback failures", async () => {
		const nm = createNmCheckpointAdapter(async () =>
			JSON.stringify({ data: [{ "/device/1": 1 }] }),
		);
		await expect(nm.rollback("/checkpoint/1")).rejects.toThrow("incomplete");
	});
	it("saves only the profile resolved by its UUID", async () => {
		const calls: string[][] = [];
		const nm = createNmCheckpointAdapter(async (_bin, args) => {
			calls.push(args);
			return args.includes("GetConnectionByUuid")
				? JSON.stringify({ data: ["/connection/1"] })
				: "";
		});
		await nm.save("00000000-0000-4000-8000-000000000001");
		expect(calls[1]?.slice(-3)).toEqual([
			"/connection/1",
			"org.freedesktop.NetworkManager.Settings.Connection",
			"Save",
		]);
	});
});
