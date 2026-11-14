import { expect, test } from "bun:test";
import { updateSettingsSchema } from "@ceraui/rpc/schemas";
import { resolveBoardUpdates } from "../modules/system/board-updates.ts";
import { kernelPackage } from "../modules/system/update-orchestrator/kernel-state.ts";

for (const family of ["rk3588", "rk3566", "bcm2711", "bcm2712", "x86_64"]) {
	test(`${family} uses explicit image update identity`, () => {
		const record = `ID=ceralive\nBOARD=example\nFAMILY=${family}\nCAPABILITIES="os-updates"\nUPDATE_BOARD=example\nUPDATE_COMPATIBLE=ceralive-example\nKERNEL_ARCH=${family === "x86_64" ? "amd64" : "arm64"}\n`;
		expect(resolveBoardUpdates(record)).toMatchObject({
			board: "example",
			compatible: "ceralive-example",
			family,
		});
		expect(
			kernelPackage.safeParse(`linux-image-7.2.0-ceralive-${family}`).success,
		).toBe(true);
	});
}
test("unknown and incomplete records offer no updates", () => {
	for (const record of [
		"ID=ceralive\nBOARD=unknown\nFAMILY=unknown\nCAPABILITIES=\n",
		"BOARD=broken",
	])
		expect(resolveBoardUpdates(record)).toBe(null);
});
test("legacy image retains fallback", () =>
	expect(resolveBoardUpdates("ID=ceralive\nVERSION_ID=1\n")).toBe(undefined));
