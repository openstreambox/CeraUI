// @vitest-environment jsdom
import type { WifiInterface } from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { toast as sonnerToast } from "svelte-sonner";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import {
	beginOperation,
	destroyAsyncOperations,
	getOperationPhase,
	getOperationTarget,
	initAsyncOperations,
	osCommand,
	sweepOperations,
} from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";
import { NotSentError, RpcError } from "$lib/rpc/rpc-error";
import { noteLinkState } from "$lib/rpc/session-epoch.svelte";
import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";
import { setWifiAdapterModesForTest } from "$lib/rpc/wifi-adapter-modes.svelte";
import {
	noteWifiConfig,
	pendingWifiStartReceiptsForTest,
} from "$lib/rpc/wifi-status-receipt";
import HotspotActivationConfirm from "$main/network/HotspotActivationConfirm.svelte";
import WifiModeSelector from "$main/network/WifiModeSelector.svelte";
import { deriveWifiAdapterModeView } from "$main/network/wifi-adapter-mode-view";
import { withWifiEntryRetry } from "$main/network/wifi-entry-request";
import {
	wifiHotspotConfigOpKey,
	wifiHotspotOpKey,
	wifiModeOpKey,
} from "$main/network/wifi-station-lock";
import HotspotDialog from "./HotspotDialog.svelte";

const wire = vi.hoisted(() => ({
	message: (_type: string, _data: unknown) => {},
}));
vi.mock("$lib/rpc/client", async () => ({
	ConnectionResetError: (
		await vi.importActual<typeof import("$lib/rpc/client")>("$lib/rpc/client")
	).ConnectionResetError,
	rpc: {
		wifi: {
			hotspotPrepare: vi.fn(),
			hotspotStart: vi.fn(),
			hotspotStop: vi.fn(),
			hotspotConfigure: vi.fn(),
			getAdapterModes: vi.fn(async () => ({})),
			setAdapterMode: vi.fn(),
		},
	},
	rpcClient: {
		onMessage: (fn: typeof wire.message) => {
			wire.message = fn;
		},
		onConnectionChange: () => () => {},
		connect: () => {},
		getConnectionState: () => "connected",
		getSocket: () => undefined,
		sendLegacy: () => {},
	},
}));
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "") } }));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const prepare = vi.mocked(rpc.wifi.hotspotPrepare);
const start: MockInstance<typeof rpc.wifi.hotspotStart> = vi.mocked(
	rpc.wifi.hotspotStart,
);
const toast: { error: MockInstance<typeof sonnerToast.error> } = {
	error: vi.mocked(sonnerToast.error),
};
const warning = vi.mocked(sonnerToast.warning);
const configure = vi.mocked(rpc.wifi.hotspotConfigure);
const mode = vi.mocked(rpc.wifi.setAdapterMode);
const unobserved = {
	success: false,
	error: "radio-changed",
	reason: "current-unobserved",
} as const;
const changed = { success: false, error: "radio-changed" } as const;

