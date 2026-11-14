// @vitest-environment jsdom
/**
 * The power dialog's "update in progress" gate ends with the install (early
 * oracle F1 sweep, 2026-10-13). The terminal `updating` object is retained by
 * the store after the device has cleared its own latch, so a gate that reads
 * every non-success object as "running" kept Reboot and Power off disabled
 * after a failed install until the page reloaded. The device still decides
 * admission for every power request.
 */
import { m } from "@ceraui/i18n/svelte";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	destroyAsyncOperations,
	initAsyncOperations,
} from "../../lib/rpc/async-operation.svelte";
import PowerDialog from "./PowerDialog.svelte";

const state = vi.hoisted(() => ({
	updating: false as unknown,
	phone: false,
	startup: true as boolean | undefined,
}));

vi.mock("$lib/rpc/client", () => ({
	rpc: { system: { reboot: vi.fn(), poweroff: vi.fn() } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getStatus: () =>
		state.phone
			? {
					phone_box: true,
					carrying: { state: "unknown", startup: state.startup },
				}
			: undefined,
	getUplinks: () => undefined,
	getIsStreaming: () => false,
	getUpdating: () => state.updating,
	getIsConnected: () => true,
}));

vi.mock("$lib/stores/connection-ux.svelte", () => ({
	markRebooting: vi.fn(),
	clearRebooting: vi.fn(),
	getIsRebooting: () => false,
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
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

beforeEach(() => {
	initAsyncOperations();
});

afterEach(() => {
	destroyAsyncOperations();
	document.body.innerHTML = "";
});

const BLOCKED = "Update in progress. Wait before rebooting.";

function rebootButton(): HTMLButtonElement {
	const dialog = screen.getByRole("dialog", {
		name: m["settings.index.power"](),
	});
	return within(dialog).getByRole("button", {
		name: m["advanced.reboot"](),
	}) as HTMLButtonElement;
}

describe("PowerDialog — the update gate follows the device's install state", () => {
	it("blocks while an install runs", () => {
		state.updating = { downloading: 1, unpacking: 0, setting_up: 0, total: 2 };
		render(PowerDialog, { props: { open: true } });

		expect(document.body.textContent).toContain(BLOCKED);
		expect(rebootButton().disabled).toBe(true);
	});

	it("is released by a failed install the device already finished", () => {
		state.updating = {
			downloading: 2,
			unpacking: 2,
			setting_up: 1,
			total: 2,
			result: "E: Sub-process /usr/bin/dpkg returned an error code (1)",
		};
		render(PowerDialog, { props: { open: true } });

		expect(document.body.textContent).not.toContain(BLOCKED);
		expect(rebootButton().disabled).toBe(false);
	});

	it("is released by a successful install", () => {
		state.updating = {
			downloading: 1,
			unpacking: 1,
			setting_up: 1,
			total: 1,
			result: 0,
		};
		render(PowerDialog, { props: { open: true } });

		expect(rebootButton().disabled).toBe(false);
	});
});

it("allows confirmed poweroff during phone startup while holding restart", async () => {
	state.updating = false;
	state.phone = true;
	try {
		render(PowerDialog, { props: { open: true } });
		expect(rebootButton().disabled).toBe(true);
		const power = screen.getByRole("button", {
			name: m["advanced.powerOff"](),
		});
		expect(power).toHaveProperty("disabled", false);
		await fireEvent.click(power);
		expect(document.body.textContent).toContain(
			"If your phone is streaming through the box, that stream drops",
		);
	} finally {
		state.phone = false;
	}
});

it.each([false, undefined])(
	"holds power off when checking is no longer startup (%s)",
	(startup) => {
		state.updating = false;
		state.phone = true;
		state.startup = startup;
		try {
			render(PowerDialog, { props: { open: true } });
			expect(
				screen.getByRole("button", { name: m["advanced.powerOff"]() }),
			).toHaveProperty("disabled", true);
			expect(rebootButton().disabled).toBe(true);
		} finally {
			state.phone = false;
			state.startup = true;
		}
	},
);
