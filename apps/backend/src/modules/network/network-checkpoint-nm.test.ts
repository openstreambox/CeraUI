import { describe, expect, it } from "bun:test";
import {
	createNmCheckpointAdapter,
	splitTerse,
} from "./network-checkpoint-nm.ts";

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

describe("NetworkManager candidate profiles through nmcli", () => {
	const A = "00000000-0000-4000-8000-00000000000a";
	const B = "00000000-0000-4000-8000-00000000000b";
	function scripted(responses: Record<string, string>) {
		const calls: string[][] = [];
		const nm = createNmCheckpointAdapter(async (bin, args) => {
			expect(bin).toBe("nmcli");
			calls.push(args);
			const key = Object.keys(responses).find((k) =>
				args.join(" ").includes(k),
			);
			return key ? (responses[key] as string) : "";
		});
		return { nm, calls };
	}
	it("splits terse output at unescaped colons only", () => {
		expect(splitTerse("a\\:b:c\\\\d:")).toEqual(["a:b", "c\\d", ""]);
	});
	it("clones in memory only, under an owned name, and returns the clone's UUID", async () => {
		const { nm, calls } = scripted({
			"UUID,NAME": `${A}:Home\\: Wi-Fi\n${B}:ceralive-candidate-0123abcd-0\n`,
		});
		expect(await nm.cloneCandidate(A, "ceralive-candidate-0123abcd-0")).toBe(B);
		expect(calls[0]).toEqual([
			"connection",
			"clone",
			"--temporary",
			"uuid",
			A,
			"ceralive-candidate-0123abcd-0",
		]);
		await expect(nm.cloneCandidate(A, "Home")).rejects.toThrow(
			"Invalid candidate name",
		);
		await expect(
			nm.cloneCandidate("--help", "ceralive-candidate-0123abcd-0"),
		).rejects.toThrow();
	});
	it("edits candidates only with --temporary and validated property names", async () => {
		const { nm, calls } = scripted({});
		await nm.modifyInMemory(B, [["ipv4.addresses", "192.0.2.2/24"]]);
		expect(calls[0]).toEqual([
			"connection",
			"modify",
			"--temporary",
			"uuid",
			B,
			"ipv4.addresses",
			"192.0.2.2/24",
		]);
		await expect(
			nm.modifyInMemory(B, [["--temporary", "x"]]),
		).rejects.toThrow();
		await expect(nm.modifyInMemory(B, [])).rejects.toThrow();
	});
	it("promotes with a persistent modify, which writes the profile to disk", async () => {
		const { nm, calls } = scripted({});
		await nm.persist(B, "Home: Wi-Fi", true);
		expect(calls[0]).toEqual([
			"connection",
			"modify",
			"uuid",
			B,
			"connection.id",
			"Home: Wi-Fi",
			"connection.autoconnect",
			"yes",
		]);
		expect(calls[0]).not.toContain("--temporary");
	});
	it("reads the active profile per device and the original's name and autoconnect", async () => {
		const { nm } = scripted({
			"--active": `${A}:eth0\n${B}:wlan0\n`,
			"connection.id": "Home\\: Wi-Fi\n",
			"connection.autoconnect": "no\n",
		});
		expect(await nm.activeOn("wlan0")).toBe(B);
		expect(await nm.activeOn("wwan0")).toBeUndefined();
		expect(await nm.describe(A)).toEqual({
			id: "Home: Wi-Fi",
			autoconnect: false,
		});
	});
	it("removes idempotently and lists only names it owns", async () => {
		const { nm, calls } = scripted({
			"UUID,NAME": `${A}:ceralive-candidate-0123abcd-0\n${B}:ceralive-candidate-lookalike\n`,
		});
		expect(await nm.listByPrefix("ceralive-candidate-")).toEqual([A]);
		await nm.remove(B);
		await nm.remove("00000000-0000-4000-8000-0000000000ff");
		expect(calls.filter((c) => c[1] === "delete")).toEqual([
			["connection", "delete", "uuid", B],
		]);
	});
	it("activates on one validated interface", async () => {
		const { nm, calls } = scripted({});
		await nm.activate(B, "eth0");
		expect(calls[0]).toEqual([
			"--wait",
			"30",
			"connection",
			"up",
			"uuid",
			B,
			"ifname",
			"eth0",
		]);
		await expect(nm.activate(B, "-x")).rejects.toThrow();
	});
});
