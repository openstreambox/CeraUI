/// <reference types="bun" />

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { updateCapabilityFileSchema } from "@ceraui/rpc/schemas";
import {
	assertOwnerMayRead,
	assertOwnerMayRun,
	assertOwnerMayWrite,
	type EffectOwner,
	isOwnerEnded,
	isOwnerTeardownCommand,
	isOwnerTeardownWrite,
	OWNER_TEARDOWN,
	type OwnedFileBackend,
	type OwnedWrite,
	OwnerEndedError,
	ownedAll,
	ownedFiles,
	ownedWrite,
	setOwnedFileBackendForTest,
	setOwnedWriteObserverForTest,
	setSpawnOverrideForTest,
} from "../helpers/effect-owner.ts";
import { logger } from "../helpers/logger.ts";
import { run } from "../helpers/run.ts";
import { spawnWithTimeout } from "../helpers/spawn-policy.ts";
import type { AptRoutingEntry } from "../modules/system/apt-routing-journal.ts";
import { createAptRoutingOwnership } from "../modules/system/apt-routing-ownership.ts";
import { rankTransports } from "../modules/system/update-transport/core.ts";
import {
	createUpdatePinController,
	UPDATE_TRANSPORT_HOLD_MS,
	UpdateTransferError,
} from "../modules/system/update-transport/pin.ts";
import {
	PINNED_CAPABILITIES,
	sample,
} from "./helpers/apt-transport-fixture.ts";

afterEach(() => {
	setSpawnOverrideForTest(null);
	setOwnedFileBackendForTest(null);
	setOwnedWriteObserverForTest(null);
});

/** An owner that can end, and how often it was asked. */
function owner() {
	const state = { ended: false, asked: 0 };
	const effects: EffectOwner = {
		ended: () => {
			state.asked++;
			return state.ended;
		},
	};
	return { state, effects };
}

/** Every command either spawn primitive would start, answered in process. */
function spawned(answer: (line: string) => string = () => "") {
	const lines: string[] = [];
	setSpawnOverrideForTest(async (argv) => {
		const line = argv.join(" ");
		lines.push(line);
		return { exitCode: 0, stdout: answer(line), stderr: "" };
	});
	return lines;
}

const RULE_DEL = [
	"ip",
	"rule",
	"del",
	"priority",
	"120",
	"uidrange",
	"42042-42042",
	"lookup",
	"100000",
];

describe("the one guard of commands and owned writes", () => {
	it("nobody in particular is never refused, and never asked", () => {
		assertOwnerMayRun(undefined, ["apt-get", "update"]);
		assertOwnerMayWrite(undefined, "spool:create-file");
		assertOwnerMayRead(undefined, "a file");
	});

	it("an owner is asked right before each effect, and refused once it has ended", () => {
		const { state, effects } = owner();
		assertOwnerMayRun(effects, ["apt-get", "update"]);
		assertOwnerMayWrite(effects, "spool:create-file");
		assertOwnerMayRead(effects, "a file");
		expect(state.asked).toBe(3);
		state.ended = true;
		expect(() => assertOwnerMayRun(effects, ["apt-get", "update"])).toThrow(
			OwnerEndedError,
		);
		expect(() => assertOwnerMayWrite(effects, "spool:create-file")).toThrow(
			OwnerEndedError,
		);
		expect(() => assertOwnerMayRead(effects, "a file")).toThrow(
			OwnerEndedError,
		);
	});

	it("an ended owner may still take down what it set up, and nothing else", () => {
		const { state, effects } = owner();
		state.ended = true;
		assertOwnerMayRun(effects, RULE_DEL);
		assertOwnerMayRun(effects, [
			"ip",
			"-6",
			"route",
			"flush",
			"table",
			"100001",
		]);
		assertOwnerMayWrite(effects, "routing-journal:retire");
		assertOwnerMayWrite(effects, "private-file:remove");
		// Teardown is not even asked: it is allowed whatever the owner says.
		expect(state.asked).toBe(0);
		for (const argv of [
			// A look is not a teardown.
			["ip", "rule", "show"],
			["ip", "route", "show", "table", "100000"],
			// Setting a rule up is not either, nor is anything outside the
			// update tables.
			["ip", "rule", "add", ...RULE_DEL.slice(3)],
			["ip", "rule", "del", "priority", "100", "lookup", "main"],
			["ip", "route", "del", "default", "dev", "eth0"],
			["ip", "route", "flush", "table", "main"],
			["apt-get", "clean"],
			["systemctl", "stop", "ceralive-software-update.service"],
		])
			expect(() => assertOwnerMayRun(effects, argv)).toThrow(OwnerEndedError);
		for (const kind of [
			"spool:secure-directory",
			"spool:remove-file",
			"spool:create-file",
			"spool:set-mode",
			"private-file:create",
			"routing-journal:record",
			"transport-selection:publish",
			"reachability-cache:store",
		] satisfies OwnedWrite[])
			expect(() => assertOwnerMayWrite(effects, kind)).toThrow(OwnerEndedError);
	});

	it("the teardown list is the one in effect-owner.ts, and nothing matches it by accident", () => {
		expect(OWNER_TEARDOWN.writes).toEqual([
			"routing-journal:retire",
			"private-file:remove",
		]);
		expect(OWNER_TEARDOWN.commands).toHaveLength(3);
		expect(isOwnerTeardownWrite("routing-journal:record")).toBe(false);
		// The uid range is one uid, and the tables are the two update tables.
		expect(
			isOwnerTeardownCommand([
				...RULE_DEL.slice(0, 6),
				"42042-42043",
				"lookup",
				"100000",
			]),
		).toBe(false);
		expect(isOwnerTeardownCommand([...RULE_DEL.slice(0, 8), "100002"])).toBe(
			false,
		);
		expect(isOwnerTeardownCommand([...RULE_DEL, ";", "reboot"])).toBe(false);
	});

	it("a refusal is recognisable where errors are caught", () => {
		const refusal = new OwnerEndedError("apt-get");
		expect(isOwnerEnded(refusal)).toBe(true);
		expect(isOwnerEnded(new Error("apt-get"))).toBe(false);
		expect(refusal.message).toContain("apt-get");
	});
});

