// @vitest-environment jsdom
/**
 * On a phone-only box, restart is never a dead end. While the box carries
 * a phone's stream (or still can't tell after the startup check), Reboot turns
 * into a hold-to-restart button plus a plain "Restart without holding" button.
 * Both open a confirmation that names the cost for the phone's way and offers
 * "Restart anyway", which is the only path that sends `acceptCarryingCost`.
 */
import { m } from "@ceraui/i18n/svelte";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
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
} from "$lib/rpc/async-operation.svelte";
import PowerDialog from "./PowerDialog.svelte";

type Carrying = "streaming" | "idle" | "unknown";
const state = vi.hoisted(() => ({
	status: undefined as
		| { phone_box: boolean; carrying?: { state: Carrying; startup?: boolean } }
		| undefined,
	streaming: false,
	updating: false as unknown,
}));
const rebootRpc = vi.hoisted(() => vi.fn());
const poweroffRpc = vi.hoisted(() => vi.fn());
const markRebooting = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc/client", () => ({
	rpc: { system: { reboot: rebootRpc, poweroff: poweroffRpc } },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getStatus: () => state.status,
	getUplinks: () => undefined,
	getIsStreaming: () => state.streaming,
	getUpdating: () => state.updating,
	getIsConnected: () => true,
}));
vi.mock("$lib/stores/connection-ux.svelte", () => ({
	markRebooting,
	clearRebooting: vi.fn(),
	getIsRebooting: () => true,
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const HOLD = m["live.phone.restartHoldLabel"]();
const NO_HOLD = m["live.phone.restartNoHold"]();
const ANYWAY = m["live.phone.restartAnyway"]();
const ANYWAY_TITLE = m["live.phone.restartAnywayTitle"]();

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
	state.status = { phone_box: true, carrying: { state: "streaming" } };
	state.streaming = false;
	state.updating = false;
	rebootRpc.mockReset();
	rebootRpc.mockResolvedValue({ success: true });
	poweroffRpc.mockReset();
	markRebooting.mockClear();
	initAsyncOperations();
});

afterEach(() => {
	vi.useRealTimers();
	destroyAsyncOperations();
	document.body.innerHTML = "";
});

function confirmDialog() {
	return screen.queryByRole("dialog", { name: ANYWAY_TITLE });
}

describe("restart while carrying a phone's stream", () => {
	it.each([
		["moblin", "With Moblin, your phone keeps streaming on its own SIM"],
		["srt", "With IRL Pro or another SRT app, your stream stops"],
		["internet", "With Just internet, your phone loses the box's internet"],
		[null, "with Moblin your phone keeps streaming on its own SIM"],
	] as const)("names the cost for way %s", async (way, cost) => {
		render(PowerDialog, { props: { open: true, way } });
		await fireEvent.click(screen.getByRole("button", { name: NO_HOLD }));
		const dialog = confirmDialog();
		expect(dialog).toBeTruthy();
		expect(dialog?.textContent).toContain(cost);
		expect(
			within(dialog as HTMLElement).getByRole("button", { name: ANYWAY }),
		).toBeTruthy();
	});

	it("Restart anyway sends the acceptance and hands off to the reboot banner", async () => {
		render(PowerDialog, { props: { open: true, way: "srt" } });
		await fireEvent.click(screen.getByRole("button", { name: NO_HOLD }));
		await fireEvent.click(
			within(confirmDialog() as HTMLElement).getByRole("button", {
				name: ANYWAY,
			}),
		);
		await waitFor(() =>
			expect(rebootRpc).toHaveBeenCalledWith({ acceptCarryingCost: true }),
		);
		await waitFor(() => expect(markRebooting).toHaveBeenCalledOnce());
	});

	it("cancel sends nothing", async () => {
		render(PowerDialog, { props: { open: true } });
		await fireEvent.click(screen.getByRole("button", { name: NO_HOLD }));
		const dialog = confirmDialog() as HTMLElement;
		await fireEvent.click(
			within(dialog).getByRole("button", { name: m["dialogs.cancel"]() }),
		);
		expect(rebootRpc).not.toHaveBeenCalled();
	});

	it("a one-second hold opens the confirmation", async () => {
		vi.useFakeTimers();
		render(PowerDialog, { props: { open: true } });
		const hold = screen.getByRole("button", { name: HOLD });
		await fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
		expect(hold.textContent).toContain(m["live.phone.restartHolding"]());
		await vi.advanceTimersByTimeAsync(999);
		expect(confirmDialog()).toBeNull();
		await vi.advanceTimersByTimeAsync(1);
		await fireEvent.pointerUp(hold, { button: 0, pointerId: 1 });
		await fireEvent.click(hold);
		expect(confirmDialog()).toBeTruthy();
		expect(rebootRpc).not.toHaveBeenCalled();
	});

	it("a short tap only explains the hold and the alternative", async () => {
		vi.useFakeTimers();
		render(PowerDialog, { props: { open: true } });
		const hold = screen.getByRole("button", { name: HOLD });
		await fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
		await vi.advanceTimersByTimeAsync(300);
		await fireEvent.pointerUp(hold, { button: 0, pointerId: 1 });
		await fireEvent.click(hold);
		await vi.advanceTimersByTimeAsync(2000);
		expect(confirmDialog()).toBeNull();
		expect(document.body.textContent).toContain(
			m["live.phone.restartHoldHint"](),
		);
	});

	it("an assistive-technology click alone never restarts", async () => {
		render(PowerDialog, { props: { open: true } });
		await fireEvent.click(screen.getByRole("button", { name: HOLD }));
		expect(confirmDialog()).toBeNull();
		expect(document.body.textContent).toContain(
			m["live.phone.restartHoldHint"](),
		);
	});

	it("holding Enter for a second works from the keyboard", async () => {
		vi.useFakeTimers();
		render(PowerDialog, { props: { open: true } });
		const hold = screen.getByRole("button", { name: HOLD });
		await fireEvent.keyDown(hold, { key: "Enter" });
		await fireEvent.keyDown(hold, { key: "Enter", repeat: true });
		await vi.advanceTimersByTimeAsync(1000);
		await fireEvent.keyUp(hold, { key: "Enter" });
		expect(confirmDialog()).toBeTruthy();
	});

	it("the hold button is described by the cost line", () => {
		render(PowerDialog, { props: { open: true, way: "moblin" } });
		const hold = screen.getByRole("button", { name: HOLD });
		const ids = (hold.getAttribute("aria-describedby") ?? "").split(" ");
		const described = ids
			.map((id) => document.getElementById(id)?.textContent ?? "")
			.join(" ");
		expect(described).toContain(
			"Your phone's stream is going through the box.",
		);
		expect(described).toContain("With Moblin");
	});
});

describe("what still holds restart", () => {
	it("the startup check holds it", () => {
		state.status = {
			phone_box: true,
			carrying: { state: "unknown", startup: true },
		};
		render(PowerDialog, { props: { open: true } });
		expect(screen.queryByRole("button", { name: HOLD })).toBeNull();
		expect(
			screen.getByRole("button", { name: m["advanced.reboot"](), exact: true }),
		).toHaveProperty("disabled", true);
	});

	it("the box's own stream holds it", () => {
		state.streaming = true;
		render(PowerDialog, { props: { open: true } });
		expect(screen.queryByRole("button", { name: HOLD })).toBeNull();
		expect(screen.queryByRole("button", { name: NO_HOLD })).toBeNull();
	});

	it("a running install holds it", () => {
		state.updating = { downloading: 1, unpacking: 0, setting_up: 0, total: 2 };
		render(PowerDialog, { props: { open: true } });
		expect(screen.queryByRole("button", { name: HOLD })).toBeNull();
	});

	it("an idle phone-only box restarts without the acceptance", async () => {
		state.status = { phone_box: true, carrying: { state: "idle" } };
		render(PowerDialog, { props: { open: true } });
		expect(screen.queryByRole("button", { name: HOLD })).toBeNull();
		const label = m["advanced.reboot"]();
		await fireEvent.click(
			screen.getByRole("button", { name: label, exact: true }),
		);
		const dialog = screen.getByRole("dialog", {
			name: m["dialogs.areYouSure"](),
		});
		await fireEvent.click(
			within(dialog).getByRole("button", { name: label, exact: true }),
		);
		await waitFor(() => expect(rebootRpc).toHaveBeenCalledWith());
	});
});
