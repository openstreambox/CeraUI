import { expect, test } from "bun:test";

async function line(
	reader: ReadableStreamDefaultReader<string>,
): Promise<string> {
	const result = await reader.read();
	if (result.done) throw new Error("fixture exited");
	return result.value.trim();
}

// No connection to the host bus: all native calls use this private daemon.
for (const ending of ["release", "exit", "crash"] as const) {
	test.skipIf(process.platform !== "linux")(
		`native logind descriptor releases on ${ending}`,
		async () => {
			const daemon = Bun.spawn(
				["dbus-daemon", "--session", "--nofork", "--print-address=1"],
				{ stdout: "pipe", stderr: "inherit" },
			);
			const addressReader = daemon.stdout
				.pipeThrough(new TextDecoderStream())
				.getReader();
			let fixture: ReturnType<typeof Bun.spawn> | undefined;
			let child: ReturnType<typeof Bun.spawn> | undefined;
			const previous = process.env.DBUS_SYSTEM_BUS_ADDRESS;
			try {
				const address = await line(addressReader);
				fixture = Bun.spawn(
					["python3", `${import.meta.dir}/fixtures/logind.py`, address],
					{ stdout: "pipe", stderr: "inherit" },
				);
				if (!(fixture.stdout instanceof ReadableStream))
					throw Error("no fixture pipe");
				const reader = fixture.stdout
					.pipeThrough(new TextDecoderStream())
					.getReader();
				expect(await line(reader)).toBe("ready");
				const module = new URL(
					"../modules/system/logind-inhibitor.ts",
					import.meta.url,
				).pathname;
				const program = `import { acquireLogindInhibitor } from ${JSON.stringify(module)}; const release = acquireLogindInhibitor(); console.log('ready'); const timer = setInterval(() => {}, 1000); if (${JSON.stringify(ending)} === 'release') { await Bun.stdin.text(); release(); release(); console.log('closed'); }`;
				child = Bun.spawn([process.execPath, "-e", program], {
					env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: address },
					stdin: "pipe",
					stdout: "pipe",
					stderr: "inherit",
				});
				if (!(child.stdout instanceof ReadableStream))
					throw Error("no child pipe");
				const childReader = child.stdout
					.pipeThrough(new TextDecoderStream())
					.getReader();
				expect(await line(childReader)).toBe("ready");
				expect(await line(reader)).toBe("taken");
				if (ending === "release") {
					await child.stdin.end();
					expect(await line(childReader)).toBe("closed");
				} else {
					child.kill(ending === "crash" ? "SIGKILL" : "SIGTERM");
					await child.exited;
				}
				expect(await line(reader)).toBe("released");
			} finally {
				if (previous === undefined) delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
				else process.env.DBUS_SYSTEM_BUS_ADDRESS = previous;
				child?.kill();
				fixture?.kill();
				daemon.kill();
				await Promise.all([child?.exited, fixture?.exited, daemon.exited]);
			}
		},
		10_000,
	);
}
