import { describe, expect, it } from "bun:test";
import {
	createNmCheckpointAdapter,
	splitTerse,
} from "./network-checkpoint-nm.ts";

const NM = "org.freedesktop.NetworkManager";
const CP = "/org/freedesktop/NetworkManager/Checkpoint/1";
const REF = { path: CP, owner: ":1.42", created: "123456" };

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

	it("creates the checkpoint on the daemon that owns the bus name, and returns its identity", async () => {
		const calls: string[][] = [];
		const nm = createNmCheckpointAdapter(async (bin, args) => {
			expect(bin).toBe("busctl");
			calls.push(args);
			if (args.includes("GetNameOwner"))
				return JSON.stringify({ data: [":1.42"] });
			if (args.includes("Created"))
				return JSON.stringify({ type: "x", data: 123456 });
			return JSON.stringify({
				data: [args.includes("GetDeviceByIpIface") ? "/device/1" : CP],
			});
		});
		expect(await nm.create(["eth0"], 90)).toEqual({
			path: CP,
			owner: ":1.42",
			created: "123456",
		});
		expect(calls[0]?.slice(-3)).toEqual(["GetNameOwner", "s", NM]);
		// Every call after that goes to the unique name, not the well-known one.
		expect(calls[1]?.slice(3, 4)).toEqual([":1.42"]);
		expect(calls[1]?.slice(-3)).toEqual(["GetDeviceByIpIface", "s", "eth0"]);
		expect(calls[2]?.slice(3, 4)).toEqual([":1.42"]);
		expect(calls[2]?.slice(-6)).toEqual([
			"CheckpointCreate",
			"aouu",
			"1",
			"/device/1",
			"90",
			"0",
		]);
		expect(calls[3]?.slice(-5)).toEqual([
			"get-property",
			":1.42",
			CP,
			`${NM}.Checkpoint`,
			"Created",
		]);
	});
	it("refuses to create without a complete identity", async () => {
		const answer = (stamp: unknown, owner: unknown = ":1.42") =>
			createNmCheckpointAdapter(async (_bin, args) => {
				if (args.includes("GetNameOwner"))
					return JSON.stringify({ data: [owner] });
				if (args.includes("Created")) return JSON.stringify(stamp);
				return JSON.stringify({
					data: [args.includes("GetDeviceByIpIface") ? "/device/1" : CP],
				});
			});
		for (const stamp of [
			{ type: "s", data: "123" },
			{ type: "x", data: 0 },
			{ type: "x", data: -5 },
			{ type: "x", data: 1.5 },
			{ type: "x" },
		])
			await expect(answer(stamp).create(["eth0"], 90)).rejects.toThrow(
				"identity",
			);
		await expect(
			answer({ type: "x", data: 1 }, "org.freedesktop.NetworkManager").create(
				["eth0"],
				90,
			),
		).rejects.toThrow("unavailable");
	});
	it("is live only on the same daemon, listed, with the same stamp", async () => {
		let owner = ":1.42";
		let listed: string[] = [CP];
		let stamp = 123456;
		const nm = createNmCheckpointAdapter(async (_bin, args) => {
			if (args.includes("GetNameOwner"))
				return JSON.stringify({ data: [owner] });
			if (args.includes("Created"))
				return JSON.stringify({ type: "x", data: stamp });
			return JSON.stringify({ data: listed });
		});
		expect(await nm.live(REF)).toBe(true);
		stamp = 999;
		expect(await nm.live(REF)).toBe(false);
		stamp = 123456;
		listed = [];
		expect(await nm.live(REF)).toBe(false);
		listed = [CP];
		// NetworkManager restarted: a new daemon, even with the same path.
		owner = ":1.77";
		expect(await nm.live(REF)).toBe(false);
	});
	it("sends destroy and rollback to the daemon that made the checkpoint", async () => {
		const calls: string[][] = [];
		const nm = createNmCheckpointAdapter(async (_bin, args) => {
			calls.push(args);
			return args.includes("CheckpointRollback")
				? JSON.stringify({ data: [{ "/device/1": 0 }] })
				: "";
		});
		await nm.destroy(REF);
		await nm.rollback(REF);
		expect(calls.map((c) => c[3])).toEqual([":1.42", ":1.42"]);
		expect(calls[0]?.slice(-2)).toEqual(["o", CP]);
	});
	it("surfaces per-device rollback failures", async () => {
		const nm = createNmCheckpointAdapter(async () =>
			JSON.stringify({ data: [{ "/device/1": 1 }] }),
		);
		await expect(nm.rollback(REF)).rejects.toThrow("incomplete");
	});
	it("refuses malformed checkpoint references before dispatch", async () => {
		let dispatched = false;
		const nm = createNmCheckpointAdapter(async () => {
			dispatched = true;
			return "";
		});
		for (const ref of [
			{ ...REF, path: "--help" },
			{ ...REF, path: "/org/freedesktop/NetworkManager/Devices/1" },
			{ ...REF, owner: NM },
			{ ...REF, owner: "--address=x" },
			{ ...REF, created: "abc" },
			{ ...REF, created: "" },
		]) {
			await expect(nm.destroy(ref)).rejects.toThrow("Invalid");
			await expect(nm.rollback(ref)).rejects.toThrow("Invalid");
			await expect(nm.live(ref)).rejects.toThrow("Invalid");
		}
		expect(dispatched).toBe(false);
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
