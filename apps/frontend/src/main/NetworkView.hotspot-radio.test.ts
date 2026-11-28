// @vitest-environment jsdom
/**
 * The hotspot radio pick is an expiring `[id, incarnation]` target: it clears on
 * a backend restart or replug, several radios need an explicit pick, and an
 * open hotspot dialog keeps the radio it was opened for.
 */
import type { WifiInterface } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import { reactiveWifi } from "../tests/fixtures/reactive-wifi.svelte";

vi.mock("$lib/rpc/subscriptions.svelte", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/rpc/subscriptions.svelte")>()),
	getWifi: () => reactiveWifi.value,
	getIsConnected: () => true,
}));
vi.mock("./dialogs/HotspotDialog.svelte", async () => ({
	default: (await import("../tests/fixtures/HotspotDialogTargetStub.svelte"))
		.default,
}));
for (const section of [
	"./network/BluetoothSection.svelte",
	"./network/BondedLinksSection.svelte",
	"./network/CellularSection.svelte",
	"./network/CollisionBands.svelte",
	"./network/EthernetSection.svelte",
	"./network/SharingSection.svelte",
	"./network/UnclaimedAdaptersBand.svelte",
	"./network/WifiSection.svelte",
]) {
	vi.doMock(section, async () => ({
		default: (await import("../tests/fixtures/Noop.svelte")).default,
	}));
}

const radio = (ifname: string, incarnation: string): WifiInterface => ({
	ifname,
	incarnation,
	hw: "Adapter",
	conn: "",
	saved: {},
	supports_hotspot: true,
});

async function mount() {
	const { default: NetworkView } = await import("./NetworkView.svelte");
	render(NetworkView);
	await tick();
}

function picker(): HTMLSelectElement {
	const select = document.querySelector<HTMLSelectElement>("#hotspot-radio");
	if (!select) throw new Error("missing radio picker");
	return select;
}

function setup(): HTMLButtonElement {
	return screen.getByTestId("open-hotspot-dialog") as HTMLButtonElement;
}

afterEach(() => {
	reactiveWifi.reset();
});

it("requires a pick with several radios and clears it on restart", async () => {
	reactiveWifi.value = {
		"0": radio("wlan0", "a-1"),
		"1": radio("wlan1", "b-1"),
	};
	await mount();
	expect(picker().value).toBe("");
	expect(setup().disabled).toBe(true);

	await fireEvent.change(picker(), { target: { value: "1" } });
	expect(picker().value).toBe("1");
	expect(setup().disabled).toBe(false);

	// Backend restart: same ids, new incarnations. The pick expires, nothing
	// else is chosen in its place.
	reactiveWifi.value = {
		"0": radio("wlan0", "a-2"),
		"1": radio("wlan1", "b-2"),
	};
	flushSync();
	await tick();
	expect(picker().value).toBe("");
	expect(setup().disabled).toBe(true);
	expect(screen.getByTestId("hotspot-radio-lost")).toBeTruthy();
});

it("does not move to the remaining radio when the picked one is unplugged", async () => {
	reactiveWifi.value = {
		"0": radio("wlan0", "a-1"),
		"1": radio("wlan1", "b-1"),
	};
	await mount();
	await fireEvent.change(picker(), { target: { value: "1" } });

	reactiveWifi.value = { "0": radio("wlan0", "a-1") };
	flushSync();
	await tick();
	expect(picker().value).toBe("");
	expect(setup().disabled).toBe(true);

	await fireEvent.change(picker(), { target: { value: "0" } });
	expect(setup().disabled).toBe(false);
});

it("keeps an open dialog on the radio it was opened for", async () => {
	reactiveWifi.value = {
		"0": radio("wlan0", "a-1"),
		"1": radio("wlan1", "b-1"),
	};
	await mount();
	await fireEvent.change(picker(), { target: { value: "1" } });
	await fireEvent.click(setup());
	const dialog = await vi.waitFor(() =>
		screen.getByTestId("hotspot-dialog-stub"),
	);
	expect(dialog.dataset.device).toBe("1");

	// The pick expires under the open dialog; it is not retargeted to radio 0.
	reactiveWifi.value = {
		"0": radio("wlan0", "a-1"),
		"1": radio("wlan1", "b-2"),
	};
	flushSync();
	await tick();
	expect(picker().value).toBe("");
	const still = screen.getByTestId("hotspot-dialog-stub");
	expect(still.dataset.device).toBe("1");
	// It is never handed the replacement row; the dialog then closes itself.
	expect(still.dataset.incarnation).toBe("");
});

it("expires the only radio's pick when its incarnation changes under the same id", async () => {
	reactiveWifi.value = { "0": radio("wlan0", "old") };
	await mount();
	// A single radio is preselected; opening Setup confirms it as the target.
	expect(picker().value).toBe("0");
	await fireEvent.click(setup());
	await vi.waitFor(() => screen.getByTestId("hotspot-dialog-stub"));

	reactiveWifi.value = { "0": radio("wlan0", "new") };
	flushSync();
	await tick();
	expect(picker().value).toBe("");
	expect(setup().disabled).toBe(true);
	expect(screen.getByTestId("hotspot-radio-lost")).toBeTruthy();
	expect(screen.getByTestId("hotspot-dialog-stub").dataset.incarnation).toBe(
		"",
	);

	await fireEvent.change(picker(), { target: { value: "0" } });
	expect(setup().disabled).toBe(false);
});

it("does not offer a radio without an incarnation as the target", async () => {
	reactiveWifi.value = {
		"0": { ...radio("wlan0", "x"), incarnation: undefined },
	};
	await mount();
	expect(setup().disabled).toBe(true);
});