function row(
	incarnation: string | undefined = "radio-A",
	active = false,
): WifiInterface {
	return {
		ifname: "wlan0",
		hw: "same-model",
		conn: active ? "ap-uuid" : "Home",
		saved: {},
		supports_hotspot: true,
		supports_ap_sta_concurrency: true,
		...(incarnation === undefined ? {} : { incarnation }),
		...(active
			? {
					mode: "hotspot",
					hotspot: {
						name: `${incarnation}-stored`,
						password: "stored-password",
						channel: "auto",
						available_channels: {
							auto: { name: "Automatic" },
							ch_6: { name: "Channel 6" },
						},
						security: "wpa2",
						available_security: {
							wpa2: { name: "WPA2" },
							"wpa3-sae": { name: "WPA3" },
						},
					},
				}
			: {}),
	};
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function input(id: string): HTMLInputElement {
	const element = document.querySelector<HTMLInputElement>(
		`#${id}, [data-testid="${id}"]`,
	);
	if (!element) throw new Error(`Missing input ${id}`);
	return element;
}

async function gate() {
	await fireEvent.click(
		screen.getByRole("button", { name: "Turn on hotspot" }),
	);
	await ready();
}

async function ready() {
	await waitFor(() =>
		expect(screen.getByTestId("hotspot-activation-confirm").dataset.phase).toBe(
			"ready",
		),
	);
}

/** The dialog left its radio lifetime: it closed and said why. */
async function closedWithNotice() {
	await waitFor(() =>
		expect(screen.queryByTestId("hotspot-status")).toBeNull(),
	);
	expect(warning).toHaveBeenCalledWith(
		"The radio you chose changed or was disconnected. Choose the hotspot radio again.",
	);
}

async function editAndAcknowledge() {
	await fireEvent.input(input("hotspot-confirm-name"), {
		target: { value: "typed-name" },
	});
	await fireEvent.input(input("hotspot-confirm-password"), {
		target: { value: "typed-password" },
	});
	await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
}

beforeAll(() => {
	window.matchMedia ??= vi.fn().mockImplementation((query: string) => ({
		matches: true,
		media: query,
		onchange: null,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}));
});
beforeEach(() => {
	vi.resetAllMocks();
	resetState();
	initAsyncOperations();
	initSubscriptions();
	noteLinkState("disconnected");
	noteLinkState("connected");
	prepare.mockImplementation(async (request) => ({
		success: true,
		name: request.name ?? `${request.incarnation}-stored`,
		password: request.password ?? "stored-password",
	}));
	start.mockResolvedValue({ success: true });
	configure.mockResolvedValue({ success: true });
	vi.mocked(rpc.wifi.hotspotStop).mockResolvedValue({
		success: true,
	});
	mode.mockResolvedValue({ success: true, accepted: true });
});
afterEach(() => {
	cleanup();
	destroyAsyncOperations();
	resetState();
});

describe("hotspot draft ownership through the real dialog", () => {
	function cacheHybrid() {
		setWifiAdapterModesForTest({
			"0": {
				mode: "hybrid",
				options: [
					{ mode: "station", available: true },
					{ mode: "hotspot", available: true },
					{ mode: "hybrid", available: true },
				],
			},
		});
	}

	it("releases the inline consent slot when the same radio loses its uplink", async () => {
		cacheHybrid();
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		const option = screen.getByRole("radio", { name: "Share as hotspot" });
		await fireEvent.click(option);
		expect(screen.getByTestId("wifi-mode-confirm-0").dataset.consequence).toBe(
			"drops-uplink",
		);
		const enable = screen.getByRole<HTMLButtonElement>("button", {
			name: "Turn on hotspot",
		});
		expect(enable.disabled).toBe(true);

		await view.rerender({
			open: true,
			deviceId: "0",
			iface: { ...row(), conn: "" },
		});
		expect(screen.queryByTestId("wifi-mode-confirm-0")).toBeNull();
		expect(enable.disabled).toBe(false);
		await view.rerender({ open: true, deviceId: "0", iface: row() });
		expect(screen.queryByTestId("wifi-mode-confirm-0")).toBeNull();
		expect(enable.disabled).toBe(false);
		await gate();
		expect(mode).not.toHaveBeenCalled();
	});

	it("moves focus to the mode option when a focused inline confirmation expires", async () => {
		cacheHybrid();
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		const option = screen.getByRole("radio", { name: "Share as hotspot" });
		await fireEvent.click(option);
		const confirm = screen.getByTestId("wifi-mode-confirm-apply-0");
		confirm.focus();
		expect(document.activeElement).toBe(confirm);
		await view.rerender({
			open: true,
			deviceId: "0",
			iface: { ...row(), conn: "" },
		});
		expect(screen.queryByTestId("wifi-mode-confirm-0")).toBeNull();
		expect(document.activeElement).toBe(option);
	});

	it("closes instead of restoring a mode credential gate after the adapter row disappears", async () => {
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		await fireEvent.click(screen.getByRole("radio", { name: "Both" }));
		await ready();
		await view.rerender({ open: true, deviceId: "0", iface: undefined });
		await closedWithNotice();
		expect(screen.queryByTestId("hotspot-activation-confirm")).toBeNull();
		await view.rerender({ open: true, deviceId: "0", iface: row("radio-B") });
		expect(screen.queryByTestId("hotspot-activation-confirm")).toBeNull();
		expect(
			screen.getByRole<HTMLButtonElement>("button", { name: "Turn on hotspot" })
				.disabled,
		).toBe(false);
		expect(mode).not.toHaveBeenCalled();
	});

	for (const [currentMode, attemptedMode] of [
		["station", "Share as hotspot"],
		["hybrid", "Share as hotspot"],
		["station", "Both"],
	] as const) {
		it(`blocks AP mode selection in ${currentMode} while the Start gate owns consent (${attemptedMode})`, async () => {
			if (currentMode === "hybrid") cacheHybrid();
			render(HotspotDialog, { open: true, deviceId: "0", iface: row() });
			await gate();
			const startGate = screen.getByTestId("hotspot-activation-confirm");
			await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
			const option = screen.getByRole<HTMLButtonElement>("radio", {
				name: attemptedMode,
			});
			expect(option.disabled).toBe(true);
			await fireEvent.click(option);
			expect(screen.getAllByTestId("hotspot-activation-confirm")).toEqual([
				startGate,
			]);
			expect(screen.queryByTestId("wifi-mode-confirm-0")).toBeNull();
			expect(
				screen.getByTestId("hotspot-confirm-ack").getAttribute("aria-checked"),
			).toBe("true");
			expect(mode).not.toHaveBeenCalled();
			expect(start).not.toHaveBeenCalled();
		});
	}

	it("labels each credential confirmation instance's own controls for the same device", async () => {
		const props = {
			device: "0",
			incarnation: "radio-A",
			onConfirm: vi.fn(),
			onCancel: vi.fn(),
		};
		render(HotspotActivationConfirm, props);
		render(HotspotActivationConfirm, props);
		await waitFor(() =>
			expect(screen.getAllByTestId("hotspot-confirm-password")).toHaveLength(2),
		);
		const ids = new Set<string>();
		for (const gate of screen.getAllByTestId("hotspot-activation-confirm")) {
			const titleId = gate.getAttribute("aria-labelledby") ?? "";
			expect(gate.contains(document.getElementById(titleId))).toBe(true);
			ids.add(titleId);
			for (const control of gate.querySelectorAll<HTMLElement>(
				"input, [role=checkbox]",
			)) {
				const label = gate.querySelector<HTMLLabelElement>(
					`label[for="${control.id}"]`,
				);
				expect(label?.control).toBe(control);
				ids.add(control.id);
			}
		}
		expect(ids.size).toBe(8);
	});

	it("closes on a rotated radio and still reports its own failed Start reply", async () => {
		const reply = deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotStart>>>();
		start.mockReturnValueOnce(reply.promise);
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		await gate();
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
		const attempt = start.mock.calls[0]?.[0].attempt;
		await view.rerender({ open: true, deviceId: "0", iface: row("radio-B") });
		// The dialog never follows the new lifetime; its own Start's outcome
		// still reaches the operator, as a notice.
		await closedWithNotice();
		const reason = "deactivation-failed";
		wire.message("wifi", {
			hotspot: {
				start: { device: 0, attempt, error: "radio-changed", reason },
			},
		});
		reply.resolve({ success: false, error: "radio-changed", reason });
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				expect.stringContaining("mode is unknown"),
			),
		);
		expect(screen.queryByTestId("hotspot-activation-confirm")).toBeNull();
	});

	it.each(["before", "after"] as const)(
		"reports its own deferred Start refusal %s the acknowledgement after closing and ignores foreign frames",
		async (timing) => {
			const ack = deferred<{ success: true; accepted: true }>();
			start.mockReturnValueOnce(ack.promise);
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row(),
			});
			await gate();
			await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
			await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
			await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
			const attempt = start.mock.calls[0]?.[0].attempt;
			expect(attempt).toMatch(
				/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
			);
			const refusal = (device: number, attempt?: string) =>
				wire.message("wifi", {
					hotspot: { start: { device, attempt, error: "radio-changed" } },
				});
			refusal(0, crypto.randomUUID());
			refusal(1, attempt);
			refusal(0);
			await tick();
			expect(screen.queryByTestId("hotspot-start-refused")).toBeNull();

			await view.rerender({ open: true, deviceId: "0", iface: row("radio-B") });
			await closedWithNotice();
			if (timing === "after") {
				ack.resolve({ success: true, accepted: true });
				await tick();
			}
			refusal(0, attempt);
			if (timing === "before") ack.resolve({ success: true, accepted: true });
			await waitFor(() =>
				expect(toast.error).toHaveBeenCalledWith(
					expect.stringMatching(/adapter changed.*wasn't turned on/),
				),
			);
			expect(start).toHaveBeenCalledTimes(1);
		},
	);

	it("an older backend can confirm an accepted Start by status alone", async () => {
		start.mockResolvedValueOnce({ success: true, accepted: true });
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		await gate();
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
		await view.rerender({
			open: true,
			deviceId: "0",
			iface: row("radio-A", true),
		});
		await waitFor(() =>
			expect(getOperationPhase(wifiHotspotOpKey("0", "radio-A"))).toBe(
				"confirmed",
			),
		);
	});

	it("does not claim the hotspot is off when cleanup of its accepted Start failed", async () => {
		start.mockResolvedValueOnce({ success: true, accepted: true });
		render(HotspotDialog, { open: true, deviceId: "0", iface: row() });
		await gate();
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
		wire.message("wifi", {
			hotspot: {
				start: {
					device: 0,
					attempt: start.mock.calls[0]?.[0].attempt,
					error: "radio-changed",
					reason: "deactivation-failed",
				},
			},
		});
		await waitFor(() =>
			expect(screen.getByTestId("hotspot-start-refused").textContent).toContain(
				"mode is unknown",
			),
		);
		expect(screen.queryByTestId("hotspot-activation-confirm")).toBeNull();
	});

	it("a current-unobserved refusal recovers without closing the gate when the next status frame keeps the token", async () => {
		prepare.mockResolvedValueOnce(unobserved);
		render(HotspotDialog, { open: true, deviceId: "0", iface: row() });
		await fireEvent.click(
			screen.getByRole("button", { name: "Turn on hotspot" }),
		);
		await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
		await tick();
		const gateElement = screen.getByTestId("hotspot-activation-confirm");
		expect(gateElement.dataset.phase).toBe("loading");
		wire.message("status", { wifi: { "0": row() } });
		await ready();
		expect(screen.getByTestId("hotspot-activation-confirm")).toBe(gateElement);
		expect(prepare).toHaveBeenCalledTimes(2);
		expect(prepare).toHaveBeenLastCalledWith({
			device: "0",
			incarnation: "radio-A",
		});
		// The same lifetime was retried: nothing changed, so no changed-radio notice.
		expect(screen.queryByTestId("hotspot-confirm-radio-changed")).toBeNull();
		expect(
			screen.getByTestId("hotspot-confirm-activate").hasAttribute("disabled"),
		).toBe(true);
	});

	it("never resends a current-unobserved load under another token and closes the dialog", async () => {
		prepare.mockResolvedValueOnce(unobserved);
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Turn on hotspot" }),
		);
		await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
		await tick();
		wire.message("status", { wifi: { "0": row("radio-B") } });
		await view.rerender({ open: true, deviceId: "0", iface: row("radio-B") });
		await closedWithNotice();
		await tick();
		expect(prepare).toHaveBeenCalledTimes(1);
	});

	it("a second refusal after an unchanged status token still shows the reloaded-details copy", async () => {
		prepare.mockResolvedValueOnce(unobserved);
		prepare.mockResolvedValueOnce(changed);
		render(HotspotDialog, { open: true, deviceId: "0", iface: row() });
		await fireEvent.click(
			screen.getByRole("button", { name: "Turn on hotspot" }),
		);
		await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
		await tick();
		wire.message("status", { wifi: { "0": row() } });
		await waitFor(() =>
			expect(
				screen.getByTestId("hotspot-activation-confirm").dataset.phase,
			).toBe("load-failed"),
		);
		expect(
			screen.getByTestId("hotspot-confirm-radio-changed").textContent,
		).toContain("reloaded");
		expect(prepare).toHaveBeenCalledTimes(2);
	});

	for (const token of ["radio-A"]) {
		it(`retries a current-unobserved Start once with the same next frame token ${token}`, async () => {
			start.mockResolvedValueOnce(unobserved);
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row(),
			});
			await gate();
			await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
			await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
			await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
			await tick();
			expect(getOperationPhase(wifiHotspotOpKey("0", "radio-A"))).toBe(
				"pending",
			);
			wire.message("status", { wifi: { "0": row(token) } });
			await view.rerender({ open: true, deviceId: "0", iface: row(token) });
			if (token === "radio-B") {
				await ready();
				expect(start).toHaveBeenCalledTimes(1);
				expect(
					screen.getByTestId("hotspot-confirm-radio-changed"),
				).toBeTruthy();
				expect(
					screen
						.getByTestId("hotspot-confirm-activate")
						.hasAttribute("disabled"),
				).toBe(true);
				await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
				await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
			}
			await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
			expect(start).toHaveBeenLastCalledWith({
				device: "0",
				incarnation: token,
				attempt: expect.stringMatching(
					/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
				),
			});
		});
	}

	it("never resends a current-unobserved Start under another token and closes the dialog", async () => {
		start.mockResolvedValueOnce(unobserved);
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		await gate();
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
		await tick();
		wire.message("status", { wifi: { "0": row("radio-B") } });
		await view.rerender({ open: true, deviceId: "0", iface: row("radio-B") });
		await closedWithNotice();
		await tick();
		expect(start).toHaveBeenCalledTimes(1);
		expect(getOperationPhase(wifiHotspotOpKey("0", "radio-B"))).toBe("idle");
	});

	it("retries a current-unobserved Configure once and reloads details after its second refusal", async () => {
		configure.mockResolvedValueOnce(unobserved);
		configure.mockResolvedValueOnce({ success: false, error: "radio-changed" });
		render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row("radio-A", true),
		});
		await fireEvent.input(input("hotspot-name"), {
			target: { value: "pending-draft" },
		});
		await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		wire.message("wifi", {
			hotspot: {
				config: {
					device: "0",
					incarnation: "radio-A",
					error: "radio-changed",
					reason: "current-unobserved",
				},
			},
		});
		await tick();
		expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-A"))).toBe(
			"pending",
		);
		wire.message("status", { wifi: { "0": row("radio-A", true) } });
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(screen.getByTestId("hotspot-editor-radio-changed")).toBeTruthy(),
		);
		expect(input("hotspot-name").value).toBe("radio-A-stored");
		expect(configure).toHaveBeenLastCalledWith({
			device: "0",
			incarnation: "radio-A",
			name: "pending-draft",
			password: "stored-password",
			channel: "auto",
			security: "wpa2",
		});
	});

	it("closes on a replacement radio after a refused Save and never replays it", async () => {
		const reply =
			deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotConfigure>>>();
		configure.mockReturnValueOnce(reply.promise);
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row("radio-A", true),
		});
		await fireEvent.input(input("hotspot-name"), {
			target: { value: "radio-A-draft" },
		});
		await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		// The writer's refusal can precede the dispatch acknowledgement.
		wire.message("wifi", {
			hotspot: {
				config: { device: "0", incarnation: "radio-A", ...unobserved },
			},
		});
		wire.message("status", { wifi: { "0": row("radio-B", true) } });
		await view.rerender({
			open: true,
			deviceId: "0",
			iface: row("radio-B", true),
		});
		await closedWithNotice();
		reply.resolve({ success: true });
		await new Promise<void>((resolve) => setImmediate(resolve));
		await tick();
		expect(
			configure.mock.calls.map(([request]) => request.incarnation),
		).toEqual(["radio-A"]);
		expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-B"))).toBe(
			"idle",
		);
	});

	it("closes on a replacement radio without resending the old radio's chosen pair", async () => {
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		await gate();
		await editAndAcknowledge();
		prepare.mockResolvedValueOnce(unobserved);
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
		await tick();
		wire.message("status", { wifi: { "0": row("radio-B") } });
		await view.rerender({ open: true, deviceId: "0", iface: row("radio-B") });
		await closedWithNotice();
		await new Promise<void>((resolve) => setImmediate(resolve));
		await tick();
		expect(prepare).toHaveBeenCalledTimes(2);
		expect(prepare.mock.calls.map(([request]) => request.incarnation)).toEqual([
			"radio-A",
			"radio-A",
		]);
		expect(start).not.toHaveBeenCalled();
	});

	for (const active of [false, true]) {
		it(`does not resend a current-unobserved request when the next frame has no token, and closes, active=${active}`, async () => {
			const mutation = active ? configure : start;
			mutation.mockResolvedValueOnce(unobserved);
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row("radio-A", active),
			});
			if (active) {
				await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
			} else {
				await gate();
				await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
				await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
			}
			await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
			await tick();
			const unproven = row("radio-A", active);
			delete unproven.incarnation;
			wire.message("status", { wifi: { "0": unproven } });
			await view.rerender({ open: true, deviceId: "0", iface: unproven });
			await closedWithNotice();
			await tick();
			expect(mutation).toHaveBeenCalledTimes(1);
		});
	}

	it("does not resend a waiting Start after the dialog closes", async () => {
		start.mockResolvedValueOnce(unobserved);
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		await gate();
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
		await view.rerender({ open: false, deviceId: "0", iface: row() });
		wire.message("status", { wifi: { "0": row("radio-B") } });
		await tick();
		expect(start).toHaveBeenCalledTimes(1);
	});

	it("maps an unexpected prepare refusal to the existing unverified notice", async () => {
		prepare.mockResolvedValueOnce({
			success: false,
			error: "radio-unverified",
		});
		render(HotspotDialog, { open: true, deviceId: "0", iface: row() });
		await fireEvent.click(
			screen.getByRole("button", { name: "Turn on hotspot" }),
		);
		await waitFor(() =>
			expect(
				screen.getByTestId("hotspot-activation-confirm").dataset.phase,
			).toBe("unverified"),
		);
		expect(
			screen.getByTestId("hotspot-confirm-unavailable").textContent,
		).toContain("identified");
		expect(
			screen.getByTestId("hotspot-confirm-activate").hasAttribute("disabled"),
		).toBe(true);
	});

	it("closes an open tokenless dialog when a status update brings a token, without loading", async () => {
		const tokenless = row();
		delete tokenless.incarnation;
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: tokenless,
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Turn on hotspot" }),
		);
		expect(screen.getByTestId("hotspot-confirm-unavailable")).toBeTruthy();
		await view.rerender({ open: true, deviceId: "0", iface: row() });
		await closedWithNotice();
		expect(prepare).toHaveBeenCalledTimes(0);
	});

	for (const patch of [
		{ ifname: "renamed0" },
		{ scanGeneration: 9 },
		{
			available: [
				{ active: true, ssid: "Home", signal: 8, security: "WPA2", freq: 2412 },
			],
		},
	]) {
		it(`preserves the typed gate pair and acknowledgement on ${Object.keys(patch)[0]} status patches`, async () => {
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row(),
			});
			await gate();
			await editAndAcknowledge();
			await view.rerender({
				open: true,
				deviceId: "0",
				iface: { ...row(), ...patch },
			});
			expect(input("hotspot-confirm-name").value).toBe("typed-name");
			expect(input("hotspot-confirm-password").value).toBe("typed-password");
			expect(
				screen.getByTestId("hotspot-confirm-ack").getAttribute("aria-checked"),
			).toBe("true");
			expect(prepare).toHaveBeenCalledTimes(1);
			await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
			await waitFor(() =>
				expect(start).toHaveBeenCalledWith({
					device: "0",
					incarnation: "radio-A",
					attempt: expect.stringMatching(
						/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
					),
				}),
			);
			expect(prepare).toHaveBeenLastCalledWith({
				device: "0",
				incarnation: "radio-A",
				name: "typed-name",
				password: "typed-password",
			});
		});
	}

	for (const change of ["link", "session"] as const) {
		it(`reloads the gate and withdraws consent after a ${change} change`, async () => {
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row(),
			});
			await gate();
			await editAndAcknowledge();
			if (change === "link") {
				noteLinkState("disconnected");
				await tick();
			} else {
				await view.rerender({ open: false, deviceId: "0", iface: row() });
				await view.rerender({ open: true, deviceId: "0", iface: row() });
				await gate();
			}
			await ready();
			expect(
				screen.queryByTestId("hotspot-confirm-radio-changed"),
			).toBeTruthy();
			expect(input("hotspot-confirm-name").value).toBe("radio-A-stored");
			expect(
				screen.getByTestId("hotspot-confirm-ack").getAttribute("aria-checked"),
			).toBe("false");
			expect(
				screen.getByTestId("hotspot-confirm-activate").hasAttribute("disabled"),
			).toBe(true);
			expect(start).toHaveBeenCalledTimes(0);
		});

		it(`ignores a saved pair returned after a ${change} invalidation`, async () => {
			const pending =
				deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotPrepare>>>();
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row(),
			});
			await gate();
			await editAndAcknowledge();
			prepare.mockReturnValueOnce(pending.promise);
			await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
			if (change === "link") {
				noteLinkState("disconnected");
				await tick();
			} else {
				await view.rerender({ open: false, deviceId: "0", iface: row() });
				await view.rerender({ open: true, deviceId: "0", iface: row() });
				await gate();
			}
			await ready();
			pending.resolve({
				success: true,
				name: "typed-name",
				password: "typed-password",
			});
			await tick();
			expect(start).toHaveBeenCalledTimes(0);
			expect(input("hotspot-confirm-name").value).toBe("radio-A-stored");
			expect(
				screen.getByTestId("hotspot-confirm-ack").getAttribute("aria-checked"),
			).toBe("false");
		});
	}

	for (const change of ["token", "device"] as const) {
		it(`closes with a notice and starts nothing after a ${change} change`, async () => {
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row(),
			});
			await gate();
			await editAndAcknowledge();
			await view.rerender({
				open: true,
				deviceId: change === "device" ? "1" : "0",
				iface: row(change === "token" ? "radio-B" : "radio-A"),
			});
			await closedWithNotice();
			expect(prepare).toHaveBeenCalledTimes(1);
			expect(start).toHaveBeenCalledTimes(0);
		});

		it(`ignores a saved pair returned after a ${change} change closed the dialog`, async () => {
			const pending =
				deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotPrepare>>>();
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row(),
			});
			await gate();
			await editAndAcknowledge();
			prepare.mockReturnValueOnce(pending.promise);
			await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
			await view.rerender({
				open: true,
				deviceId: change === "device" ? "1" : "0",
				iface: row(change === "token" ? "radio-B" : "radio-A"),
			});
			await closedWithNotice();
			pending.resolve({
				success: true,
				name: "typed-name",
				password: "typed-password",
			});
			await tick();
			expect(start).toHaveBeenCalledTimes(0);
		});
	}

	it("does not resurrect the first A load after A to B to A", async () => {
		const old = deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotPrepare>>>();
		prepare.mockReturnValueOnce(old.promise);
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Turn on hotspot" }),
		);
		await view.rerender({ open: true, deviceId: "1", iface: row("radio-B") });
		await closedWithNotice();
		await view.rerender({ open: true, deviceId: "0", iface: row() });
		old.resolve({
			success: true,
			name: "obsolete-A",
			password: "obsolete-password",
		});
		await tick();
		// Reopened fresh: no gate until the operator asks again.
		expect(screen.queryByTestId("hotspot-activation-confirm")).toBeNull();
		await gate();
		expect(input("hotspot-confirm-name").value).toBe("radio-A-stored");
		expect(
			screen.getByTestId("hotspot-confirm-ack").getAttribute("aria-checked"),
		).toBe("false");
	});

	it("does not dispatch start when A's saved draft returns after A to B to A", async () => {
		const old = deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotPrepare>>>();
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		await gate();
		await editAndAcknowledge();
		prepare.mockReturnValueOnce(old.promise);
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await view.rerender({ open: true, deviceId: "1", iface: row("radio-B") });
		await closedWithNotice();
		await view.rerender({ open: true, deviceId: "0", iface: row() });
		old.resolve({
			success: true,
			name: "typed-name",
			password: "typed-password",
		});
		await tick();
		expect(start).toHaveBeenCalledTimes(0);
		expect(screen.queryByTestId("hotspot-activation-confirm")).toBeNull();
	});

	it("closes a saving gate when its token disappears", async () => {
		const old = deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotPrepare>>>();
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		await gate();
		await editAndAcknowledge();
		prepare.mockReturnValueOnce(old.promise);
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		const unproven = row();
		delete unproven.incarnation;
		await view.rerender({ open: true, deviceId: "0", iface: unproven });
		await closedWithNotice();
		old.resolve({
			success: true,
			name: "typed-name",
			password: "typed-password",
		});
		await tick();
		expect(start).toHaveBeenCalledTimes(0);
	});

	it("reopens the current gate with fresh consent on an optional start refusal", async () => {
		start.mockResolvedValueOnce(
			JSON.parse('{"success":false,"error":"radio-changed"}'),
		);
		render(HotspotDialog, { open: true, deviceId: "0", iface: row() });
		await gate();
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await ready();
		expect(
			screen.getByTestId("hotspot-confirm-ack").getAttribute("aria-checked"),
		).toBe("false");
		expect(prepare).toHaveBeenCalledTimes(2);
	});

	for (const change of ["token", "device", "link"] as const) {
		it(`ignores a late start refusal after a ${change} change`, async () => {
			const old = deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotStart>>>();
			start.mockReturnValueOnce(old.promise);
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row(),
			});
			await gate();
			await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
			await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
			if (change === "link") {
				noteLinkState("disconnected");
				await tick();
			}
			await view.rerender({
				open: true,
				deviceId: change === "device" ? "1" : "0",
				iface: row(change === "token" ? "radio-B" : "radio-A"),
			});
			old.resolve(JSON.parse('{"success":false,"error":"radio-changed"}'));
			await tick();
			expect(screen.queryByTestId("hotspot-activation-confirm")).toBeNull();
			expect(getOperationPhase(wifiHotspotOpKey("0", "radio-A"))).toBe(
				"pending",
			);
		});
	}

	it("ignores an old start refusal after the owner session is replaced", async () => {
		const old = deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotStart>>>();
		start.mockReturnValueOnce(old.promise);
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		await gate();
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await view.rerender({ open: false, deviceId: "0", iface: row() });
		await view.rerender({ open: true, deviceId: "0", iface: row() });
		// Unknown future refusal tokens arrive at the JSON boundary.
		old.resolve(JSON.parse('{"success":false,"error":"radio-changed"}'));
		await tick();
		expect(screen.queryByTestId("hotspot-activation-confirm")).toBeNull();
		expect(getOperationPhase(wifiHotspotOpKey("0", "radio-A"))).toBe("pending");
	});

	for (const reason of [undefined, "permanent-mac-unresolved"] as const) {
		it(`withholds guarded actions without lifetime proof (${reason ?? "tokenless"})`, async () => {
			const iface = row();
			delete iface.incarnation;
			iface.degraded_reason = reason;
			render(HotspotDialog, { open: true, deviceId: "0", iface });
			if (reason === "permanent-mac-unresolved") {
				const notice = await screen.findByTestId("hotspot-editor-unavailable");
				expect(notice.textContent).toContain("identified");
				expect(
					screen.queryByRole("button", { name: "Turn on hotspot" }),
				).toBeNull();
				expect(screen.queryByTestId("hotspot-confirm-activate")).toBeNull();
			} else {
				await fireEvent.click(
					screen.getByRole("button", { name: "Turn on hotspot" }),
				);
				expect(
					screen.getByTestId("hotspot-confirm-unavailable").textContent,
				).toContain(reason ? "identified" : "update the device software");
				expect(
					screen
						.getByTestId("hotspot-confirm-activate")
						.hasAttribute("disabled"),
				).toBe(true);
			}
			expect(prepare).toHaveBeenCalledTimes(0);
		});
	}
});

