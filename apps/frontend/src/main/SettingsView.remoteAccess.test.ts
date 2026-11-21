// @vitest-environment jsdom
/**
 * SettingsView: the Remote access entry exists only on images with Tailscale.
 * A backend that predates the field, or an image without tailscaled
 * (`unavailable`), shows no entry at all, so upstream images look unchanged.
 */
import type { TailscaleStatus } from "@ceraui/rpc/schemas";
import { render, screen } from "@testing-library/svelte";
import { beforeAll, describe, expect, it, vi } from "vitest";

import SettingsView from "./SettingsView.svelte";

const noop = vi.hoisted(
	() => async () =>
		({ default: (await import("../tests/fixtures/Noop.svelte")).default }) as {
			default: unknown;
		},
);
vi.mock("./dialogs/CloudRemoteDialog.svelte", noop);
vi.mock("./dialogs/NetworkIngestDialog.svelte", noop);
vi.mock("./dialogs/LogsDialog.svelte", noop);
vi.mock("./dialogs/PasswordDialog.svelte", noop);
vi.mock("./dialogs/PowerDialog.svelte", noop);
vi.mock("./dialogs/SshDialog.svelte", noop);
vi.mock("./dialogs/RemoteAccessDialog.svelte", noop);
vi.mock("./dialogs/UpdatesDialog.svelte", noop);
vi.mock("./dialogs/VersionsDialog.svelte", noop);
vi.mock("./settings/AddonsSection.svelte", noop);
vi.mock("./settings/DeviceStatsSection.svelte", noop);
vi.mock("./settings/OnDeviceDisplaySection.svelte", noop);
vi.mock("./settings/RemoteControlStatus.svelte", noop);
vi.mock("$lib/components/custom/LocaleSelector.svelte", noop);
vi.mock("$lib/components/custom/LowDiskBanner.svelte", noop);
vi.mock("$lib/components/custom/mode-toggle.svelte", noop);

const feed = vi.hoisted(() => ({
	tailscale: undefined as TailscaleStatus | undefined,
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getStatus: () => undefined,
	getUplinks: () => undefined,
	getIsConnected: () => true,
	getConfig: () => ({ autostart: false }),
	getKiosk: () => undefined,
	getTailscale: () => feed.tailscale,
}));

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
});

describe("Remote access entry", () => {
	const cases: Array<[string, TailscaleStatus | undefined, boolean]> = [
		["absent (older backend)", undefined, false],
		["unavailable (no tailscaled)", { state: "unavailable" }, false],
		["off", { state: "off" }, true],
		["needs a key", { state: "needs_key" }, true],
		["connected", { state: "connected", hostname: "box" }, true],
	];
	for (const [name, status, shown] of cases) {
		it(`${shown ? "shows" : "hides"} the entry when ${name}`, () => {
			feed.tailscale = status;
			const { unmount } = render(SettingsView);
			const entry = screen.queryByTestId("settings-entry-remoteAccess");
			expect(entry !== null).toBe(shown);
			// SSH is always there; Remote access sits right after it.
			const ssh = screen.getByTestId("settings-entry-ssh");
			if (entry) expect(ssh.nextElementSibling).toBe(entry);
			unmount();
		});
	}
});
