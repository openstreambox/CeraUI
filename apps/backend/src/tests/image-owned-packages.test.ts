/// <reference types="bun" />

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "../helpers/logger.ts";
import {
	assertPinnedInstallSimulation,
	discoverAptAllPackages,
} from "../modules/system/apt-all-packages.ts";
import {
	FALLBACK_IMAGE_OWNED_PACKAGES,
	parseLocalOverridePin,
	readImageOwnedPackages,
	setImageOwnedPackagesReaderForTest,
} from "../modules/system/image-owned-packages.ts";
import {
	getUpdateState,
	resetAptReachabilityProbeForTest,
	resetSoftwareUpdateState,
	runUpdateDiscoveryAndReport,
	setAptCommandRunnerForTest,
	setAptReachabilityProbeForTest,
} from "../modules/system/software-updates.ts";
import { setCeraliveSourcesFileForTest } from "../modules/system/update-apt-channel.ts";
import { setUpdateCapabilityPathForTest } from "../modules/system/update-capabilities.ts";
import { StoredStateReadError } from "../modules/system/update-orchestrator/stored-state-file.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();

afterEach(() => setImageOwnedPackagesReaderForTest(null));

// The file the image's app layer writes (image-building-pipeline
// pin_first_party_local_overrides): its header, then one stanza per override.
const imagePin = `# First-party packages this image installed from a reviewed local override,
# pinned to that version (pin_first_party_local_overrides, app layer).

Package: ceralive-device
Pin: version 2026.11.5-20261124T222734.1dbec5e62
Pin-Priority: 1001

Package: libmm-glib0
Pin: version 1.24.2-2~ceralive.3+osb2
Pin-Priority: 1001

Package: modemmanager
Pin: version 1.24.2-2~ceralive.3+osb2
Pin-Priority: 1001
`;

// 5.1 (CeraUI 87f9c2c2f), 25 Nov: apt.ceralive.tv's own ceralive-device build is
// the candidate at the origin pin (990), beside a Debian upgrade. Installed and
// candidate versions as read on the box; rows in the format of LC_ALL=C
// apt-get -s -o Debug::NoLocking=1 upgrade --with-new-pkgs and apt-cache policy.
const installedCeraui = "2026.11.3-20261122T063253.87f9c2c2f";
const offeredCeraui = "2026.11.5-20261123T161439.05b3325";
const simulation = `Reading package lists...
Building dependency tree...
Reading state information...
Calculating upgrade...
The following packages will be upgraded:
  ceralive-device zstd
2 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.
Inst ceralive-device [${installedCeraui}] (${offeredCeraui} CeraLive:stable [arm64])
Inst zstd [1.5.6+dfsg-2] (1.5.7+dfsg-1 Debian:13.7/stable [arm64])
Conf ceralive-device (${offeredCeraui} CeraLive:stable [arm64])
Conf zstd (1.5.7+dfsg-1 Debian:13.7/stable [arm64])
`;
const ceraliveSource =
	"https://apt.ceralive.tv/dists/stable/binary-arm64 ./ Packages";
const debianSource = "https://deb.debian.org/debian trixie/main arm64 Packages";
const policies: Record<string, string> = {
	"ceralive-device": `ceralive-device:
  Installed: ${installedCeraui}
  Candidate: ${offeredCeraui}
  Version table:
     ${offeredCeraui} 990
        500 ${ceraliveSource}
 *** ${installedCeraui} 100
        100 /var/lib/dpkg/status
`,
	zstd: `zstd:
  Installed: 1.5.6+dfsg-2
  Candidate: 1.5.7+dfsg-1
  Version table:
     1.5.7+dfsg-1 500
        500 ${debianSource}
 *** 1.5.6+dfsg-2 100
        100 /var/lib/dpkg/status
`,
};
const sourcePolicy = `Package files:
 100 /var/lib/dpkg/status
     release a=now
 500 ${debianSource}
     release v=13.7,o=Debian,a=stable,n=trixie,l=Debian,c=main,b=arm64
     origin deb.debian.org
 500 ${ceraliveSource}
     release o=CeraLive,a=stable,n=stable,l=CeraLive,c=
     origin apt.ceralive.tv
Pinned packages:
`;
const policyFor = async (name: string) => policies[name] ?? "";

