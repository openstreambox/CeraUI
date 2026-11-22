/*
 * Setup codes, generated owner secrets and the stored code digest are bare hex
 * with no key hint once a frame is serialized. Each diagnostic path must drop
 * them: malformed-frame diagnostics, handler errors and support exports.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger, logRedact } from "../helpers/logger.ts";
import { loadConfig, setConfigFilePath } from "../modules/config.ts";
import * as identity from "../modules/device-logs/boot-id.ts";
import { collectHeldSecrets } from "../modules/device-logs/bundle-data.ts";
import {
	abortLogExports,
	createExport,
	handleLogExportRequest,
} from "../modules/device-logs/export.ts";
import * as versions from "../modules/system/version-context.ts";
import { handleORPCMessage, parseMessage } from "../rpc/adapter.ts";
import type { AppWebSocket } from "../rpc/types.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";

// Synthetic values in the shapes the claim uses.
const CODE = "c0de".repeat(8);
const SECRET = "5ec7".repeat(16);
const DIGEST = new Bun.CryptoHasher("sha256").update(CODE).digest("hex");
const SYNTHETIC = [CODE, SECRET, DIGEST, CODE.toUpperCase()];

let logs: string[];
let restoreLogger: () => void;
let root: string;

beforeEach(() => {
	logs = [];
	const warn = logger.warn.bind(logger);
	const error = logger.error.bind(logger);
	const capture = (message: unknown, meta?: unknown) => {
		logs.push(JSON.stringify([message, meta]));
		return logger;
	};
	logger.warn = capture as typeof logger.warn;
	logger.error = capture as typeof logger.error;
	restoreLogger = () => {
		logger.warn = warn;
		logger.error = error;
	};
	root = mkdtempSync(join(tmpdir(), "local-claim-diag-"));
});

afterEach(async () => {
	restoreLogger();
	writeFileSync(join(root, "config.json"), "{}");
	setConfigFilePath(join(root, "config.json"));
	await loadConfig();
	setConfigFilePath("config.json");
	rmSync(root, { recursive: true, force: true });
});

function expectNoSynthetic(text: string) {
	for (const value of SYNTHETIC) expect(text).not.toContain(value);
}

function fakeWs(): AppWebSocket & { sent: string[] } {
	const sent: string[] = [];
	return {
		remoteAddress: "198.51.100.4",
		data: { isAuthenticated: false, lastActive: Date.now() },
		send: (payload: string) => {
			sent.push(payload);
			return payload.length;
		},
		sent,
	} as unknown as AppWebSocket & { sent: string[] };
}

test.each([
	{ code: CODE, ownerSecret: SECRET },
	{ c: CODE.toUpperCase(), s: SECRET },
	{ x: [DIGEST], note: `claim=${CODE}` },
	// The secret sits past the preview cut; masking must not depend on it.
	{ pad: "p".repeat(90), s: SECRET },
])("a malformed frame diagnostic drops bare hex credentials %#", (frame) => {
	expect(parseMessage(JSON.stringify(frame), fakeWs())).toBeNull();
	expect(logs).toHaveLength(1);
	expectNoSynthetic(logs.join("\n"));
	expect(logs[0]).toContain("rpc: unrecognised frame");
});

test("a malformed frame logs its shape only, never its values", () => {
	parseMessage(JSON.stringify({ kind: "probe", id: "abc123" }), fakeWs());
	expect(logs[0]).toContain("kind");
	expect(logs[0]).not.toContain("probe");
	expect(logs[0]).not.toContain("abc123");
});

test("a rejected claim frame never echoes its input to logs or the client", async () => {
	const ws = fakeWs();
	await handleORPCMessage(ws, {
		id: "claim",
		path: ["auth", "claimLocalOwner"],
		input: { code: CODE, ownerSecret: `${SECRET}0`, extra: SECRET },
	});
	expectNoSynthetic(logs.join("\n"));
	expectNoSynthetic(ws.sent.join("\n"));
	expect(ws.sent.join("\n")).toContain("VALIDATION_ERROR");
});

test("the stored code digest is redacted by key in structured logs", () => {
	expectNoSynthetic(
		JSON.stringify(logRedact({ local_claim_digest: DIGEST, claim_code: CODE })),
	);
});

test("support exports treat the stored code digest as a held secret", async () => {
	const path = join(root, "config.json");
	writeFileSync(path, JSON.stringify({ local_claim_digest: DIGEST }));
	setConfigFilePath(path);
	await loadConfig();
	expect(collectHeldSecrets()).toContainEqual({
		kind: "claim_digest",
		value: DIGEST,
	});

	const boot = spyOn(identity, "currentBootId").mockReturnValue(bootId);
	const fixture = queryFixture();
	const context = spyOn(versions, "collectVersionContext").mockResolvedValue({
		bootId,
		osImage: "os",
		slot: "A",
		board: "board",
		boardModel: null,
		ceraui: "ui",
		engine: "engine",
		senderVersion: "sender",
		kernel: "kernel",
		bun: "bun",
	});
	try {
		fixture.scan.mockImplementation(
			journal([
				record(1, { MESSAGE: `seeded verifier ${DIGEST}` }),
				record(2, { MESSAGE: "nothing held here" }),
			]),
		);
		const created = await createExport({}, { filter: {} });
		if (!created.ok) throw new Error(created.error);
		const text = await (
			await handleLogExportRequest(new Request(`http://device${created.url}`))
		).text();
		expect(text).not.toContain(DIGEST);
		expect(text).toContain("seeded verifier [REDACTED:claim_digest]");
		expect(text).toContain("nothing held here");
	} finally {
		await abortLogExports();
		context.mockRestore();
		fixture.restore();
		boot.mockRestore();
	}
});
