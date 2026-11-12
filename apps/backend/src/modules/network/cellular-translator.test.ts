import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { SpawnWithTimeoutResult } from "../../helpers/spawn-policy.ts";
import {
	CELLULAR_TRANSLATOR_BINARY,
	CellularTranslator,
	type CellularTranslatorIO,
	cellularTranslatorUnit,
	parseCellularTranslatorState,
} from "./cellular-translator.ts";

const identity = {
	slot: 1,
	owner: "a".repeat(64),
	epoch: "one",
	birth: "b".repeat(32),
};
const ok = (stdout = ""): SpawnWithTimeoutResult => ({
	exitCode: 0,
	stdout,
	stderr: "",
});
function fixture() {
	let active = false,
		owned = true,
		current = true,
		lostReply = false,
		invocation = "c".repeat(32);
	const calls: string[][] = [];
	let description = `Cellular translator ${identity.owner} ${createHash("sha256").update(identity.epoch).digest("hex")} ${identity.birth}`;
	let translator: CellularTranslator;
	const io: CellularTranslatorIO = {
		owned: async () => owned,
		current: async () => current,
		configuration: async () => "generated config",
		command: async (argv) => {
			calls.push(argv);
			if (argv[1] === "show")
				return active
					? ok(
							Object.entries({
								Id: translator.unit,
								LoadState: "loaded",
								ActiveState: "active",
								SubState: "running",
								Transient: "yes",
								Type: "exec",
								User: "root",
								Restart: "no",
								KillMode: "control-group",
								Description: description,
								InvocationID: invocation,
								MainPID: "17",
								ControlPID: "0",
								Job: "0",
								ControlGroup: `/system.slice/${translator.unit}`,
								ExecStart: `{ path=${CELLULAR_TRANSLATOR_BINARY} ; argv[]=${CELLULAR_TRANSLATOR_BINARY} --config ${translator.config} --nodetach ; ignore_errors=no ; start_time=[n/a] ; pid=17 ; code=(null) ; status=0/0 }`,
							})
								.map(([name, value]) => `${name}=${value}`)
								.join("\n"),
						)
					: ok(
							"LoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\nMainPID=0\n",
						);
			if (argv[0] === "systemd-run") {
				active = true;
				if (lostReply) throw new Error("reply lost");
				return ok();
			}
			if (argv[1] === "stop") {
				active = false;
				return ok();
			}
			throw new Error("Unexpected translator command");
		},
	};
	translator = new CellularTranslator(
		identity,
		"/synthetic/translators",
		"generated config",
		io,
	);
	return {
		translator,
		calls,
		set: (value: {
			owned?: boolean;
			current?: boolean;
			lostReply?: boolean;
			invocation?: string;
			description?: string;
		}) => {
			if (value.owned !== undefined) owned = value.owned;
			if (value.current !== undefined) current = value.current;
			if (value.lostReply !== undefined) lostReply = value.lostReply;
			if (value.invocation !== undefined) invocation = value.invocation;
			if (value.description !== undefined) description = value.description;
		},
	};
}
test("translator birth is single-shot and a reconnect cannot inherit its unit name", async () => {
	const f = fixture();
	expect(await f.translator.start()).toBe("c".repeat(32));
	await expect(f.translator.start()).rejects.toThrow("already submitted");
	const start = f.calls.find((call) => call[0] === "systemd-run");
	expect(start).toContain("--property=Restart=no");
	expect(start).not.toContain("--wait");
	f.set({ current: false });
	expect(await f.translator.stop("c".repeat(32))).toBe(true);
	expect(
		cellularTranslatorUnit({ ...identity, birth: "d".repeat(32) }),
	).not.toBe(f.translator.unit);
});
test("foreign metadata, replaced invocation or a retired lease cannot grant Stop", async () => {
	for (const replacement of [
		{ invocation: "d".repeat(32) },
		{ description: "another owner" },
		{ owned: false },
	]) {
		const f = fixture();
		await f.translator.start();
		f.set(replacement);
		expect(await f.translator.stop("c".repeat(32))).toBe(false);
		expect(f.calls.some((call) => call[1] === "stop")).toBe(false);
	}
});
test("lost submission replies retain the birth and never start a second process", async () => {
	const f = fixture();
	f.set({ lostReply: true });
	await expect(f.translator.start()).rejects.toThrow("reply lost");
	await expect(f.translator.start()).rejects.toThrow("already submitted");
	expect(f.calls.filter((call) => call[0] === "systemd-run")).toHaveLength(1);
	expect(await f.translator.inspect()).toMatchObject({
		kind: "owned",
		running: true,
	});
});
test("contradictory absence and duplicate properties are unknown, not empty", () => {
	const f = fixture();
	expect(() =>
		parseCellularTranslatorState(
			identity,
			f.translator.config,
			ok("LoadState=not-found\nMainPID=17\n"),
		),
	).toThrow("contradictory");
	expect(() =>
		parseCellularTranslatorState(
			identity,
			f.translator.config,
			ok("LoadState=not-found\nLoadState=not-found\n"),
		),
	).toThrow("contradictory");
	expect(
		() =>
			new CellularTranslator(
				{ ...identity, slot: 33 },
				"/synthetic/translators",
				"config",
				{} as never,
			),
	).toThrow("identity");
});