describe("both spawn primitives ask before they spawn", () => {
	it("run(): refused for an ended owner without a log line or a spawn", async () => {
		const lines = spawned();
		const debug = spyOn(logger, "debug").mockImplementation(() => logger);
		const { state, effects } = owner();
		await run("ip", ["rule", "show"], { owner: effects });
		expect(lines).toEqual(["ip rule show"]);
		const logs = debug.mock.calls.length;
		state.ended = true;
		await expect(
			run("ip", ["rule", "show"], { owner: effects }),
		).rejects.toBeInstanceOf(OwnerEndedError);
		expect(lines).toEqual(["ip rule show"]);
		expect(debug.mock.calls.length).toBe(logs);
		// Its teardown still runs.
		await run("ip", RULE_DEL.slice(1), { owner: effects });
		expect(lines).toEqual(["ip rule show", RULE_DEL.join(" ")]);
		debug.mockRestore();
	});

	it("spawnWithTimeout(): refused for an ended owner without a spawn", async () => {
		const lines = spawned();
		const { state, effects } = owner();
		await spawnWithTimeout(["apt-get", "update"], {
			timeoutMs: 1000,
			owner: effects,
		});
		state.ended = true;
		await expect(
			spawnWithTimeout(["apt-get", "update"], {
				timeoutMs: 1000,
				owner: effects,
			}),
		).rejects.toBeInstanceOf(OwnerEndedError);
		expect(lines).toEqual(["apt-get update"]);
	});

	it("a command in flight is not killed when its owner ends: it finishes", async () => {
		const answer = Promise.withResolvers<void>();
		setSpawnOverrideForTest(async () => {
			await answer.promise;
			return { exitCode: 0, stdout: "done", stderr: "" };
		});
		const { state, effects } = owner();
		const running = spawnWithTimeout(["apt-get", "update"], {
			timeoutMs: 1000,
			owner: effects,
		});
		state.ended = true;
		answer.resolve();
		expect(await running).toMatchObject({ exitCode: 0, stdout: "done" });
	});

	it("without an owner both run as they always did", async () => {
		const lines = spawned();
		const debug = spyOn(logger, "debug").mockImplementation(() => logger);
		await run("ip", ["rule", "show"]);
		await spawnWithTimeout(["apt-get", "update"], { timeoutMs: 1000 });
		expect(lines).toEqual(["ip rule show", "apt-get update"]);
		debug.mockRestore();
	});
});