describe("live editor binding and safe Stop", () => {
	it("closes when a live tokenless AP replaces an open gate", async () => {
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		await gate();
		await editAndAcknowledge();
		const active = row("radio-A", true);
		delete active.incarnation;
		await view.rerender({ open: true, deviceId: "0", iface: active });
		await closedWithNotice();
		expect(start).toHaveBeenCalledTimes(0);
	});
	it("keeps Stop available on an otherwise healthy tokenless live AP", async () => {
		const iface = row("radio-A", true);
		delete iface.incarnation;
		render(HotspotDialog, { open: true, deviceId: "0", iface });
		expect(input("hotspot-name").value).toBe("radio-A-stored");
		expect(input("hotspot-name").readOnly).toBe(true);
		await fireEvent.click(screen.getByRole("button", { name: "Turn Off" }));
		expect(rpc.wifi.hotspotStop).toHaveBeenCalledWith({ device: "0" });
	});
	it("preserves edits on a same-token replacement object", async () => {
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row("radio-A", true),
		});
		await fireEvent.input(input("hotspot-name"), {
			target: { value: "live-draft" },
		});
		await fireEvent.input(input("hotspot-password"), {
			target: { value: "live-password" },
		});
		await view.rerender({
			open: true,
			deviceId: "0",
			iface: { ...row("radio-A", true), ifname: "renamed" },
		});
		expect(input("hotspot-name").value).toBe("live-draft");
		expect(input("hotspot-password").value).toBe("live-password");
		await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
		expect(configure).toHaveBeenCalledWith({
			device: "0",
			incarnation: "radio-A",
			name: "live-draft",
			password: "live-password",
			channel: "auto",
			security: "wpa2",
		});
		expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-A"))).toBe(
			"pending",
		);
	});

	for (const change of ["link", "session"] as const) {
		it(`reloads the live editor after a ${change} change and ignores its old save`, async () => {
			const old =
				deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotConfigure>>>();
			configure.mockReturnValueOnce(old.promise);
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row("radio-A", true),
			});
			await fireEvent.input(input("hotspot-name"), {
				target: { value: "live-draft" },
			});
			await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
			if (change === "link") {
				noteLinkState("disconnected");
				await tick();
			} else {
				await view.rerender({
					open: false,
					deviceId: "0",
					iface: row("radio-A", true),
				});
			}
			await view.rerender({
				open: true,
				deviceId: "0",
				iface: row("radio-A", true),
			});
			old.resolve({ success: false, error: "saving" });
			await tick();
			expect(input("hotspot-name").value).toBe("radio-A-stored");
			expect(screen.getByTestId("hotspot-editor-radio-changed")).toBeTruthy();
			expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-A"))).toBe(
				"pending",
			);
		});
	}

	for (const change of ["token", "device"] as const) {
		it(`closes the live editor after a ${change} change and ignores its old save`, async () => {
			const old =
				deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotConfigure>>>();
			configure.mockReturnValueOnce(old.promise);
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row("radio-A", true),
			});
			await fireEvent.input(input("hotspot-name"), {
				target: { value: "live-draft" },
			});
			await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
			await view.rerender({
				open: true,
				deviceId: change === "device" ? "1" : "0",
				iface: row(change === "token" ? "radio-B" : "radio-A", true),
			});
			await closedWithNotice();
			old.resolve({ success: false, error: "saving" });
			await tick();
			expect(configure).toHaveBeenCalledTimes(1);
			expect(toast.error).not.toHaveBeenCalled();
			expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-A"))).toBe(
				"pending",
			);
		});
	}

	for (const token of [undefined, "radio-A"]) {
		it(`keeps read-only credentials and Stop available for ${token ?? "tokenless"} degraded rows`, async () => {
			const iface = row(token, true);
			delete iface.incarnation;
			if (token) iface.incarnation = token;
			iface.degraded_reason = "unavailable";
			render(HotspotDialog, { open: true, deviceId: "0", iface });
			expect(input("hotspot-name").readOnly).toBe(true);
			expect(
				screen.getByRole("button", { name: /^Save$/ }).hasAttribute("disabled"),
			).toBe(true);
			await fireEvent.click(screen.getByRole("button", { name: "Turn Off" }));
			expect(rpc.wifi.hotspotStop).toHaveBeenCalledWith({
				device: "0",
				...(token ? { incarnation: token } : {}),
			});
		});
	}
});

