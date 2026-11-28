import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { logger } from "../helpers/logger.ts";
import {
	IMAGE_APT_SOURCE_POLICY,
	imageAptSourceMode,
	setImageAptSourceReaderForTest,
} from "../modules/system/image-apt-source.ts";
import {
	hasKernelAptStage,
	readUpdateCapabilities,
	setUpdateCapabilityPathForTest,
} from "../modules/system/update-capabilities.ts";
import { getUpdateCapabilitiesProcedure } from "../rpc/procedures/system.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const dir = mkdtempSync(join(tmpdir(), "ceraui-update-capabilities-"));
const file = join(dir, "update-capabilities.json");
const context = {
	ws: {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: () => {},
	} as unknown as AppWebSocket,
	isAuthenticated: () => true,
	authenticate: () => {},
	deauthenticate: () => {},
	markActive: () => {},
	getLastActive: () => 0,
	setSenderId: () => {},
	getSenderId: () => undefined,
	clearSenderId: () => {},
} satisfies RPCContext;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const HOST = "updates.example.org";
const SOURCES_FILE = "/etc/apt/sources.list.d/example-image.sources";
const SUITE = "rock-5b-plus-2026.11.6";
const IMAGE_SOURCE = {
	[IMAGE_APT_SOURCE_POLICY]: `{"schema":1,"sourcesFile":"${SOURCES_FILE}","host":"${HOST}","origin":"OpenStreamBox","label":"OpenStreamBox","suites":["${SUITE}","${SUITE}-emergency"]}`,
	[SOURCES_FILE]: `Types: deb\nURIs: https://${HOST}/synthetic-test-token-0001/apt/\nSuites: ${SUITE} ${SUITE}-emergency\nComponents: main\nSigned-By: /usr/share/keyrings/example-archive-keyring.pgp\n`,
};
const imageSource = (files: Record<string, string>) =>
	setImageAptSourceReaderForTest((path) => files[path] ?? null);

afterEach(() => {
	setImageAptSourceReaderForTest(null);
	setUpdateCapabilityPathForTest(null);
});