describe("owned writes and files", () => {
	it("a write to state happens for a live owner and is refused for an ended one", () => {
		const seen: OwnedWrite[] = [];
		setOwnedWriteObserverForTest((kind) => seen.push(kind));
		const { state, effects } = owner();
		let cache = 0;
		ownedWrite(effects, "reachability-cache:store", () => {
			cache = 1;
		});
		state.ended = true;
		expect(() =>
			ownedWrite(effects, "reachability-cache:store", () => {
				cache = 2;
			}),
		).toThrow(OwnerEndedError);
		expect(cache).toBe(1);
		// Striking a routing rule from the journal is teardown.
		ownedWrite(effects, "routing-journal:retire", () => {
			cache = 3;
		});
		expect(cache).toBe(3);
		// The observer hears of the writes that happen, never of a refused one.
		expect(seen).toEqual([
			"reachability-cache:store",
			"routing-journal:retire",
		]);
	});

	it("every file step asks, a look included; removing a private file is teardown", async () => {
		const steps: string[] = [];
		const backend: OwnedFileBackend = {
			makeDirectory: async () => {
				steps.push("makeDirectory");
			},
			inspect: async () => {
				steps.push("inspect");
				return {
					isDirectory: () => true,
					isSymbolicLink: () => false,
					uid: 0,
					mode: 0o700,
				};
			},
			setMode: async () => {
				steps.push("setMode");
			},
			removeFile: async () => {
				steps.push("removeFile");
			},
			removeTree: async () => {
				steps.push("removeTree");
			},
			createExclusive: async () => {
				steps.push("createExclusive");
				return {
					stat: async () => {
						steps.push("stat");
						return { isFile: () => true, uid: 0, nlink: 1 };
					},
					chmod: async () => {
						steps.push("chmod");
					},
					close: async () => {
						steps.push("close");
					},
				};
			},
			makeTempDirectory: async (prefix) => {
				steps.push("makeTempDirectory");
				return `${prefix}1`;
			},
			writeNew: async () => {
				steps.push("writeNew");
			},
		};
		setOwnedFileBackendForTest(backend);
		const { state, effects } = owner();
		const files = ownedFiles(effects);
		const handle = await files.createExclusive(
			"spool:create-file",
			"spool:set-mode",
			"/run/out",
			0o600,
		);
		state.ended = true;
		const refused = [
			() => files.makeDirectory("spool:secure-directory", "/run", 0o700),
			() => files.inspect("spool:secure-directory", "/run"),
			() => files.setMode("spool:secure-directory", "/run", 0o700),
			() => files.removeFile("spool:remove-file", "/run/out"),
			() =>
				files.createExclusive(
					"spool:create-file",
					"spool:set-mode",
					"/run/out",
					0o600,
				),
			() => files.makeTempDirectory("private-file:create", "/tmp/x-"),
			() => files.writeNew("private-file:create", "/tmp/x-1/url", "", 0o600),
			() => handle.stat(),
			() => handle.chmod(0o600),
		];
		for (const step of refused)
			await expect(Promise.resolve().then(step)).rejects.toBeInstanceOf(
				OwnerEndedError,
			);
		// A handle that is open is closed, and its private directory removed.
		await handle.close();
		await files.removeTree("private-file:remove", "/tmp/x-1");
		expect(steps).toEqual(["createExclusive", "close", "removeTree"]);
	});
});

describe("the uplink cooldown of the pin controller", () => {
	const selection = rankTransports([sample("eth0", "ethernet", 4)]);
	const controller = async () => {
		const pin = createUpdatePinController({
			readCapabilities: async () =>
				updateCapabilityFileSchema.parse(PINNED_CAPABILITIES),
			now: () => 1000,
		});
		await pin.sweep();
		return pin;
	};

	it("is not written for the fetch failure of an owner that has ended", async () => {
		spawned((line) =>
			line.endsWith("route show default") ? "default dev eth0" : "",
		);
		const debug = spyOn(logger, "debug").mockImplementation(() => logger);
		const pin = await controller();
		const { state, effects } = owner();
		await expect(
			pin.run(
				"os",
				selection,
				async () => {
					// Its last transfer fails, and it has ended by then.
					state.ended = true;
					throw new UpdateTransferError("no-route");
				},
				{ owner: effects },
			),
		).rejects.toBeInstanceOf(OwnerEndedError);
		// The uplink is as usable for the next transfer as it was.
		expect(pin.unhealthyUntil("eth0", 4)).toBeUndefined();
		debug.mockRestore();
	});

	it("is written for a live owner's, and for nobody's, as before", async () => {
		spawned((line) =>
			line.endsWith("route show default") ? "default dev eth0" : "",
		);
		const debug = spyOn(logger, "debug").mockImplementation(() => logger);
		for (const control of [{ owner: owner().effects }, {}]) {
			const pin = await controller();
			await expect(
				pin.run(
					"os",
					selection,
					async () => {
						throw new UpdateTransferError("no-route");
					},
					control,
				),
			).rejects.toBeInstanceOf(UpdateTransferError);
			expect(pin.unhealthyUntil("eth0", 4)).toBe(
				1000 + UPDATE_TRANSPORT_HOLD_MS,
			);
		}
		debug.mockRestore();
	});
});