describe("mode owner and echoed settlement use the dispatched lifetime", () => {
	for (const token of ["radio-A", "radio-B"]) {
		it(`recovers a mode refusal with the same binding or fresh consent (${token})`, async () => {
			mode.mockResolvedValueOnce(unobserved);
			const modeView = (incarnation: string) =>
				deriveWifiAdapterModeView({
					device: "0",
					iface: row(incarnation),
					phase: "idle",
				});
			wire.message("status", { wifi: { "0": row() } });
			const view = render(WifiModeSelector, {
				props: {
					view: modeView("radio-A"),
					context: { stationLinkLive: true, hotspotLive: false },
				},
			});
			await fireEvent.click(screen.getByRole("radio", { name: "Hybrid" }));
			await ready();
			await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
			await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
			await waitFor(() => expect(mode).toHaveBeenCalledTimes(1));
			wire.message("wifi", {
				adapter_mode: {
					device: "0",
					incarnation: "radio-A",
					error: "radio-changed",
					reason: "current-unobserved",
				},
			});
			await tick();
			expect(getOperationPhase(wifiModeOpKey("0", "radio-A"))).toBe("pending");
			wire.message("status", { wifi: { "0": row(token) } });
			await view.rerender({
				view: modeView(token),
				context: { stationLinkLive: true, hotspotLive: false },
			});
			if (token === "radio-B") {
				await ready();
				expect(mode).toHaveBeenCalledTimes(1);
				expect(
					screen.getByTestId("hotspot-confirm-radio-changed"),
				).toBeTruthy();
				expect(
					screen
						.getByTestId("hotspot-confirm-activate")
						.hasAttribute("disabled"),
				).toBe(true);
				await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
				await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
			}
			await waitFor(() => expect(mode).toHaveBeenCalledTimes(2));
			expect(mode).toHaveBeenLastCalledWith({
				device: "0",
				mode: "hybrid",
				incarnation: token,
			});
		});
	}

	it("never resends a current-unobserved gate load under another token", async () => {
		prepare.mockResolvedValueOnce(unobserved);
		const modeView = (incarnation: string) =>
			deriveWifiAdapterModeView({
				device: "0",
				iface: row(incarnation),
				phase: "idle",
			});
		const view = render(WifiModeSelector, {
			props: {
				view: modeView("radio-A"),
				context: { stationLinkLive: true, hotspotLive: false },
			},
		});
		await fireEvent.click(screen.getByRole("radio", { name: "Hybrid" }));
		await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
		await tick();
		wire.message("status", { wifi: { "0": row("radio-B") } });
		await view.rerender({
			view: modeView("radio-B"),
			context: { stationLinkLive: true, hotspotLive: false },
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		await tick();
		// The refused radio-A load is never replayed under the new token. The
		// gate may at most load the new radio fresh, with a fresh
		// acknowledgement (#675).
		const calls = prepare.mock.calls.map(([request]) => request);
		expect(calls[0]).toEqual({ device: "0", incarnation: "radio-A" });
		for (const request of calls.slice(1))
			expect(request).toEqual({ device: "0", incarnation: "radio-B" });
		expect(
			screen
				.queryByTestId("hotspot-confirm-ack")
				?.getAttribute("aria-checked") ?? "false",
		).toBe("false");
		expect(mode).not.toHaveBeenCalled();
	});

	it("never resends a current-unobserved mode change under another token", async () => {
		mode.mockResolvedValueOnce(unobserved);
		const modeView = (incarnation: string) =>
			deriveWifiAdapterModeView({
				device: "0",
				iface: row(incarnation),
				phase: "idle",
			});
		wire.message("status", { wifi: { "0": row() } });
		const view = render(WifiModeSelector, {
			props: {
				view: modeView("radio-A"),
				context: { stationLinkLive: true, hotspotLive: false },
			},
		});
		await fireEvent.click(screen.getByRole("radio", { name: "Hybrid" }));
		await ready();
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await waitFor(() => expect(mode).toHaveBeenCalledTimes(1));
		await tick();
		wire.message("status", { wifi: { "0": row("radio-B") } });
		await view.rerender({
			view: modeView("radio-B"),
			context: { stationLinkLive: true, hotspotLive: false },
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		await tick();
		expect(mode).toHaveBeenCalledTimes(1);
		expect(getOperationPhase(wifiModeOpKey("0", "radio-B"))).toBe("idle");
	});

	for (const change of ["token", "device", "link", "session"] as const) {
		it(`ignores an old mode refusal after a ${change} change`, async () => {
			const old =
				deferred<Awaited<ReturnType<typeof rpc.wifi.setAdapterMode>>>();
			mode.mockReturnValueOnce(old.promise);
			const modeView = (token: string, device = "0") =>
				deriveWifiAdapterModeView({ device, iface: row(token), phase: "idle" });
			let view = render(WifiModeSelector, {
				props: {
					view: modeView("radio-A"),
					context: { stationLinkLive: true, hotspotLive: false },
				},
			});
			await fireEvent.click(screen.getByRole("radio", { name: "Both" }));
			await ready();
			await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
			await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
			if (change === "link") {
				noteLinkState("disconnected");
				await tick();
			}
			if (change === "session") {
				view.unmount();
				view = render(WifiModeSelector, {
					props: {
						view: modeView("radio-A"),
						context: { stationLinkLive: true, hotspotLive: false },
					},
				});
			} else {
				await view.rerender({
					view: modeView(
						change === "token" ? "radio-B" : "radio-A",
						change === "device" ? "1" : "0",
					),
					context: { stationLinkLive: true, hotspotLive: false },
				});
			}
			old.resolve(JSON.parse('{"success":false,"error":"radio-changed"}'));
			await tick();
			expect(screen.queryByTestId("hotspot-activation-confirm")).toBeNull();
			expect(getOperationPhase(wifiModeOpKey("0", "radio-A"))).toBe("pending");
		});
	}
	it("ignores an old mode response after A to B to A", async () => {
		const old = deferred<Awaited<ReturnType<typeof rpc.wifi.setAdapterMode>>>();
		mode.mockReturnValueOnce(old.promise);
		const modeView = (token: string) =>
			deriveWifiAdapterModeView({
				device: "0",
				iface: row(token),
				phase: "idle",
			});
		const view = render(WifiModeSelector, {
			props: {
				view: modeView("radio-A"),
				context: { stationLinkLive: true, hotspotLive: false },
			},
		});
		await fireEvent.click(screen.getByRole("radio", { name: "Both" }));
		await ready();
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		expect(mode).toHaveBeenCalledWith({
			device: "0",
			mode: "hybrid",
			incarnation: "radio-A",
		});
		await view.rerender({
			view: modeView("radio-B"),
			context: { stationLinkLive: true, hotspotLive: false },
		});
		await view.rerender({
			view: modeView("radio-A"),
			context: { stationLinkLive: true, hotspotLive: false },
		});
		old.resolve(JSON.parse('{"success":false,"error":"radio-changed"}'));
		await tick();
		expect(screen.queryByTestId("hotspot-activation-confirm")).toBeNull();
	});

	for (const kind of ["config", "mode"] as const) {
		it(`ignores mismatched ${kind} frames and settles only the echoed dispatch key`, () => {
			wire.message("status", { wifi: { "0": row() } });
			const key = kind === "config" ? wifiHotspotConfigOpKey : wifiModeOpKey;
			beginOperation(key("0", "radio-A"), "hybrid");
			const frame = (token: string, success: boolean) =>
				kind === "config"
					? {
							hotspot: { config: { device: "0", incarnation: token, success } },
						}
					: {
							adapter_mode: {
								device: "0",
								incarnation: token,
								...(success ? { success } : { pending: true, mode: "hybrid" }),
							},
						};
			wire.message("wifi", frame("radio-B", false));
			wire.message("wifi", frame("radio-B", true));
			expect(getOperationPhase(key("0", "radio-A"))).toBe("pending");
			expect(getOperationPhase(key("0", "radio-B"))).toBe("idle");
			wire.message("wifi", frame("radio-A", true));
			expect(getOperationPhase(key("0", "radio-A"))).toBe("confirmed");
		});
	}
});

describe("operations after an unobserved-radio refusal", () => {
	const context = { stationLinkLive: true, hotspotLive: false };
	const modeView = (incarnation: string) =>
		deriveWifiAdapterModeView({
			device: "0",
			iface: row(incarnation),
			phase: "idle",
		});

	it("keeps a resent Configure pending and shows its deferred writer failure", async () => {
		configure.mockResolvedValueOnce(unobserved);
		wire.message("status", { wifi: { "0": row("radio-A", true) } });
		render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row("radio-A", true),
		});
		await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		await tick();
		wire.message("status", { wifi: { "0": row("radio-A", true) } });
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
		expect(configure).toHaveBeenLastCalledWith(
			expect.objectContaining({ incarnation: "radio-A" }),
		);
		await waitFor(() =>
			expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-A"))).toBe(
				"pending",
			),
		);
		expect(
			screen.getByRole("button", { name: /Saving/ }).hasAttribute("disabled"),
		).toBe(true);
		wire.message("wifi", {
			hotspot: {
				config: {
					device: "0",
					incarnation: "radio-A",
					success: false,
					error: "activating",
				},
			},
		});
		await tick();
		expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-A"))).toBe(
			"failed",
		);
		expect(
			screen.getByText(/couldn't be applied while the hotspot was restarting/),
		).toBeTruthy();
	});

	it("never resends a Configure under another token and closes the dialog", async () => {
		configure.mockResolvedValueOnce(unobserved);
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row("radio-A", true),
		});
		await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		await tick();
		wire.message("status", { wifi: { "0": row("radio-B", true) } });
		await view.rerender({
			open: true,
			deviceId: "0",
			iface: row("radio-B", true),
		});
		await closedWithNotice();
		await tick();
		expect(configure).toHaveBeenCalledTimes(1);
		expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-B"))).toBe(
			"idle",
		);
	});

	for (const outcome of ["confirmed", "failed"] as const) {
		it(`settles a resent Start under its own token (${outcome})`, async () => {
			start.mockResolvedValueOnce(unobserved);
			start.mockResolvedValueOnce(
				outcome === "confirmed"
					? { success: true, accepted: true }
					: { success: false, error: "activation-failed" },
			);
			render(HotspotDialog, { open: true, deviceId: "0", iface: row() });
			await gate();
			await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
			await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
			await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
			await tick();
			wire.message("status", { wifi: { "0": row() } });
			await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
			expect(start).toHaveBeenLastCalledWith({
				device: "0",
				incarnation: "radio-A",
				attempt: expect.any(String),
			});
			await waitFor(() =>
				expect(getOperationPhase(wifiHotspotOpKey("0", "radio-A"))).toBe(
					outcome === "confirmed" ? "pending" : "failed",
				),
			);
		});
	}

	it("settles a resent mode change from its echoed terminal frame", async () => {
		mode.mockResolvedValueOnce(unobserved);
		wire.message("status", { wifi: { "0": row() } });
		render(WifiModeSelector, {
			props: { view: modeView("radio-A"), context },
		});
		await fireEvent.click(screen.getByRole("radio", { name: "Hybrid" }));
		await ready();
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await waitFor(() => expect(mode).toHaveBeenCalledTimes(1));
		await tick();
		wire.message("status", { wifi: { "0": row() } });
		await waitFor(() => expect(mode).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(getOperationPhase(wifiModeOpKey("0", "radio-A"))).toBe("pending"),
		);
		wire.message("wifi", {
			adapter_mode: {
				device: "0",
				incarnation: "radio-A",
				error: "activation-failed",
			},
		});
		await tick();
		expect(getOperationPhase(wifiModeOpKey("0", "radio-A"))).toBe("failed");
	});

	it("settles a freshly confirmed mode change from its echoed terminal frame", async () => {
		mode.mockResolvedValueOnce(unobserved);
		wire.message("status", { wifi: { "0": row() } });
		const view = render(WifiModeSelector, {
			props: { view: modeView("radio-A"), context },
		});
		await fireEvent.click(screen.getByRole("radio", { name: "Both" }));
		await ready();
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await waitFor(() => expect(mode).toHaveBeenCalledTimes(1));
		await tick();
		wire.message("status", { wifi: { "0": row("radio-B") } });
		await view.rerender({ view: modeView("radio-B"), context });
		await ready();
		expect(mode).toHaveBeenCalledTimes(1);
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await waitFor(() => expect(mode).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(getOperationPhase(wifiModeOpKey("0", "radio-B"))).toBe("pending"),
		);
		expect(getOperationPhase(wifiModeOpKey("0", "radio-A"))).toBe("failed");
		wire.message("wifi", {
			adapter_mode: {
				device: "0",
				incarnation: "radio-B",
				error: "activation-failed",
			},
		});
		await tick();
		expect(getOperationPhase(wifiModeOpKey("0", "radio-B"))).toBe("failed");
	});

	it("leaves another client's pending mode change under a new token alone", async () => {
		mode.mockResolvedValueOnce(unobserved);
		wire.message("status", { wifi: { "0": row() } });
		const view = render(WifiModeSelector, {
			props: { view: modeView("radio-A"), context },
		});
		await fireEvent.click(screen.getByRole("radio", { name: "Hybrid" }));
		await ready();
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await waitFor(() => expect(mode).toHaveBeenCalledTimes(1));
		await tick();
		wire.message("status", { wifi: { "0": row("radio-B") } });
		wire.message("wifi", {
			adapter_mode: {
				device: "0",
				incarnation: "radio-B",
				pending: true,
				mode: "hotspot",
			},
		});
		await view.rerender({ view: modeView("radio-B"), context });
		await new Promise((resolve) => setTimeout(resolve, 20));
		await tick();
		expect(mode).toHaveBeenCalledTimes(1);
		expect(getOperationPhase(wifiModeOpKey("0", "radio-B"))).toBe("pending");
		expect(getOperationTarget(wifiModeOpKey("0", "radio-B"))).toBe("hotspot");
		wire.message("wifi", {
			adapter_mode: { device: "0", incarnation: "radio-B", success: true },
		});
		await tick();
		expect(getOperationPhase(wifiModeOpKey("0", "radio-B"))).toBe("confirmed");
	});

	it("leaves another client's pending mode change under an unchanged token its own target and settlement", async () => {
		mode.mockResolvedValueOnce(unobserved);
		mode.mockImplementationOnce(() => {
			// The device answers a resend into another client's transition with DEVICE_BUSY.
			wire.message("wifi", {
				adapter_mode: {
					device: "0",
					incarnation: "radio-A",
					error: "DEVICE_BUSY",
				},
			});
			return Promise.resolve({ success: false, error: "DEVICE_BUSY" });
		});
		wire.message("status", { wifi: { "0": row() } });
		render(WifiModeSelector, {
			props: { view: modeView("radio-A"), context },
		});
		await fireEvent.click(screen.getByRole("radio", { name: "Hybrid" }));
		await ready();
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await waitFor(() => expect(mode).toHaveBeenCalledTimes(1));
		await tick();
		wire.message("wifi", {
			adapter_mode: {
				device: "0",
				incarnation: "radio-A",
				pending: true,
				mode: "hotspot",
			},
		});
		wire.message("status", { wifi: { "0": row() } });
		// Settled either way: the retry resent, or its first refusal reopened the gate.
		await waitFor(() =>
			expect(
				mode.mock.calls.length === 2 ||
					screen.queryByTestId("hotspot-activation-confirm") !== null,
			).toBe(true),
		);
		expect(mode).toHaveBeenCalledTimes(1);
		expect(getOperationPhase(wifiModeOpKey("0", "radio-A"))).toBe("pending");
		expect(getOperationTarget(wifiModeOpKey("0", "radio-A"))).toBe("hotspot");
		await ready();
		wire.message("wifi", {
			adapter_mode: { device: "0", incarnation: "radio-A", success: true },
		});
		await tick();
		expect(getOperationPhase(wifiModeOpKey("0", "radio-A"))).toBe("confirmed");
	});

	it("shows the load failure when the same-token gate retry rejects", async () => {
		prepare.mockResolvedValueOnce(unobserved);
		prepare.mockRejectedValueOnce(new Error("connection reset"));
		render(HotspotDialog, { open: true, deviceId: "0", iface: row() });
		await fireEvent.click(
			screen.getByRole("button", { name: "Turn on hotspot" }),
		);
		await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
		await tick();
		wire.message("status", { wifi: { "0": row() } });
		await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(
				screen.getByTestId("hotspot-activation-confirm").dataset.phase,
			).toBe("load-failed"),
		);
	});

	it("shows the save failure when the same-token gate save retry rejects", async () => {
		render(HotspotDialog, { open: true, deviceId: "0", iface: row() });
		await gate();
		await editAndAcknowledge();
		prepare.mockResolvedValueOnce(unobserved);
		prepare.mockRejectedValueOnce(new Error("connection reset"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
		await tick();
		wire.message("status", { wifi: { "0": row() } });
		await waitFor(() => expect(prepare).toHaveBeenCalledTimes(3));
		await waitFor(() =>
			expect(screen.getByTestId("hotspot-confirm-save-failed")).toBeTruthy(),
		);
		expect(screen.getByTestId("hotspot-activation-confirm").dataset.phase).toBe(
			"ready",
		);
		expect(start).not.toHaveBeenCalled();
	});
});

