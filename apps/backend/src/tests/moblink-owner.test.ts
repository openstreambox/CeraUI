import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
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
		start: (password: string) => {
			calls.push(password);
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
	expect(f.calls).toEqual(["stop", "phone-secret"]);
	expect(JSON.stringify(f.owner.status())).not.toContain("phone-secret");
	await f.owner.set("replacement");
	expect(f.calls.at(-1)).toBe("replacement");
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
test("insecure storage and symlinks fail closed without disclosing values", async () => {
	const f = fixture();
	await f.owner.set("private-secret");
	chmodSync(join(f.dir, "private/credential"), 0o644);
	expect(f.owner.status().configured).toBe(false);
	expect((await f.owner.set("next-secret")).success).toBe(false);
	chmodSync(join(f.dir, "private/credential"), 0o600);
	rmSync(join(f.dir, "private/credential"));
	symlinkSync(join(f.dir, "elsewhere"), join(f.dir, "private/credential"));
	expect((await f.owner.set("next-secret")).success).toBe(false);
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
		start: (value) => {
			received.push(value);
		},
		stop: async () => {},
	});
	await rebooted.restore();
	expect(received).toEqual(["retained-phone-password"]);
	expect(rebooted.status()).toEqual({ configured: true, available: true });
});
