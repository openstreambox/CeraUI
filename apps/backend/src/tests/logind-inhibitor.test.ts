import { expect, test } from "bun:test";

const buffers = new WeakMap<ReadableStreamDefaultReader<string>, string>();
async function line(
	reader: ReadableStreamDefaultReader<string>,
): Promise<string> {
	let buffer = buffers.get(reader) ?? "";
	while (true) {
		const newline = buffer.indexOf("\n");
		if (newline >= 0) {
			const value = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			buffers.set(reader, buffer);
			if (value && !value.startsWith("{")) return value;
			continue;
		}
		const result = await reader.read();
		if (result.done) throw Error("fixture exited");
		buffer += result.value;
	}
}

// No connection to the host bus: all native calls use this private daemon.
for (const ending of [
	"release",
	"exit",
	"crash",
	"protection",
	"child",
] as const) {
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
				const protectionModule = new URL(
					"../modules/system/shutdown-protection.ts",
					import.meta.url,
				).pathname;
				const program = `import { acquireLogindInhibitor } from ${JSON.stringify(module)}; import { initShutdownProtection, setShutdownProtection, ensureEncoderShutdownProtection } from ${JSON.stringify(protectionModule)};
                let release;
                if (${JSON.stringify(ending)} === 'protection') {
                  setShutdownProtection('encoder', true); initShutdownProtection();
                  if (!await ensureEncoderShutdownProtection()) throw Error('unprotected admission');
                  release = () => setShutdownProtection('encoder', false);
                } else release = await acquireLogindInhibitor();
                if (${JSON.stringify(ending)} === 'child') Bun.spawn(['sleep','3'], {stdin:'ignore',stdout:'ignore',stderr:'ignore'}).unref(); console.log('ready'); const timer = setInterval(() => {}, 1000); if (['release','protection'].includes(${JSON.stringify(ending)})) { await Bun.stdin.text(); release(); release(); console.log('closed'); }`;
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
				expect(
					await Promise.race([
						line(reader),
						Bun.sleep(1000).then(() => "missing lock"),
					]),
				).toBe("taken");
				if (ending === "release" || ending === "protection") {
					await child.stdin.end();
					expect(await line(childReader)).toBe("closed");
				} else {
					child.kill(ending === "crash" ? "SIGKILL" : "SIGTERM");
					await child.exited;
				}
				expect(
					await Promise.race([
						line(reader),
						Bun.sleep(1000).then(() => "descriptor retained"),
					]),
				).toBe("released");
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
