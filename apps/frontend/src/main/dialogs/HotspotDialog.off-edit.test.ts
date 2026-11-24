// @vitest-environment jsdom
/**
 * Editing the hotspot while it is off: the name and password are read from and
 * saved through `hotspotPrepare` with the chosen pair, never through the status
 * wire, and saving never brings the AP up. Asserted against the rendered DOM and
 * the RPCs actually sent.
 */
import type { WifiInterface } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { toast } from "svelte-sonner";
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
import { rpc } from "$lib/rpc/client";
import HotspotDialog from "./HotspotDialog.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		wifi: {
			hotspotStart: vi.fn(async () => ({ success: true, accepted: true })),
			hotspotStop: vi.fn(),
			hotspotPrepare: vi.fn(),
			hotspotConfigure: vi.fn(async () => ({ success: true })),
			getAdapterModes: vi.fn(async () => ({})),
			setAdapterMode: vi.fn(async () => ({ success: true, accepted: true })),
		},
	},
	rpcClient: {
		onConnectionChange: () => () => {},
		getConnectionState: () => "connected",
	},
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "") } }));
const status = vi.hoisted(() => ({
	next: undefined as { incarnation?: string } | undefined,
}));
vi.mock("$lib/rpc/wifi-status-receipt", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/rpc/wifi-status-receipt")>()),
	waitForWifiStatus: vi.fn(async () => status.next),
}));

const prepare = vi.mocked(rpc.wifi.hotspotPrepare);

// Off: the row carries no `hotspot` block, so nothing about the saved setup is
// on the wire.
const OFF: WifiInterface = {
	incarnation: "radio-A",
	ifname: "wlan0",
	conn: "HomeNet",
	hw: "Internal",
	saved: {},
	supports_hotspot: true,
};

function q<T extends HTMLElement = HTMLElement>(testid: string): T | null {
	return document.querySelector<T>(`[data-testid="${testid}"]`);
}

function input(testid: string): HTMLInputElement {
	const el = q<HTMLInputElement>(testid);
	if (!el) throw new Error(`missing ${testid}`);
	return el;
}

async function openEditor(iface: WifiInterface = OFF) {
	const view = render(HotspotDialog, {
		props: { open: true, deviceId: "0", iface },
	});
	await fireEvent.click(q("hotspot-off-edit") as HTMLElement);
	await vi.waitFor(() =>
		expect(q("hotspot-off-editor")?.dataset.phase).toBe("ready"),
	);
	return view;
}

async function choose(name: string, password: string) {
	await fireEvent.input(input("hotspot-off-name"), { target: { value: name } });
	await fireEvent.input(input("hotspot-off-password"), {
		target: { value: password },
	});
}

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
	prepare.mockImplementation(async (input) => ({
		success: true,
		name: input.name ?? "Saved Rig",
		password: input.password ?? "saved-secret",
	}));
});

afterEach(() => {
	destroyAsyncOperations();
	vi.clearAllMocks();
});