describe("a terminal Configure settles before a same-key handoff", () => {
	for (const outcome of ["failed", "confirmed"] as const) {
		it(`keeps the delayed ${outcome} outcome visible without resending`, async () => {
			configure.mockResolvedValueOnce(unobserved);
			wire.message("status", { wifi: { "0": row("radio-A", true) } });
			render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row("radio-A", true),
			});
			const key = wifiHotspotConfigOpKey("0", "radio-A");
			const command = osCommand({
				key,
				rpc: (handoff) =>
					withWifiEntryRetry(
						{ device: "0", incarnation: "radio-A", link: 0, session: 0 },
						(incarnation) =>
							rpc.wifi.hotspotConfigure({
								device: "0",
								incarnation,
								name: "chosen-name",
								password: "chosen-password",
								channel: "auto",
							}),
						{
							signal: new AbortController().signal,
							current: () => true,
							currentToken: () => "radio-A",
							canRetry: () => handoff(key),
							onReplacement: () => {},
						},
					),
			});
			await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
			await tick();
			wire.message("wifi", {
				hotspot: {
					config: {
						device: "0",
						incarnation: "radio-A",
						...(outcome === "confirmed"
							? { success: true }
							: { error: "activating" }),
					},
				},
			});
			expect(getOperationPhase(key)).toBe(outcome);
			wire.message("status", { wifi: { "0": row("radio-A", true) } });
			await command;
			await tick();
			expect(configure).toHaveBeenCalledTimes(1);
			expect(getOperationPhase(key)).toBe(outcome);
			expect(
				screen.getByRole("button", { name: /^Save$/ }).hasAttribute("disabled"),
			).toBe(false);
			if (outcome === "failed")
				expect(
					screen.getByText(
						/couldn't be applied while the hotspot was restarting/,
					),
				).toBeTruthy();
			else
				expect(
					screen.queryByText(
						/couldn't be applied while the hotspot was restarting/,
					),
				).toBeNull();
			expect(toast.error).not.toHaveBeenCalled();
			expect(screen.queryByTestId("hotspot-editor-radio-changed")).toBeNull();
		});
	}
});