describe("image update capabilities", () => {
	test("missing file is legacy without OS or slot-sync features", async () => {
		// Given no image capability file, when read, then the legacy set applies.
		expect(await readUpdateCapabilities(file)).toEqual({
			mode: "legacy",
			features: [],
		});
	});

	test("invalid present content refuses an unknown regime without advertising unsupported features", async () => {
		// Given a malformed schema carrying a tempting feature, when read.
		writeFileSync(
			file,
			JSON.stringify({
				schema: 2,
				features: ["slot-sync", "apt-all-packages"],
			}),
		);
		// Then neither feature may reach the operator.
		await expect(readUpdateCapabilities(file)).rejects.toMatchObject({
			reason: "discovery_failed",
		});
	});

	test("an unknown feature token is invalid rather than silently advertised", async () => {
		// Given an unrecognised feature beside apt-all-packages, when read, then neither regime is granted.
		writeFileSync(
			file,
			JSON.stringify({
				schema: 1,
				features: ["apt-all-packages", "future-unreviewed-feature"],
				ota_uid: 999,
				apt_uid: 42,
			}),
		);
		await expect(readUpdateCapabilities(file)).rejects.toMatchObject({
			reason: "discovery_failed",
		});
	});

	test("the current image empty feature array stays legacy-equivalent", async () => {
		// Given the image's honest early carrier, when read, then no agent is enabled.
		writeFileSync(
			file,
			JSON.stringify({ schema: 1, features: [], ota_uid: 999, apt_uid: 42 }),
		);
		expect(await readUpdateCapabilities(file)).toEqual({
			mode: "legacy",
			features: [],
		});
	});

	test("a partial feature file without apt-all-packages cannot advertise slot-sync", async () => {
		// Given a staged image with only a slot-sync token, when read, then legacy wins.
		writeFileSync(
			file,
			JSON.stringify({
				schema: 1,
				features: ["slot-sync"],
				ota_uid: 999,
				apt_uid: 42,
			}),
		);
		expect(await readUpdateCapabilities(file)).toEqual({
			mode: "legacy",
			features: [],
		});
	});

	test("only an apt-all-packages image can leave the legacy roster", async () => {
		// Given a valid partial image, when read, then named capabilities are preserved.
		writeFileSync(
			file,
			JSON.stringify({
				schema: 1,
				features: ["apt-all-packages", "slot-sync"],
				ota_uid: 999,
				apt_uid: 42,
			}),
		);
		expect(await readUpdateCapabilities(file)).toEqual({
			mode: "capable",
			features: ["apt-all-packages", "slot-sync"],
		});
	});

	test("authenticated RPC reports the same legacy decision", async () => {
		// Given the dev host without the image file, when queried by the RPC.
		imageSource({});
		// Then no OS or slot-sync capability is asserted, and package installs
		// follow the automatic setting.
		expect(
			await call(getUpdateCapabilitiesProcedure, undefined, { context }),
		).toEqual({ mode: "legacy", features: [], packageInstallsManual: false });
	});

	describe("package installs on an image with its own apt source", () => {
		const capable = () =>
			writeFileSync(
				file,
				JSON.stringify({
					schema: 1,
					features: ["apt-all-packages", "slot-sync"],
					ota_uid: 999,
					apt_uid: 42,
				}),
			);

		test("a valid image source record makes package installs manual-only", async () => {
			// Given a capable image that ships a valid image apt source record.
			capable();
			setUpdateCapabilityPathForTest(file);
			imageSource(IMAGE_SOURCE);
			expect(imageAptSourceMode().kind).toBe("active");
			// When the dialog reads the capabilities, then the regime is unchanged
			// and package installs are reported as manual-only.
			expect(
				await call(getUpdateCapabilitiesProcedure, undefined, { context }),
			).toEqual({
				mode: "capable",
				features: ["apt-all-packages", "slot-sync"],
				packageInstallsManual: true,
			});
		});

		test("without the record package installs are not manual-only", async () => {
			// Given the same capable image without an image apt source record.
			capable();
			setUpdateCapabilityPathForTest(file);
			imageSource({});
			// When read through the RPC, then automatic installs stay possible.
			expect(
				await call(getUpdateCapabilitiesProcedure, undefined, { context }),
			).toEqual({
				mode: "capable",
				features: ["apt-all-packages", "slot-sync"],
				packageInstallsManual: false,
			});
		});

		test("a record that does not validate still makes package installs manual-only", async () => {
			// Given an image whose record is there but unusable: the backend
			// refuses package checks and never installs on its own.
			const warn = spyOn(logger, "warn").mockImplementation(() => logger);
			imageSource({ [IMAGE_APT_SOURCE_POLICY]: '{"schema":2}' });
			try {
				// When read through the RPC, then the automatic switch is not offered.
				expect(
					await call(getUpdateCapabilitiesProcedure, undefined, { context }),
				).toMatchObject({ packageInstallsManual: true });
			} finally {
				warn.mockRestore();
			}
		});

		test("the internal regime reader is not widened by the reply field", async () => {
			// Given a valid record, when the orchestrator's own reader runs,
			// then it keeps answering only the image's regime.
			capable();
			imageSource(IMAGE_SOURCE);
			expect(await readUpdateCapabilities(file)).toEqual({
				mode: "capable",
				features: ["apt-all-packages", "slot-sync"],
			});
		});
	});

	test.each([
		{
			features: ["apt-all-packages", "kernel-apt-stage"],
			mode: "capable",
			kernel: true,
		},
		{ features: ["apt-all-packages"], mode: "capable", kernel: false },
		{ features: [], mode: "legacy", kernel: false },
		{ features: ["kernel-apt-stage"], mode: "legacy", kernel: false },
	])(
		"kernel feature gate for $features",
		async ({ features, mode, kernel }) => {
			// Given a valid image declaration with only the feature set varied.
			writeFileSync(
				file,
				JSON.stringify({ schema: 1, features, ota_uid: 999, apt_uid: 42 }),
			);
			// When the real capability reader selects the regime.
			const caps = await readUpdateCapabilities(file);
			// Then only a capable image with kernel staging grants the kernel lane.
			expect(caps.mode).toBe(mode);
			expect(hasKernelAptStage(caps)).toBe(kernel);
		},
	);

	test("a legacy RPC declaration cannot grant kernel staging", () => {
		// Given legacy mode even with a known token, when gated, then mode still refuses.
		expect(
			hasKernelAptStage({ mode: "legacy", features: ["kernel-apt-stage"] }),
		).toBe(false);
	});
});
