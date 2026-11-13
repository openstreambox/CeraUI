import { afterEach, expect, spyOn, test } from "bun:test";
import fs, {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MoblinkOwner } from "../modules/moblink/owner";
import { instrumentRpcCall } from "../rpc/rpc-logging";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "relay-owner-"));
	roots.push(dir);
	let idle = true;
	let available = true;
	const calls: string[] = [];
	const owner = new MoblinkOwner({
		directory: join(dir, "private"),
		available: () => available,
		idle: () => idle,
		start: () => {
			calls.push("start");
		},
		stop: async () => {
			calls.push("stop");
		},
	});
	return {
		owner,
		dir,
		calls,
		busy: () => {
			idle = false;
		},
		absent: () => {
			available = false;
		},
	};
}
test("write-only storage survives owner replacement, is private and clears", async () => {
	const f = fixture();
	expect(await f.owner.set("phone-secret")).toEqual({ success: true });
	const path = join(f.dir, "private/credential");
	expect(statSync(path).mode & 0o777).toBe(0o600);
	expect(statSync(join(f.dir, "private")).mode & 0o777).toBe(0o700);
	expect(readFileSync(path, "utf8")).toBe("phone-secret");
	expect(f.calls).toEqual(["stop", "start"]);
	expect(JSON.stringify(f.owner.status())).not.toContain("phone-secret");
	await f.owner.set("replacement");
	expect(f.calls.at(-1)).toBe("start");
	expect(await f.owner.clear()).toEqual({ success: true });
	expect(f.owner.status().configured).toBe(false);
});
test("busy/unknown and unavailable refuse without writes or relay effects", async () => {
	for (const reason of ["busy", "absent"] as const) {
		const f = fixture();
		f[reason]();
		expect((await f.owner.set("secret")).success).toBe(false);
		expect(f.calls).toEqual([]);
		expect(f.owner.status().configured).toBe(false);
	}
});
test.each(["mode", "symlink", "hardlink", "directory"])(
	"replace and clear repair %s without changing other names",
	async (kind) => {
		for (const action of ["set", "clear"] as const) {
			const f = fixture();
			await f.owner.set("old");
			const file = join(f.dir, "private/credential"),
				target = join(f.dir, "target");
			writeFileSync(target, "untouched", { mode: 0o600 });
			if (kind === "mode") chmodSync(file, 0o644);
			if (kind === "directory") chmodSync(join(f.dir, "private"), 0o755);
			if (kind === "symlink" || kind === "hardlink") {
				rmSync(file);
				if (kind === "symlink") symlinkSync(target, file);
				else linkSync(target, file);
			}
			expect(f.owner.status().configured).toBe(false);
			expect(
				await (action === "set" ? f.owner.set("new") : f.owner.clear()),
			).toEqual({ success: true });
			expect(readFileSync(target, "utf8")).toBe("untouched");
			expect(existsSync(file)).toBe(action === "set");
			expect(statSync(join(f.dir, "private")).mode & 0o777).toBe(0o700);
		}
	},
);
test.each(["restore", "set", "clear"])(
	"%s removes interrupted-save plaintext temps",
	async (action) => {
		const f = fixture();
		await f.owner.set("old");
		const dir = join(f.dir, "private");
		writeFileSync(join(dir, ".credential-crash"), "partial-secret", {
			mode: 0o600,
		});
		writeFileSync(join(dir, "relay-ids.json"), "keep");
		if (action === "set") await f.owner.set("new");
		else await f.owner[action]();
		expect(readdirSync(dir)).not.toContain(".credential-crash");
		expect(readFileSync(join(dir, "relay-ids.json"), "utf8")).toBe("keep");
	},
);
test("empty file marks health without reading the secret into JavaScript", async () => {
	const f = fixture();
	mkdirSync(join(f.dir, "empty"), { mode: 0o700 });
	writeFileSync(join(f.dir, "empty/credential"), "", { mode: 0o600 });
	const health: boolean[] = [];
	const owner = new MoblinkOwner({
		directory: join(f.dir, "empty"),
		available: () => true,
		idle: () => true,
		start: () => {
			throw Error("must not start");
		},
		stop: async () => {},
		health: (bad: boolean) => health.push(bad),
	});
	await owner.restore();
	expect(health.at(-1)).toBe(true);
	expect(
		readFileSync(
			new URL("../modules/moblink/owner.ts", import.meta.url),
			"utf8",
		),
	).not.toContain("readFileSync");
});
test("relay errors never escape through replies, status or logs", async () => {
	const f = fixture();
	const secret = "sensitive-sentinel";
	const owner = new MoblinkOwner({
		directory: join(f.dir, "failure"),
		available: () => true,
		idle: () => true,
		start: () => {
			throw new Error(secret);
		},
		stop: async () => {},
	});
	const logs: unknown[] = [];
	const result = await instrumentRpcCall(
		["moblink", "setCredential"],
		{ password: secret, extra: secret },
		{},
		() => owner.set(secret),
		{
			sink: {
				debug: (...args) => {
					logs.push(args);
				},
			},
			now: () => 0,
			genCorrelationId: () => "test",
			isEnabled: () => true,
		},
	);
	expect(result.success).toBe(false);
	expect(JSON.stringify([result, owner.status(), logs])).not.toContain(secret);
	expect(JSON.stringify(logs)).not.toContain("args");
});

test("reboot restoration feeds only the relay, without rewriting the secret", async () => {
	const f = fixture();
	await f.owner.set("retained-phone-password");
	const received: string[] = [];
	const rebooted = new MoblinkOwner({
		directory: join(f.dir, "private"),
		available: () => true,
		idle: () => false,
		start: () => {
			received.push("start");
		},
		stop: async () => {},
	});
	await rebooted.restore();
	expect(received).toEqual(["start"]);
	expect(rebooted.status()).toEqual({ configured: true, available: true });
});

test("real temporary and renamed credential files are 0600 before and after writing", async () => {
	const f = fixture();
	const modes: number[] = [];
	const write = fs.writeFileSync;
	const probe = spyOn(fs, "writeFileSync").mockImplementation(
		(...args: Parameters<typeof fs.writeFileSync>) => {
			if (typeof args[0] === "number")
				modes.push(fs.fstatSync(args[0]).mode & 0o777);
			return write(...args);
		},
	);
	try {
		expect(await f.owner.set("mode-probe")).toEqual({ success: true });
		expect(modes).toEqual([0o600]);
		expect(statSync(join(f.dir, "private/credential")).mode & 0o777).toBe(
			0o600,
		);
	} finally {
		probe.mockRestore();
	}
});