it("preserves another client's mode transition when it wins after our handoff", async () => {
	mode.mockResolvedValueOnce(unobserved);
	mode.mockImplementationOnce(() => {
		wire.message("wifi", {
			adapter_mode: {
				device: "0",
				incarnation: "radio-A",
				pending: true,
				mode: "hotspot",
			},
		});
		// Another request's entry refusal is private to its requesting socket.
		// Keep our busy RPC reply; that foreign frame cannot reach this client.
		return Promise.resolve({ success: false, error: "DEVICE_BUSY" });
	});
	wire.message("status", { wifi: { "0": row() } });
	render(WifiModeSelector, {
		props: {
			view: deriveWifiAdapterModeView({
				device: "0",
				iface: row(),
				phase: "idle",
			}),
			context: { stationLinkLive: true, hotspotLive: false },
		},
	});
	await fireEvent.click(screen.getByRole("radio", { name: "Hybrid" }));
	await ready();
	await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
	await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
	await waitFor(() => expect(mode).toHaveBeenCalledTimes(1));
	await tick();
	wire.message("status", { wifi: { "0": row() } });
	await waitFor(() => expect(mode).toHaveBeenCalledTimes(2));
	await tick();
	const key = wifiModeOpKey("0", "radio-A");
	expect(getOperationPhase(key)).toBe("pending");
	expect(getOperationTarget(key)).toBe("hotspot");
	wire.message("wifi", {
		adapter_mode: { device: "0", incarnation: "radio-A", success: true },
	});
	await tick();
	expect(getOperationPhase(key)).toBe("confirmed");
});

