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
	expect(runner.running()).toBe(false);
	runner.start();
	expect(runner.running()).toBe(true);
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
	expect(runner.running()).toBe(false);
	expect(signals).toEqual(["SIGTERM"]);
});

test("unexpected exit marks health, intentional stop does not", async () => {
	for (const intentional of [false, true]) {
		let exit!: (n: number) => void;
		const health: boolean[] = [];
		const child = {
			exitCode: null,
			signalCode: null,
			exited: new Promise<number>((r) => {
				exit = r;
			}),
			kill: () => {
				exit(0);
			},
		};
		const runner = createRelayRunner(
			() => child,
			(bad: boolean) => health.push(bad),
		);
		expect(runner.running()).toBe(false);
		runner.start();
		expect(runner.running()).toBe(true);
		if (intentional) await runner.stop();
		else {
			exit(1);
			await new Promise((r) => setTimeout(r, 0));
		}
		expect(runner.running()).toBe(false);
		expect(health.at(-1)).toBe(!intentional);
	}
});
