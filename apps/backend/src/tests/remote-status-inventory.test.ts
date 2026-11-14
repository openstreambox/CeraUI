import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strictParseFrame } from "@ceralive/control-protocol/parse";
import ts from "typescript";
import inventory from "../../../../docs/remote-status-inventory.json";
import { projectRemoteLegacyFrame } from "../modules/remote/remote-status.ts";
import {
	isRelayable,
	relayStatusToGateway,
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
import { usePrivacyConfig } from "./helpers/remote-privacy-config.ts";
import {
	authenticateRemote,
	useRemotePrivacySocket,
} from "./helpers/remote-privacy-socket.ts";

usePrivacyConfig();
useRemotePrivacySocket();
const root = resolve(import.meta.dir, "../../../../");
test("every status producer field and binding requires a reviewed allowlist decision", () => {
	expect(inventory.calls.length).toBeGreaterThan(100);
	const known = new Set(inventory.calls.map((c) => c.source));
	for (const file of new Bun.Glob("apps/backend/src/**/*.ts").scanSync({
		cwd: root,
	})) {
		if (file.includes("/tests/") || file.includes(".test.")) continue;
		const source = ts.createSourceFile(
			file,
			readFileSync(resolve(root, file), "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		function visit(n: ts.Node) {
			if (
				ts.isCallExpression(n) &&
				ts.isIdentifier(n.expression) &&
				[
					"buildMsg",
					"broadcastMsg",
					"broadcastMsgExcept",
					"broadcastMsgLocal",
				].includes(n.expression.text) &&
				n.arguments.length >= 2
			)
				expect(known.has(file), file).toBe(true);
			ts.forEachChild(n, visit);
		}
		visit(source);
	}

	for (const [file, expected] of Object.entries(inventory.dependencies)) {
		expect(
			createHash("sha256")
				.update(readFileSync(resolve(root, file)))
				.digest("hex"),
			`${file}: review fields and run node scripts/remote-status-inventory.mjs`,
		).toBe(expected);
	}
});
test("identifiers planted at every inventoried source leaf never reach either status transport", async () => {
	const legacy = await authenticateRemote();
	legacy.sent.length = 0;
	const secret = "PRIVATE_IDENTIFIER_8b7321";
	const frames: unknown[] = [];
	setControlChannel({
		isConnected: () => true,
		sendFrame: (f) => {
			frames.push(f);
		},
	});
	try {
		for (const call of inventory.calls) {
			const type = call.message.replaceAll('"', "");
			for (const field of call.fields) {
				const parts = field.path
					.replaceAll("[]", ".0")
					.split(".")
					.filter(Boolean);
				function plant(index: number): unknown {
					if (index === parts.length) return secret;
					const part = parts[index];
					if (part === "0") return [plant(index + 1)];
					return { [part === "*" ? secret : String(part)]: plant(index + 1) };
				}
				const payload = plant(0);
				const local = JSON.stringify(payload);
				expect(
					JSON.stringify(projectRemoteLegacyFrame({ [type]: payload })),
				).not.toContain(secret);
				legacy.send(JSON.stringify({ [type]: payload }));
				expect(legacy.sent.join("\n")).not.toContain(secret);
				if (isRelayable(type)) relayStatusToGateway(type, payload, 1);
				expect(JSON.stringify(payload)).toBe(local);
			}
		}
		expect(frames.length).toBeGreaterThan(100);
		for (const frame of frames) {
			expect(JSON.stringify(frame)).not.toContain(secret);
			expect(() => strictParseFrame(frame)).not.toThrow();
		}
	} finally {
		resetStatusRelay();
	}
});

test("every projected legacy hydration status satisfies the published status schema", async () => {
	const { statusResponseSchema } = await import("@ceraui/rpc/schemas");
	const socket = await authenticateRemote();
	let count = 0;
	for (const text of socket.sent) {
		const frame = JSON.parse(text);
		if (frame.status !== undefined) {
			statusResponseSchema.parse(frame.status);
			count++;
		}
	}
	expect(count).toBeGreaterThan(0);
});
