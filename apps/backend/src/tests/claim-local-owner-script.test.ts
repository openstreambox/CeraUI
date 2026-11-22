// The companion stub (scripts/claim-local-owner.ts) against a scripted box:
// the key is saved before submission, a lost or failed reply counts as
// unconfirmed and keeps the key, and a rerun resubmits that same key.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL(
	"../../../../scripts/claim-local-owner.ts",
	import.meta.url,
).pathname;
const code = "ca".repeat(16);

type Reply = "success" | "refused" | "error" | "drop";

let dir: string;
let keyFile: string;
let sent: string[];
let replies: Reply[];
let server: ReturnType<typeof Bun.serve>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "claim-script-"));
	keyFile = join(dir, "owner-key");
	sent = [];
	replies = [];
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, srv) {
			if (new URL(request.url).pathname === "/ws" && srv.upgrade(request))
				return;
			return new Response(null, { status: 404 });
		},
		websocket: {
			message(socket, message) {
				const { id, path, input } = JSON.parse(String(message));
				expect(path).toEqual(["auth", "claimLocalOwner"]);
				expect(input.code).toBe(code);
				// The key is on disk, private, before the box sees it.
				expect(statSync(keyFile).mode & 0o777).toBe(0o600);
				expect(readFileSync(keyFile, "utf8").trim()).toBe(input.ownerSecret);
				sent.push(input.ownerSecret);
				const reply = replies.shift() ?? "success";
				if (reply === "drop") return socket.close();
				socket.send(
					JSON.stringify(
						reply === "error"
							? {
									id,
									error: {
										message: "runtime_config_authority_unavailable",
										code: "INTERNAL_ERROR",
									},
								}
							: { id, result: { success: reply === "success" } },
					),
				);
			},
		},
	});
});

afterEach(async () => {
	await server.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

async function run() {
	const child = Bun.spawn(
		[process.execPath, script, `ws://127.0.0.1:${server.port}/ws`, keyFile],
		{ stdin: new Blob([`${code}\n`]), stdout: "pipe", stderr: "pipe" },
	);
	const [status, stdout, stderr] = await Promise.all([
		child.exited,
		child.stdout.text(),
		child.stderr.text(),
	]);
	return { status, stdout, stderr };
}

test("a confirmed claim saves the key first and reports success", async () => {
	const result = await run();
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout).toContain("Owner credential saved");
	expect(result.stdout + result.stderr).not.toContain(sent[0] ?? "-");
});

test.each(["drop", "error"] as const)(
	"a %s reply is unconfirmed, keeps the key, and a rerun resubmits it",
	async (reply) => {
		replies = [reply, "success"];
		const first = await run();
		expect(first.status).not.toBe(0);
		expect(first.stderr).toContain("did not confirm setup");
		expect(first.stdout).not.toContain("refused");
		const kept = readFileSync(keyFile, "utf8").trim();
		expect(first.stdout + first.stderr).not.toContain(kept);
		const second = await run();
		expect(second.status, second.stderr).toBe(0);
		expect(sent).toEqual([kept, kept]);
	},
	20_000,
);

test("an explicit refusal says so", async () => {
	replies = ["refused"];
	const result = await run();
	expect(result.status).toBe(1);
	expect(result.stdout).toContain("The box refused setup");
	expect(result.stderr).not.toContain("did not confirm");
});
