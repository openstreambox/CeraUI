import { expect, test } from "bun:test";
import { createRelayRunner } from "../modules/moblink/relay-runner";

test("relay consumes private password file with discarded output and owns its child", async () => {
	const calls: unknown[] = [];
	const signals: unknown[] = [];
	const child = {
		exitCode: null,
		signalCode: null,
		kill: (signal: unknown) => signals.push(signal),
		exited: Promise.resolve(0),
	};
	const runner = createRelayRunner((args, options) => {
		calls.push({ args, options });
		return child;
	});
	runner.start("not-a-shell-$(command)");
	expect(calls).toEqual([
		{
			args: [
				"/usr/local/bin/moblink-relay-service",
				"--password-file",
				"/data/moblink/credential",
				"--database",
				"/data/moblink/relay-ids.json",
			],
			options: { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
		},
	]);
	expect(JSON.stringify(calls)).not.toContain("not-a-shell-$(command)");
	await runner.stop();
	expect(signals).toEqual(["SIGTERM"]);
});