it("settles this client's mode attempt from its own busy frame before its RPC reply", async () => {
	const reply = deferred<Awaited<ReturnType<typeof rpc.wifi.setAdapterMode>>>();
	mode.mockReturnValueOnce(reply.promise);
	wire.message("status", { wifi: { "0": row() } });
	render(WifiModeSelector, {
		props: {
			view: deriveWifiAdapterModeView({
				device: "0",
				iface: row(),
				phase: "idle",
			}),
			context: { stationLinkLive: true, hotspotLive: false },
		},
	});
	await fireEvent.click(screen.getByRole("radio", { name: "Hybrid" }));
	await ready();
	await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
	await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
	await waitFor(() => expect(mode).toHaveBeenCalledTimes(1));
	try {
		wire.message("wifi", {
			adapter_mode: {
				device: "0",
				incarnation: "radio-A",
				error: "DEVICE_BUSY",
			},
		});
		await tick();
		expect(getOperationPhase(wifiModeOpKey("0", "radio-A"))).toBe("failed");
	} finally {
		reply.resolve({ success: false, error: "DEVICE_BUSY" });
		await tick();
	}
});

describe("deferred Configure admission feedback", () => {
	it("shows a post-ack unverified refusal while the displayed token is unchanged", async () => {
		wire.message("status", { wifi: { "0": row("radio-A", true) } });
		render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row("radio-A", true),
		});
		await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		await tick();
		wire.message("wifi", {
			hotspot: {
				config: {
					device: 0,
					incarnation: "radio-A",
					error: "radio-unverified",
				},
			},
		});
		await tick();
		expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-A"))).toBe(
			"failed",
		);
		expect(
			screen.getByText(/These settings can't be saved until/),
		).toBeTruthy();
		expect(input("hotspot-name").value).toBe("radio-A-stored");
	});

	for (const token of ["radio-A"]) {
		it(`recovers a post-ack unobserved refusal once under the same token ${token}`, async () => {
			wire.message("status", { wifi: { "0": row("radio-A", true) } });
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row("radio-A", true),
			});
			await fireEvent.input(input("hotspot-name"), {
				target: { value: "chosen-draft" },
			});
			await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
			await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
			await tick();
			wire.message("wifi", {
				hotspot: {
					config: { device: 0, incarnation: "radio-A", ...unobserved },
				},
			});
			await tick();
			expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-A"))).toBe(
				"pending",
			);
			wire.message("status", { wifi: { "0": row(token, true) } });
			await view.rerender({
				open: true,
				deviceId: "0",
				iface: row(token, true),
			});
			if (token === "radio-B") {
				await waitFor(() =>
					expect(
						getOperationPhase(wifiHotspotConfigOpKey("0", "radio-A")),
					).toBe("failed"),
				);
				expect(configure).toHaveBeenCalledTimes(1);
				expect(screen.getByTestId("hotspot-editor-radio-changed")).toBeTruthy();
				expect(input("hotspot-name").value).toBe("radio-B-stored");
				await fireEvent.input(input("hotspot-name"), {
					target: { value: "chosen-draft" },
				});
				await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
			}
			await waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
			expect(configure).toHaveBeenLastCalledWith(
				expect.objectContaining({
					name: "chosen-draft",
					incarnation: token,
				}),
			);
			wire.message("wifi", {
				hotspot: { config: { device: 0, incarnation: token, success: true } },
			});
			await tick();
			expect(getOperationPhase(wifiHotspotConfigOpKey("0", token))).toBe(
				"confirmed",
			);
		});
	}

	it("reloads the draft after a post-ack changed-radio refusal", async () => {
		wire.message("status", { wifi: { "0": row("radio-A", true) } });
		render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row("radio-A", true),
		});
		await fireEvent.input(input("hotspot-name"), {
			target: { value: "stale-draft" },
		});
		await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		await tick();
		wire.message("wifi", {
			hotspot: {
				config: { device: 0, incarnation: "radio-A", error: "radio-changed" },
			},
		});
		await waitFor(() =>
			expect(input("hotspot-name").value).toBe("radio-A-stored"),
		);
		expect(screen.getByTestId("hotspot-editor-radio-changed")).toBeTruthy();
		expect(configure).toHaveBeenCalledTimes(1);
	});

	it("does not retry a second post-ack unobserved refusal", async () => {
		wire.message("status", { wifi: { "0": row("radio-A", true) } });
		render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row("radio-A", true),
		});
		await fireEvent.input(input("hotspot-name"), {
			target: { value: "stale-draft" },
		});
		await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		await tick();
		wire.message("wifi", {
			hotspot: { config: { device: 0, incarnation: "radio-A", ...unobserved } },
		});
		await tick();
		wire.message("status", { wifi: { "0": row("radio-A", true) } });
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
		wire.message("wifi", {
			hotspot: { config: { device: 0, incarnation: "radio-A", ...unobserved } },
		});
		await waitFor(() =>
			expect(input("hotspot-name").value).toBe("radio-A-stored"),
		);
		expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-A"))).toBe(
			"failed",
		);
		wire.message("status", { wifi: { "0": row("radio-A", true) } });
		await tick();
		expect(configure).toHaveBeenCalledTimes(2);
	});

	it("retains a refusal received before the dispatch acknowledgement", async () => {
		const ack =
			deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotConfigure>>>();
		configure.mockReturnValueOnce(ack.promise);
		wire.message("status", { wifi: { "0": row("radio-A", true) } });
		render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row("radio-A", true),
		});
		await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		wire.message("wifi", {
			hotspot: { config: { device: 0, incarnation: "radio-A", ...unobserved } },
		});
		ack.resolve({ success: true });
		await tick();
		wire.message("status", { wifi: { "0": row("radio-A", true) } });
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
	});

	for (const status of ["tokenless", "absent"] as const) {
		it(`bounds post-ack recovery when the future status is ${status}`, async () => {
			wire.message("status", { wifi: { "0": row("radio-A", true) } });
			render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row("radio-A", true),
			});
			await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
			await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
			vi.useFakeTimers();
			try {
				wire.message("wifi", {
					hotspot: {
						config: { device: 0, incarnation: "radio-A", ...unobserved },
					},
				});
				await tick();
				if (status === "tokenless") {
					const tokenless = row("radio-A", true);
					delete tokenless.incarnation;
					wire.message("status", { wifi: { "0": tokenless } });
				} else {
					await vi.advanceTimersByTimeAsync(3000);
				}
				vi.useRealTimers();
				await waitFor(() =>
					expect(
						screen.getByTestId("hotspot-editor-unavailable").textContent,
					).toContain("update the device software"),
				);
				expect(configure).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		});
	}

	it("does not recover a Configure after its owner closes", async () => {
		wire.message("status", { wifi: { "0": row("radio-A", true) } });
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row("radio-A", true),
		});
		await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		await view.rerender({
			open: false,
			deviceId: "0",
			iface: row("radio-A", true),
		});
		wire.message("wifi", {
			hotspot: { config: { device: 0, incarnation: "radio-A", ...unobserved } },
		});
		wire.message("status", { wifi: { "0": row("radio-A", true) } });
		await tick();
		expect(configure).toHaveBeenCalledTimes(1);
		expect(toast.error).toHaveBeenCalledTimes(0);
	});

	it("retires an unreceived Configure terminal when its existing operation expires", async () => {
		wire.message("status", { wifi: { "0": row("radio-A", true) } });
		render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row("radio-A", true),
		});
		await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		sweepOperations(Date.now() + 16000);
		await tick();
		expect(getOperationPhase(wifiHotspotConfigOpKey("0", "radio-A"))).toBe(
			"timed_out",
		);
		wire.message("wifi", {
			hotspot: { config: { device: 0, incarnation: "radio-A", ...unobserved } },
		});
		await tick();
		wire.message("status", { wifi: { "0": row("radio-A", true) } });
		await tick();
		expect(configure).toHaveBeenCalledTimes(1);
		expect(toast.error).toHaveBeenCalledTimes(0);
	});

	it("keeps ordinary deferred writer failures on their existing settlement path", async () => {
		wire.message("status", { wifi: { "0": row("radio-A", true) } });
		render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row("radio-A", true),
		});
		await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		await tick();
		wire.message("wifi", {
			hotspot: {
				config: { device: 0, incarnation: "radio-A", error: "activating" },
			},
		});
		await tick();
		expect(
			screen.getByText(/couldn't be applied while the hotspot was restarting/),
		).toBeTruthy();
		expect(toast.error).toHaveBeenCalledTimes(0);
	});
});

