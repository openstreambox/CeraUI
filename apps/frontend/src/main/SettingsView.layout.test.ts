// @vitest-environment jsdom
/**
 * SettingsView — what a phone sees first.
 *
 * The device telemetry grid (SoC temperature, DDR, CPU frequency, encoder
 * cores…) used to open Settings, above every setting a streamer would change.
 * It now sits below the settings groups, still always visible. The top carries
 * one temperature line, and only while the box is warm or hot.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { destroyAsyncOperations } from "$lib/rpc/async-operation.svelte";
import SettingsView from "./SettingsView.svelte";

// --- Heavy children replaced by an inert stub (they each pull a subscription
//     graph we don't need to test the autostart switch). ----------------------
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
vi.mock("./dialogs/UpdatesDialog.svelte", noop);
vi.mock("./dialogs/VersionsDialog.svelte", noop);
vi.mock("./settings/AddonsSection.svelte", noop);
vi.mock("./settings/DeviceStatsSection.svelte", async () => ({
	default: (await import("../tests/fixtures/DeviceStatsStub.svelte")).default,
}));
vi.mock("./settings/OnDeviceDisplaySection.svelte", noop);
vi.mock("./settings/RemoteControlStatus.svelte", noop);
vi.mock("$lib/components/custom/LocaleSelector.svelte", noop);
vi.mock("$lib/components/custom/LowDiskBanner.svelte", noop);
vi.mock("$lib/components/custom/mode-toggle.svelte", noop);

const state = vi.hoisted(() => ({
	autostart: false,
	socTemp: null as number | null,
}));
const setAutostart = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

// `osCommand`'s catch arm narrows on `ConnectionResetError`, so a mock without
// it throws a vitest "no export defined" error before the failure toast can
// fire and the revert leg reports as a missing toast rather than a real
// regression. Import the real class rather than restating its shape.
vi.mock("$lib/rpc/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/rpc/client")>()),
	rpc: { system: { setAutostart } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getStatus: () => undefined,
	getUplinks: () => undefined,
	getConfig: () => ({ autostart: state.autostart }),
	getKiosk: () => undefined,
	getDeviceStats: () => ({ socTemp: state.socTemp }),
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: toastError, success: vi.fn() },
}));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const autostartSwitch = () =>
	screen.getByTestId("settings-autostart-switch") as HTMLButtonElement;

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

beforeEach(() => {
	state.autostart = false;
	state.socTemp = null;
	setAutostart.mockReset();
	toastError.mockClear();
});

afterEach(() => {
	destroyAsyncOperations();
});

const thermal = () => screen.queryByTestId("settings-thermal-notice");

describe("SettingsView — settings first, telemetry below", () => {
	it("places Device stats after every settings group", () => {
		render(SettingsView);
		const stats = screen.getByTestId("device-stats");
		const entries = screen.getAllByTestId(/^settings-entry-/);
		const last = entries.at(-1) as HTMLElement;
		expect(
			last.compareDocumentPosition(stats) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("shows no temperature line while the box is fine", () => {
		state.socTemp = 52.4;
		render(SettingsView);
		expect(thermal()).toBeNull();
	});

	it.each([
		[74.2, "warm", "The box is warm"],
		[88, "hot", "The box is hot"],
	])(
		"at %s °C says the box is %s, above the settings groups",
		(temp, band, title) => {
			state.socTemp = temp;
			render(SettingsView);
			const notice = thermal() as HTMLElement;
			expect(notice).not.toBeNull();
			expect(notice.dataset.band).toBe(band);
			expect(notice.textContent).toContain(title);
			expect(notice.textContent).toContain(`${temp.toFixed(1)} °C`);
			const first = screen.getAllByTestId(/^settings-entry-/)[0] as HTMLElement;
			expect(
				notice.compareDocumentPosition(first) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
		},
	);
});