describe("branches started side by side for an owner", () => {
	it("are all waited for before a refusal travels on", async () => {
		const slow = Promise.withResolvers<string>();
		const { effects } = owner();
		let settled = false;
		const joined = ownedAll(effects, [
			Promise.reject(new OwnerEndedError("the first")),
			slow.promise,
		]).finally(() => {
			settled = true;
		});
		joined.catch(() => undefined);
		await Bun.sleep(5);
		// The first branch was refused long ago; the second is still out.
		expect(settled).toBe(false);
		slow.resolve("back");
		await expect(joined).rejects.toBeInstanceOf(OwnerEndedError);
	});

	it("answer like Promise.all when none fails, in order", async () => {
		const { effects } = owner();
		expect(await ownedAll(effects, [Promise.resolve(1), "two", 3])).toEqual([
			1,
			"two",
			3,
		]);
	});

	it("without an owner it is Promise.all: the first failure ends the wait", async () => {
		const slow = Promise.withResolvers<string>();
		await expect(
			ownedAll(undefined, [Promise.reject(new Error("first")), slow.promise]),
		).rejects.toThrow("first");
		slow.resolve("back");
	});
});

describe("what a pinned run takes down is what the list allows", () => {
	const selection = rankTransports([sample("eth0", "ethernet", 4)]);

	it.each(["apt", "os"] as const)(
		"%s: an owner that ends during its step still removes its rule and routes, with nothing else",
		async (job) => {
			const lines = spawned((line) =>
				line.endsWith("route show default") ? "default dev eth0" : "",
			);
			let entries: readonly AptRoutingEntry[] = [];
			const ownership = createAptRoutingOwnership({
				read: async () => entries,
				save: (next) => {
					entries = next;
				},
			});
			const pin = createUpdatePinController({
				readCapabilities: async () =>
					updateCapabilityFileSchema.parse(PINNED_CAPABILITIES),
				now: () => 1000,
			});
			const debug = spyOn(logger, "debug").mockImplementation(() => logger);
			await pin.sweep();
			const { state, effects } = owner();
			let endedAt = 0;
			await pin.run(
				job,
				selection,
				async () => {
					// The rule and routes are up; the owner ends here.
					expect(lines.some((line) => line.includes(" rule add "))).toBe(true);
					state.ended = true;
					endedAt = lines.length;
				},
				{
					owner: effects,
					...(job === "apt" ? { aptOwnership: ownership } : {}),
				},
			);
			const after = lines.slice(endedAt);
			// The rule of each family and the routes are gone again.
			expect(after.filter((line) => line.includes(" rule del "))).toHaveLength(
				2,
			);
			expect(after.length).toBeGreaterThan(2);
			for (const line of after)
				expect(isOwnerTeardownCommand(line.split(" "))).toBe(true);
			// Nothing of the setup would have passed as teardown.
			for (const line of lines.slice(0, endedAt))
				expect(isOwnerTeardownCommand(line.split(" "))).toBe(
					/ (del|flush) /.test(line),
				);
			expect(entries).toEqual([]);
			// A further step for the ended owner starts nothing at all.
			const before = lines.length;
			await expect(
				pin.run(job, selection, async () => {}, {
					owner: effects,
					...(job === "apt" ? { aptOwnership: ownership } : {}),
				}),
			).rejects.toBeInstanceOf(OwnerEndedError);
			expect(lines.length).toBe(before);
			debug.mockRestore();
		},
	);
});
