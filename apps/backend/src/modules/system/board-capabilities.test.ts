import { describe, expect, test } from "bun:test";
import { hasCapability, parseBoardIdentity } from "./board-capabilities.ts";
import type { DeviceDetectionDeps } from "./device-detection.ts";

const unknown: DeviceDetectionDeps = {
	getDeviceTypeOverride: () => undefined,
	isDevelopment: () => false,
	readDeviceTreeCompatible: async () => "brcm,bcm2712",
	readDeviceTreeModel: async () => "Example board",
	readCeraliveRelease: async () => "",
	readDmiProductName: async () => "",
	readDmiBoardName: async () => "",
};
const record =
	'ID=ceralive\nBOARD=example-board\nFAMILY=bcm2712\nCAPABILITIES="client-internet wifi-country sim-autounlock"\n';
describe("image board capabilities", () => {
	test("non-RK3588 image enables client internet", async () => {
		expect(
			await hasCapability("client-internet", {
				...unknown,
				readCeraliveRelease: async () => record,
			}),
		).toBe(true);
	});
	test("unknown board without a record keeps legacy emulation", async () => {
		expect(await hasCapability("client-internet", unknown)).toBe(false);
	});
	test("record does not invent an encoder or HDMI input", async () => {
		for (const capability of ["hw-encoder", "hdmi-rx", "b-key-modem"] as const)
			expect(
				await hasCapability(capability, {
					...unknown,
					readCeraliveRelease: async () => record,
				}),
			).toBe(false);
	});
	test("legacy RK3588 images retain existing capabilities", async () => {
		expect(
			await hasCapability("client-internet", {
				...unknown,
				readDeviceTreeCompatible: async () => "rockchip,rk3588",
			}),
		).toBe(true);
	});
	test("development and emulation override a valid record", async () => {
		for (const deps of [
			{ isDevelopment: () => true },
			{ getDeviceTypeOverride: () => "emulated" },
		])
			expect(
				await hasCapability("client-internet", {
					...unknown,
					readCeraliveRelease: async () => record,
					...deps,
				}),
			).toBe(false);
	});
	test("malformed, duplicate and incomplete records are rejected", () => {
		for (const value of [
			`${record}BOARD=other\n`,
			record.replace("BOARD=example-board", "BOARD=$(id)"),
			record.replace("FAMILY=bcm2712\n", ""),
			record.replace("ID=ceralive", "ID=other"),
		])
			expect(parseBoardIdentity(value)).toBeNull();
	});
	test("explicit empty capabilities denies even on recognised hardware", async () => {
		expect(
			await hasCapability("client-internet", {
				...unknown,
				readDeviceTreeCompatible: async () => "rockchip,rk3588",
				readCeraliveRelease: async () =>
					record.replace("client-internet wifi-country sim-autounlock", ""),
			}),
		).toBe(false);
	});
});

test.each(["rockchip,rk3566", "brcm,bcm2711", "brcm,bcm2712", "generic,x86"])(
	"a %s image profile grants only declared services",
	async (compatible) => {
		const deps = {
			...unknown,
			readDeviceTreeCompatible: async () => compatible,
		};
		expect(await hasCapability("client-internet", deps)).toBe(false);
		const image = { ...deps, readCeraliveRelease: async () => record };
		expect(await hasCapability("client-internet", image)).toBe(true);
		expect(await hasCapability("sim-autounlock", image)).toBe(true);
		expect(await hasCapability("wifi-country", image)).toBe(true);
		expect(await hasCapability("os-updates", image)).toBe(false);
	},
);

test("an unreadable record falls back without rejecting", async () => {
	expect(
		await hasCapability("client-internet", {
			...unknown,
			readCeraliveRelease: async () => {
				throw new Error("unreadable");
			},
		}),
	).toBe(false);
});

test("invalid records deny even on legacy recognised hardware", async () => {
	expect(
		await hasCapability("client-internet", {
			...unknown,
			readDeviceTreeCompatible: async () => "rockchip,rk3588",
			readCeraliveRelease: async () => `${record}BOARD=duplicate\n`,
		}),
	).toBe(false);
});

for (const whitespace of [" ", "\t", "before-equals"]) {
	test(`malformed ${whitespace} identity denies all legacy grants`, async () => {
		const malformed = record.replace(
			/^(BOARD|FAMILY|CAPABILITIES)=/gm,
			(_, key) =>
				whitespace === "before-equals" ? `${key} =` : `${whitespace}${key}=`,
		);
		for (const capability of [
			"client-internet",
			"device-control",
			"os-updates",
		] as const)
			expect(
				await hasCapability(capability, {
					...unknown,
					readDeviceTreeCompatible: async () => "rockchip,rk3588",
					readCeraliveRelease: async () => malformed,
				}),
			).toBe(false);
	});
}
test("parser matrix retains inert metadata and normalizes duplicate grants", () => {
	expect(parseBoardIdentity(`# comment\n${record}EXTRA="$(id)"\n`)?.board).toBe(
		"example-board",
	);
	expect(
		parseBoardIdentity(record.replace("wifi-country", "client-internet"))
			?.capabilities.size,
	).toBe(2);
	for (const value of [
		record.replaceAll("\n", "\r\n"),
		record.replace(" wifi-country", "\twifi-country"),
		`${record}EXTRA=x\nEXTRA=y\n`,
	])
		expect(parseBoardIdentity(value)).toBeNull();
});
test("unreadable identity on recognized old hardware preserves compatibility", async () => {
	expect(
		await hasCapability("os-updates", {
			...unknown,
			readDeviceTreeCompatible: async () => "rockchip,rk3588",
			readCeraliveRelease: async () => {
				throw new Error("unreadable");
			},
		}),
	).toBe(true);
});

test("only syntactically valid branding-only records select legacy fallback", async () => {
	for (const malformed of [
		record.toLowerCase(),
		"ID=ceralive\ninvalid record\n",
		"ID=ceralive\nBOARD:example\n",
	]) {
		expect(
			await hasCapability("os-updates", {
				...unknown,
				readDeviceTreeCompatible: async () => "rockchip,rk3588",
				readCeraliveRelease: async () => malformed,
			}),
		).toBe(false);
	}
	expect(
		await hasCapability("os-updates", {
			...unknown,
			readDeviceTreeCompatible: async () => "rockchip,rk3588",
			readCeraliveRelease: async () => "ID=ceralive\nVERSION_ID=1.2.3\n",
		}),
	).toBe(true);
});