describe("HotspotDialog — edit while off", () => {
	it("reads nothing until asked, then fills the form from the Prepare reply", async () => {
		render(HotspotDialog, { props: { open: true, deviceId: "0", iface: OFF } });
		await tick();
		expect(prepare).not.toHaveBeenCalled();
		expect(document.querySelector("#hotspot-name")).toBeNull();

		await fireEvent.click(q("hotspot-off-edit") as HTMLElement);
		await vi.waitFor(() =>
			expect(q("hotspot-off-editor")?.dataset.phase).toBe("ready"),
		);
		expect(prepare).toHaveBeenCalledWith({
			device: "0",
			incarnation: "radio-A",
		});
		expect(input("hotspot-off-name").value).toBe("Saved Rig");
		expect(input("hotspot-off-password").value).toBe("saved-secret");
	});

	it("saves the chosen pair through Prepare and starts nothing", async () => {
		await openEditor();
		await choose("Rig Cam", "my own pass");
		await fireEvent.click(q("hotspot-off-save") as HTMLElement);
		await vi.waitFor(() => expect(q("hotspot-off-saved")).not.toBeNull());

		expect(prepare).toHaveBeenLastCalledWith({
			device: "0",
			incarnation: "radio-A",
			name: "Rig Cam",
			password: "my own pass",
		});
		expect(rpc.wifi.hotspotStart).not.toHaveBeenCalled();
		expect(rpc.wifi.hotspotConfigure).not.toHaveBeenCalled();
		expect(rpc.wifi.setAdapterMode).not.toHaveBeenCalled();
		expect(q("hotspot-status")?.dataset.active).toBe("false");
		// Saved and unchanged: nothing left to save.
		expect(q<HTMLButtonElement>("hotspot-off-save")?.disabled).toBe(true);
	});

	it("reports a failed durable write and keeps the draft", async () => {
		await openEditor();
		await choose("Rig Cam", "my own pass");
		prepare.mockResolvedValueOnce({
			success: false,
			error: "activation-failed",
			reason: "credential-store-unwritten",
		});
		await fireEvent.click(q("hotspot-off-save") as HTMLElement);
		await vi.waitFor(() => expect(q("hotspot-off-save-failed")).not.toBeNull());
		expect(q("hotspot-off-saved")).toBeNull();
		expect(input("hotspot-off-name").value).toBe("Rig Cam");
		expect(q<HTMLButtonElement>("hotspot-off-save")?.disabled).toBe(false);
		expect(rpc.wifi.hotspotStart).not.toHaveBeenCalled();
	});

	it("never claims a save the reply did not echo", async () => {
		await openEditor();
		await choose("Rig Cam", "my own pass");
		prepare.mockResolvedValueOnce({
			success: true,
			name: "Saved Rig",
			password: "saved-secret",
		});
		await fireEvent.click(q("hotspot-off-save") as HTMLElement);
		await vi.waitFor(() => expect(q("hotspot-off-save-failed")).not.toBeNull());
		expect(q("hotspot-off-saved")).toBeNull();
	});

	it("refuses an invalid pair before sending anything", async () => {
		await openEditor();
		await choose("ab", "short");
		expect(q<HTMLButtonElement>("hotspot-off-save")?.disabled).toBe(true);
		expect(prepare).toHaveBeenCalledTimes(1);
	});

	it("a changed radio closes the dialog and loads nothing for the new lifetime", async () => {
		const view = await openEditor();
		await choose("Rig Cam", "my own pass");
		await view.rerender({ iface: { ...OFF, incarnation: "radio-B" } });
		await vi.waitFor(() => expect(q("hotspot-status")).toBeNull());
		expect(toast.warning).toHaveBeenCalled();
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(prepare).toHaveBeenLastCalledWith({
			device: "0",
			incarnation: "radio-A",
		});
	});

	it("resends an unobserved save only when the same token returns", async () => {
		await openEditor();
		await choose("Rig Cam", "my own pass");
		status.next = { incarnation: "radio-A" };
		prepare.mockResolvedValueOnce({
			success: false,
			error: "radio-changed",
			reason: "current-unobserved",
		});
		await fireEvent.click(q("hotspot-off-save") as HTMLElement);
		await vi.waitFor(() => expect(q("hotspot-off-saved")).not.toBeNull());
		expect(prepare).toHaveBeenCalledTimes(3);
		expect(prepare).toHaveBeenLastCalledWith({
			device: "0",
			incarnation: "radio-A",
			name: "Rig Cam",
			password: "my own pass",
		});
	});

	it("refuses an unobserved save when a different token returns", async () => {
		await openEditor();
		await choose("Rig Cam", "my own pass");
		status.next = { incarnation: "radio-B" };
		prepare.mockResolvedValueOnce({
			success: false,
			error: "radio-changed",
			reason: "current-unobserved",
		});
		await fireEvent.click(q("hotspot-off-save") as HTMLElement);
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain(
				"The Wi-Fi adapter changed, so these settings weren't saved.",
			),
		);
		expect(prepare).toHaveBeenCalledTimes(2);
		expect(q("hotspot-off-saved")).toBeNull();
	});

	it("a radio-changed save refusal is shown and nothing is claimed", async () => {
		await openEditor();
		await choose("Rig Cam", "my own pass");
		prepare.mockResolvedValueOnce({ success: false, error: "radio-changed" });
		await fireEvent.click(q("hotspot-off-save") as HTMLElement);
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain(
				"The Wi-Fi adapter changed, so these settings weren't saved.",
			),
		);
		expect(q("hotspot-off-saved")).toBeNull();
	});

	it("is not offered while the AP is live", async () => {
		render(HotspotDialog, {
			props: {
				open: true,
				deviceId: "0",
				iface: {
					...OFF,
					mode: "hotspot",
					hotspot: {
						name: "Live",
						password: "live-secret",
						available_channels: {},
					},
				},
			},
		});
		await tick();
		expect(q("hotspot-off-edit")).toBeNull();
		expect(document.querySelector("#hotspot-name")).not.toBeNull();
	});
});