test("channel defaults and rejects unsafe addresses", () => {
	expect(updateSettingsSchema.parse({}).channelUrl).toBeUndefined();
	for (const channelUrl of [
		"not-a-url",
		"",
		"http://example.invalid",
		"https://user:pass@example.invalid",
		"https://example.invalid/?x=1",
		"https://example.invalid/#fragment",
	])
		expect(updateSettingsSchema.safeParse({ channelUrl }).success).toBe(false);
	expect(
		updateSettingsSchema.parse({
			channelUrl: "https://updates.example.invalid/bench",
		}).channelUrl,
	).toBe("https://updates.example.invalid/bench");
});
test("kernel discovery excludes other families and architecture", async () => {
	const { parseKernelPackages } = await import(
		"../modules/system/update-orchestrator/kernel-packages.ts"
	);
	const row = (family: string, arch: string) =>
		`Package: linux-image-7.2.0-ceralive-${family}\nVersion: 7.2.0-ceralive1\nArchitecture: ${arch}\nSHA256: ${"a".repeat(64)}\nFilename: pool/kernel.deb\nSize: 100\n`;
	expect(parseKernelPackages(row("rk3588", "arm64"), "rk3566")).toEqual([]);
	expect(
		parseKernelPackages(row("x86_64", "amd64"), "x86_64", "amd64"),
	).toHaveLength(1);
});
test("record identity must match RAUC before selecting its channel", async () => {
	const { readBoardIdentity } = await import(
		"../modules/system/update-orchestrator/os-identity.ts"
	);
	const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
	const directory = await mkdtemp("/var/tmp/board-updates-");
	try {
		const path = `${directory}/system.conf`;
		await writeFile(path, "[system]\ncompatible=ceralive-example\n");
		for (const family of ["rk3588", "rk3566", "bcm2711", "bcm2712", "x86_64"]) {
			expect(
				await readBoardIdentity(path, async () => ({
					board: "example",
					compatible: "ceralive-example",
					family,
					architecture: "arm64",
				})),
			).toEqual({ board: "example", compatible: "ceralive-example" });
		}
		await expect(
			readBoardIdentity(path, async () => null),
		).rejects.toMatchObject({ reason: "board_updates_not_offered" });
		await expect(
			readBoardIdentity(path, async () => ({
				board: "example",
				compatible: "ceralive-other",
				family: "rk3566",
				architecture: "arm64",
			})),
		).rejects.toMatchObject({ reason: "rauc_compatible_mismatch" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("channel address is persisted in rollback-compatible image preferences", async () => {
	const { mkdtemp, readFile, rm } = await import("node:fs/promises");
	const { saveUpdateSettings, loadUpdateSettings } = await import(
		"../modules/system/update-settings.ts"
	);
	const dir = await mkdtemp("/var/tmp/channel-setting-");
	try {
		const path = `${dir}/update-settings.json`;
		saveUpdateSettings(
			{
				...updateSettingsSchema.parse({}),
				channelUrl: "https://updates.example.invalid/bench",
			},
			path,
		);
		expect((await loadUpdateSettings(path)).channelUrl).toBe(
			"https://updates.example.invalid/bench",
		);
		expect(JSON.parse(await readFile(path, "utf8")).channelUrl).toBeUndefined();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("package discovery honors each image family and native architecture", async () => {
	const { parseKernelPackages } = await import(
		"../modules/system/update-orchestrator/kernel-packages.ts"
	);
	for (const family of ["rk3588", "rk3566", "bcm2711", "bcm2712", "x86_64"]) {
		const arch = family === "x86_64" ? "amd64" : "arm64";
		const text = `Package: linux-image-7.2.0-ceralive-${family}\nVersion: 7.2.0-ceralive1\nArchitecture: ${arch}\nSHA256: ${"a".repeat(64)}\nFilename: pool/kernel.deb\nSize: 100\n`;
		expect(parseKernelPackages(text, family, arch)).toHaveLength(1);
		expect(() =>
			parseKernelPackages(text, family, arch === "amd64" ? "arm64" : "amd64"),
		).toThrow();
	}
});
test("unsupported board checks are a calm state, not a failure notification", async () => {
	const { checkOsManifestResult } = await import(
		"../modules/system/update-orchestrator/runtime.ts"
	);
	const { OsAgentError } = await import(
		"../modules/system/update-orchestrator/os-identity.ts"
	);
	const result = await checkOsManifestResult("beta", async () => {
		throw new OsAgentError("board_updates_not_offered");
	});
	expect(result).toMatchObject({
		available: false,
		failed: false,
		boardNotOffered: true,
	});
});
test("transport preflight resolves the configured image host", async () => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { saveUpdateSettings, setUpdateSettingsFilePathForTest } = await import(
		"../modules/system/update-settings.ts"
	);
	const { selectUpdateTransport } = await import(
		"../modules/system/update-transport/executor.ts"
	);
	const dir = await mkdtemp("/var/tmp/channel-probe-");
	const path = `${dir}/update-settings.json`;
	const calls: string[][] = [];
	setUpdateSettingsFilePathForTest(path);
	try {
		saveUpdateSettings(
			{
				...updateSettingsSchema.parse({}),
				channelUrl: "https://updates.example.invalid/bench",
			},
			path,
		);
		await selectUpdateTransport(
			{ profile: "os", board: "example", channel: "beta" },
			{
				listIfnames: () => ["eth0"],
				readSources: async () => "",
				credentials: async () => undefined,
				mmIfnames: () => [],
				routerIfnames: () => [],
				dongleIfnames: () => [],
				run: async (argv) => {
					calls.push(argv);
					return {
						exitCode: argv[0] === "nmcli" ? 0 : 1,
						stdout:
							argv[0] === "nmcli"
								? "GENERAL.DEVICE:eth0\nGENERAL.TYPE:ethernet\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:no"
								: "",
						stderr: "",
					};
				},
			},
		);
		expect(calls.some((argv) => argv.includes("updates.example.invalid"))).toBe(
			true,
		);
		expect(calls.some((argv) => argv.includes("images.ceralive.tv"))).toBe(
			false,
		);
	} finally {
		setUpdateSettingsFilePathForTest(null);
		await rm(dir, { recursive: true, force: true });
	}
});