describe("Configure dispatch ownership", () => {
	for (const [kind, terminal] of [
		["radio-unverified", { error: "radio-unverified" }],
		["radio-changed", { error: "radio-changed" }],
		[
			"current-unobserved",
			{ error: "radio-changed", reason: "current-unobserved" },
		],
	] as const) {
		it(`keeps a newer Save pending when the expired dispatch sends ${kind}`, async () => {
			const ackB =
				deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotConfigure>>>();
			configure.mockResolvedValueOnce({ success: true });
			configure.mockReturnValueOnce(ackB.promise);
			wire.message("status", { wifi: { "0": row("radio-A", true) } });
			render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row("radio-A", true),
			});
			await fireEvent.input(input("hotspot-name"), {
				target: { value: "older-save" },
			});
			await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
			await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
			sweepOperations(Date.now() + 16000);
			await tick();
			const key = wifiHotspotConfigOpKey("0", "radio-A");
			expect(getOperationPhase(key)).toBe("timed_out");
			await fireEvent.input(input("hotspot-name"), {
				target: { value: "newer-save" },
			});
			await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
			await waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
			wire.message("wifi", {
				hotspot: { config: { device: 0, incarnation: "radio-A", ...terminal } },
			});
			// Preserve transport order: A's terminal arrives before B's ack.
			ackB.resolve({ success: true });
			wire.message("status", { wifi: { "0": row("radio-A", true) } });
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
			await tick();
			expect({
				phase: getOperationPhase(key),
				draft: input("hotspot-name").value,
				requests: configure.mock.calls.length,
				toasts: vi.mocked(toast.error).mock.calls.length,
			}).toEqual({
				phase: "pending",
				draft: "newer-save",
				requests: 2,
				toasts: 0,
			});
			wire.message("wifi", {
				hotspot: {
					config: { device: 0, incarnation: "radio-A", success: true },
				},
			});
			await waitFor(() => expect(getOperationPhase(key)).toBe("confirmed"));
		});
	}

	it("retires an older Save's result and reload when its controller is replaced", async () => {
		const ackA =
			deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotConfigure>>>();
		const ackB =
			deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotConfigure>>>();
		configure.mockReturnValueOnce(ackA.promise);
		configure.mockReturnValueOnce(ackB.promise);
		wire.message("status", { wifi: { "0": row("radio-A", true) } });
		render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row("radio-A", true),
		});
		await fireEvent.input(input("hotspot-name"), {
			target: { value: "older-save" },
		});
		await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		const key = wifiHotspotConfigOpKey("0", "radio-A");
		wire.message("wifi", {
			hotspot: {
				config: { device: 0, incarnation: "radio-A", error: "radio-changed" },
			},
		});
		await waitFor(() => expect(getOperationPhase(key)).toBe("failed"));
		await fireEvent.input(input("hotspot-name"), {
			target: { value: "newer-save" },
		});
		await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
		// A's ack resolves first, while B's acknowledgement is still held.
		ackA.resolve({ success: true });
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		await tick();
		expect({
			phase: getOperationPhase(key),
			draft: input("hotspot-name").value,
			requests: configure.mock.calls.length,
			toasts: vi.mocked(toast.error).mock.calls.length,
		}).toEqual({
			phase: "pending",
			draft: "newer-save",
			requests: 2,
			toasts: 0,
		});
		ackB.resolve({ success: true });
		wire.message("wifi", {
			hotspot: { config: { device: 0, incarnation: "radio-A", success: true } },
		});
		await waitFor(() => expect(getOperationPhase(key)).toBe("confirmed"));
	});
});

describe("Configure receipt retirement", () => {
	for (const offline of [true, false]) {
		it(`confirms the next Save after ${offline ? "an unsent offline call and reconnect" : "an authentication rejection before admission"}`, async () => {
			const actual =
				await vi.importActual<typeof import("$lib/rpc/client")>(
					"$lib/rpc/client",
				);
			if (offline) {
				noteLinkState("disconnected");
				configure.mockImplementationOnce((request) =>
					actual.rpcClient.call(["wifi", "hotspotConfigure"], request),
				);
			} else {
				// The real adapter serializes the auth middleware's error this way.
				configure.mockRejectedValueOnce(
					new RpcError({
						code: "INTERNAL_ERROR",
						message: "Authentication required",
					}),
				);
			}
			wire.message("status", { wifi: { "0": row("radio-A", true) } });
			render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row("radio-A", true),
			});
			await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
			const key = wifiHotspotConfigOpKey("0", "radio-A");
			await waitFor(() => expect(getOperationPhase(key)).toBe("failed"));
			if (offline) {
				await expect(configure.mock.results[0]?.value).rejects.toBeInstanceOf(
					NotSentError,
				);
				noteLinkState("connected");
				await tick();
			}
			await fireEvent.input(input("hotspot-name"), {
				target: { value: "after-rejection" },
			});
			await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
			await waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
			wire.message("wifi", {
				hotspot: {
					config: { device: 0, incarnation: "radio-A", success: true },
				},
			});
			await waitFor(() => expect(getOperationPhase(key)).toBe("confirmed"));
			expect(input("hotspot-name").value).toBe("after-rejection");
			expect(toast.error).toHaveBeenCalledTimes(1);
		});
	}

	it("retains possible terminal debt after a dispatched call times out", async () => {
		configure.mockRejectedValueOnce(
			new Error("Request timeout: wifi.hotspotConfigure"),
		);
		wire.message("status", { wifi: { "0": row("radio-A", true) } });
		render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row("radio-A", true),
		});
		await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
		const key = wifiHotspotConfigOpKey("0", "radio-A");
		await waitFor(() => expect(getOperationPhase(key)).toBe("failed"));
		const ackB =
			deferred<Awaited<ReturnType<typeof rpc.wifi.hotspotConfigure>>>();
		configure.mockReturnValueOnce(ackB.promise);
		await fireEvent.input(input("hotspot-name"), {
			target: { value: "after-timeout" },
		});
		await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
		wire.message("wifi", {
			hotspot: { config: { device: 0, incarnation: "radio-A", success: true } },
		});
		ackB.resolve({ success: true });
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		expect({
			phase: getOperationPhase(key),
			draft: input("hotspot-name").value,
			requests: configure.mock.calls.length,
		}).toEqual({ phase: "pending", draft: "after-timeout", requests: 2 });
		wire.message("wifi", {
			hotspot: { config: { device: 0, incarnation: "radio-A", success: true } },
		});
		await waitFor(() => expect(getOperationPhase(key)).toBe("confirmed"));
	});

	it("drains every delivered old-token receipt across repeated token rotations", async () => {
		const delivered: Parameters<typeof noteWifiConfig>[0][] = [];
		wire.message("status", { wifi: { "0": row("rotation-0", true) } });
		const { rerender } = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row("rotation-0", true),
		});
		for (let index = 0; index < 8; index += 1) {
			await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
			await waitFor(() => expect(configure).toHaveBeenCalledTimes(index + 1));
			wire.message("status", {
				wifi: { "0": row(`rotation-${index + 1}`, true) },
			});
			// Each rotation closes the dialog; the operator reopens it on the new token.
			await rerender({
				open: true,
				deviceId: "0",
				iface: row(`rotation-${index + 1}`, true),
			});
			await closedWithNotice();
			await rerender({
				open: false,
				deviceId: "0",
				iface: row(`rotation-${index + 1}`, true),
			});
			await rerender({
				open: true,
				deviceId: "0",
				iface: row(`rotation-${index + 1}`, true),
			});
			const terminal = {
				device: 0,
				incarnation: `rotation-${index}`,
				success: true,
			};
			delivered.push(terminal);
			wire.message("wifi", { hotspot: { config: terminal } });
			sweepOperations(Date.now() + 16000);
			await tick();
		}
		// A replay can find no retired owner: every original terminal was delivered.
		expect(delivered.map((terminal) => noteWifiConfig(terminal))).toEqual([
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
		]);
		await fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
		wire.message("wifi", {
			hotspot: {
				config: { device: 0, incarnation: "rotation-8", success: true },
			},
		});
		await waitFor(() =>
			expect(getOperationPhase(wifiHotspotConfigOpKey("0", "rotation-8"))).toBe(
				"confirmed",
			),
		);
	});
});

describe("a Start receipt detached by a radio change", () => {
	async function startThenRotate(view: ReturnType<typeof render>) {
		start.mockResolvedValueOnce({ success: true, accepted: true });
		await gate();
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
		const attempt = start.mock.calls[0]?.[0].attempt;
		await view.rerender({ open: true, deviceId: "0", iface: row("radio-B") });
		await closedWithNotice();
		expect(pendingWifiStartReceiptsForTest()).toBe(1);
		return attempt;
	}

	function lateTerminal(
		attempt: string | undefined,
		error: string,
		reason?: string,
	) {
		wire.message("wifi", {
			hotspot: {
				start: { device: 0, attempt, error, ...(reason ? { reason } : {}) },
			},
		});
	}

	async function settle() {
		await tick();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}

	it("ends with the view: nothing waits and a later terminal reports nothing", async () => {
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		const attempt = await startThenRotate(view);
		view.unmount();
		expect(pendingWifiStartReceiptsForTest()).toBe(0);
		sweepOperations(Date.now() + 61_000);
		lateTerminal(attempt, "radio-changed", "deactivation-failed");
		await settle();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("ends on a fresh pick: a second Start's dialog never shows the first one's terminal", async () => {
		const view = render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: row(),
		});
		const attempt = await startThenRotate(view);
		await view.rerender({ open: false, deviceId: "0", iface: row("radio-B") });
		await view.rerender({ open: true, deviceId: "0", iface: row("radio-B") });
		await waitFor(() => expect(pendingWifiStartReceiptsForTest()).toBe(0));
		start.mockResolvedValueOnce({ success: true, accepted: true });
		await gate();
		await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
		await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
		await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
		expect(start.mock.calls[1]?.[0]).toMatchObject({ incarnation: "radio-B" });
		expect(pendingWifiStartReceiptsForTest()).toBe(1);
		lateTerminal(attempt, "radio-changed", "deactivation-failed");
		await settle();
		expect(toast.error).not.toHaveBeenCalled();
		expect(screen.queryByTestId("hotspot-start-refused")).toBeNull();
	});

	it("ends by the Start's 60 s bound", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row(),
			});
			const attempt = await startThenRotate(view);
			vi.advanceTimersByTime(60_000);
			await waitFor(() => expect(pendingWifiStartReceiptsForTest()).toBe(0));
			lateTerminal(attempt, "radio-changed", "deactivation-failed");
			await settle();
			expect(toast.error).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		[
			"DEVICE_BUSY",
			"setup-in-progress",
			"Device is busy, try again in a moment",
		],
		["not-confirmed", undefined, "Couldn't complete the action"],
		[
			"radio-changed",
			undefined,
			"The Wi-Fi adapter changed, so the hotspot wasn't turned on.",
		],
	] as const)(
		"reports a late %s refusal in the dialog's own words",
		async (error, reason, text) => {
			const view = render(HotspotDialog, {
				open: true,
				deviceId: "0",
				iface: row(),
			});
			const attempt = await startThenRotate(view);
			lateTerminal(attempt, error, reason);
			await waitFor(() =>
				expect(toast.error).toHaveBeenCalledWith(expect.stringContaining(text)),
			);
			expect(pendingWifiStartReceiptsForTest()).toBe(0);
		},
	);
});