describe("the image's local-override pin", () => {
	it("names every package the image pinned", () => {
		expect(parseLocalOverridePin(imagePin)).toEqual([
			"ceralive-device",
			"libmm-glib0",
			"modemmanager",
		]);
	});

	it("reads a header-only file as pinning nothing", () => {
		expect(parseLocalOverridePin("# header\n# only\n")).toEqual([]);
		expect(parseLocalOverridePin("")).toEqual([]);
	});

	it.each([
		["a stanza without its priority", "Package: zstd\nPin: version 1\n"],
		[
			"an unknown field",
			"Package: zstd\nPin: version 1\nPin-Priority: 1001\nColor: red\n",
		],
		[
			"a repeated field",
			"Package: zstd\nPackage: tar\nPin: version 1\nPin-Priority: 1001\n",
		],
		[
			"an option-shaped name",
			"Package: -zstd\nPin: version 1\nPin-Priority: 1001\n",
		],
		["a line that is no field", "Package zstd\n"],
		[
			"a non-numeric priority",
			"Package: zstd\nPin: version 1\nPin-Priority: high\n",
		],
	])("refuses %s", (_label, text) => {
		expect(parseLocalOverridePin(text)).toBeNull();
	});
});

describe("readImageOwnedPackages", () => {
	it("trusts the image's record when it is there", async () => {
		// Given a pin file on disk in the image's shape.
		const dir = await mkdtemp(path.join(tmpdir(), "image-owned-"));
		const pin = path.join(dir, "ceralive-local-override");
		await writeFile(
			pin,
			imagePin.slice(0, imagePin.indexOf("\nPackage: modemmanager") + 1),
		);
		try {
			setImageOwnedPackagesReaderForTest(null, pin);
			// Then its names, and only its names, are the image's.
			const owned = await readImageOwnedPackages();
			expect(owned.source).toBe("image-record");
			expect([...owned.names]).toEqual(["ceralive-device", "libmm-glib0"]);
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	it("uses the built-in list on an image without a record", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "image-owned-"));
		try {
			setImageOwnedPackagesReaderForTest(
				null,
				path.join(dir, "ceralive-local-override"),
			);
			const owned = await readImageOwnedPackages();
			expect(owned.source).toBe("fallback");
			expect([...owned.names]).toEqual([...FALLBACK_IMAGE_OWNED_PACKAGES]);
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	it("uses the built-in list for a damaged or unreadable record, and says so once", async () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
		try {
			setImageOwnedPackagesReaderForTest(async () => "Package: zstd\n");
			expect((await readImageOwnedPackages()).source).toBe("fallback");
			expect((await readImageOwnedPackages()).source).toBe("fallback");
			setImageOwnedPackagesReaderForTest(async () => {
				throw new StoredStateReadError("oversize");
			});
			expect((await readImageOwnedPackages()).source).toBe("fallback");
			expect(warn.mock.calls.map((call) => call[1])).toEqual([
				{
					path: "/etc/apt/preferences.d/ceralive-local-override",
					problem: "malformed",
				},
				{
					path: "/etc/apt/preferences.d/ceralive-local-override",
					problem: "oversize",
				},
			]);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("discovery on a capable image (the 5.1 offer)", () => {
	it("still offers the image-owned package when nothing is withheld (the bug)", async () => {
		const result = await discoverAptAllPackages(
			simulation,
			"",
			policyFor,
			sourcePolicy,
		);
		expect(result.actionable.map(({ name }) => name)).toEqual([
			"ceralive-device",
			"zstd",
		]);
	});

	it("withholds what the image ships and keeps offering the rest", async () => {
		// Given the fallback list a 5.1 box gets (it has no pin record).
		const owned = new Set(FALLBACK_IMAGE_OWNED_PACKAGES);
		// When discovery runs over the box's plan.
		const result = await discoverAptAllPackages(
			simulation,
			"",
			policyFor,
			sourcePolicy,
			owned,
		);
		// Then ceralive-device is neither listed nor installable; zstd is.
		expect(result.packages).toEqual([
			{
				name: "zstd",
				version: "1.5.7+dfsg-1",
				origin: "Debian trixie",
				layer: "app",
				actionable: true,
			},
		]);
		expect(result.actionable).toEqual([
			{ name: "zstd", version: "1.5.7+dfsg-1" },
		]);
		expect(result.withheld).toEqual([
			{ name: "ceralive-device", version: offeredCeraui },
		]);
		// And the pinned install of what is left rechecks cleanly.
		expect(() =>
			assertPinnedInstallSimulation(
				`Inst zstd [1.5.6+dfsg-2] (1.5.7+dfsg-1 Debian:13.7/stable [arm64])\nConf zstd (1.5.7+dfsg-1 Debian:13.7/stable [arm64])\n`,
				result.actionable,
			),
		).not.toThrow();
	});

	it("matches an architecture-qualified row by its package name", async () => {
		const result = await discoverAptAllPackages(
			simulation.replaceAll("ceralive-device", "ceralive-device:arm64"),
			"",
			async (name) => policyFor(name.replace(":arm64", "")),
			sourcePolicy,
			new Set(["ceralive-device"]),
		);
		expect(result.withheld.map(({ name }) => name)).toEqual([
			"ceralive-device:arm64",
		]);
		expect(result.actionable.map(({ name }) => name)).toEqual(["zstd"]);
	});
});

describe("a capable package check on the 5.1 box", () => {
	it("publishes zstd alone, without the image's own CeraUI", async () => {
		// Given a capable image without a pin record (5.1) and the box's apt answers.
		const dir = await mkdtemp(path.join(tmpdir(), "image-owned-check-"));
		const capability = path.join(dir, "capabilities.json");
		await writeFile(
			capability,
			JSON.stringify({
				schema: 1,
				features: ["apt-all-packages", "rauc-verity-streaming"],
				ota_uid: 42041,
				apt_uid: 42042,
			}),
		);
		setUpdateCapabilityPathForTest(capability);
		setCeraliveSourcesFileForTest(path.join(dir, "sources"));
		setImageOwnedPackagesReaderForTest(
			null,
			path.join(dir, "ceralive-local-override"),
		);
		setAptReachabilityProbeForTest(async () => ({
			ipv4: "ok",
			ipv6: "ok",
			used: "any",
			verdict: "any",
			detail: [],
		}));
		setAptCommandRunnerForTest(async (argv) => ({
			exitCode: 0,
			stderr: "",
			stdout:
				argv[0] === "/usr/bin/apt-cache"
					? argv[2] === undefined
						? sourcePolicy
						: (policies[argv[2]] ?? "")
					: argv[0] === "/usr/bin/apt-mark"
						? ""
						: argv.includes("-s")
							? simulation
							: "",
		}));
		try {
			// When the check runs.
			expect(await runUpdateDiscoveryAndReport()).toBe(null);
			// Then the offer is zstd alone.
			const state = getUpdateState();
			expect(state).toMatchObject({
				kind: "available",
				actionable_count: 1,
				packages: [{ name: "zstd", version: "1.5.7+dfsg-1", actionable: true }],
			});
			expect(JSON.stringify(state)).not.toContain("ceralive-device");
		} finally {
			setUpdateCapabilityPathForTest(null);
			setCeraliveSourcesFileForTest(null);
			setAptCommandRunnerForTest(null);
			resetAptReachabilityProbeForTest();
			resetSoftwareUpdateState();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
