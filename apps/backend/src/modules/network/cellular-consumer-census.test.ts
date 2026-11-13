import { expect, test } from "bun:test";
import {
	type CellularConsumerCensusIO,
	cellularConsumersAbsent,
} from "./cellular-consumer-census.ts";

function fixture() {
	const fields = {
		LoadState: "loaded",
		ActiveState: "activating",
		SubState: "start",
		MainPID: "17",
		ControlPID: "0",
		ControlGroup: "/system.slice/ceralive.service",
		InvocationID: "a".repeat(32),
		KillMode: "mixed",
		SendSIGKILL: "yes",
		Delegate: "no",
	};
	let quiet = true,
		members = "17\n",
		childGroups = false;
	const io: CellularConsumerCensusIO = {
		pid: 17,
		quiet: () => quiet,
		service: async () =>
			Object.entries(fields)
				.map(([key, value]) => `${key}=${value}`)
				.join("\n"),
		read: async (path) =>
			path === "/proc/self/cgroup"
				? "0::/system.slice/ceralive.service\n"
				: members,
		noChildGroups: async () => !childGroups,
	};
	return {
		io,
		fields,
		set: (options: {
			quiet?: boolean;
			members?: string;
			childGroups?: boolean;
		}) => {
			if (options.quiet !== undefined) quiet = options.quiet;
			if (options.members !== undefined) members = options.members;
			if (options.childGroups !== undefined) childGroups = options.childGroups;
		},
	};
}
test("startup absence requires the exact sole main process in a stable qualified service invocation", async () => {
	const f = fixture();
	expect(await cellularConsumersAbsent(f.io)).toBe(true);
	f.fields.ActiveState = "active";
	f.fields.SubState = "running";
	expect(await cellularConsumersAbsent(f.io)).toBe(true);
	for (const members of ["", "17\n18\n", "17\n17", "unknown"]) {
		f.set({ members });
		expect(await cellularConsumersAbsent(f.io)).toBe(false);
	}
	f.set({ members: "17", childGroups: true });
	expect(await cellularConsumersAbsent(f.io)).toBe(false);
	f.set({ childGroups: false, quiet: false });
	expect(await cellularConsumersAbsent(f.io)).toBe(false);
});
test("missing, duplicate and unsafe service properties and a different cgroup cannot certify closure", async () => {
	const bad = {
		MainPID: "18",
		KillMode: "process",
		SendSIGKILL: "no",
		Delegate: "yes",
		ControlPID: "19",
		InvocationID: "",
		LoadState: "not-found",
		SubState: "auto-restart",
		ControlGroup: "",
	};
	for (const [key, value] of Object.entries(bad)) {
		const f = fixture();
		Object.assign(f.fields, { [key]: value });
		expect(await cellularConsumersAbsent(f.io)).toBe(false);
	}
	const f = fixture(),
		original = f.io.service;
	expect(
		await cellularConsumersAbsent({
			...f.io,
			service: async () => `${await original()}\nMainPID=17`,
		}),
	).toBe(false);
	expect(
		await cellularConsumersAbsent({
			...f.io,
			read: async () => {
				throw new Error("unreadable");
			},
		}),
	).toBe(false);
	expect(
		await cellularConsumersAbsent({
			...f.io,
			read: async (path) => (path === "/proc/self/cgroup" ? "0::/other" : "17"),
		}),
	).toBe(false);
});
test("a service restart or consumer arriving between observations invalidates absence", async () => {
	const f = fixture();
	let calls = 0;
	expect(
		await cellularConsumersAbsent({
			...f.io,
			service: async () => {
				if (++calls === 2) f.fields.InvocationID = "b".repeat(32);
				return f.io.service();
			},
		}),
	).toBe(false);
	let reads = 0;
	expect(
		await cellularConsumersAbsent({
			...f.io,
			read: async (path) => {
				if (path.endsWith("cgroup.procs") && ++reads === 2) return "17\n18";
				return f.io.read(path);
			},
		}),
	).toBe(false);
});
