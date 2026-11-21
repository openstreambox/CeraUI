import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import PhoneHome from "./PhoneHome.svelte";
import { phoneState, remotePhoneState, showPhoneQr } from "./phone-home";

describe("phone Home", () => {
	it.each([undefined, "unknown"] as const)("maps %s to Checking", (state) => {
		expect(phoneState(state)).toBe("checking");
		render(PhoneHome, { carrying: state });
		expect(
			screen.getByRole("heading", {
				name: "Checking whether a device is sending through the box",
			}),
		).toBeTruthy();
	});
	it("renders the carrying card without encoder controls", () => {
		render(PhoneHome, { carrying: "streaming" });
		expect(
			screen.getByRole("heading", { name: "Carrying your stream" }),
		).toBeTruthy();
		expect(screen.queryByText(/engine offline|not live|idle/i)).toBeNull();
	});
	it("keeps the selected app and offers Change app", async () => {
		render(PhoneHome, { carrying: "idle" });
		await fireEvent.click(
			screen.getByRole("button", { name: "Connect a device" }),
		);
		await fireEvent.click(screen.getByRole("button", { name: "IRL Pro" }));
		expect(screen.getByRole("button", { name: "Change app" })).toBeTruthy();
		expect(screen.getByText(/choose SRT, not SRTLA/)).toBeTruthy();
	});
	it("disables restart while carrying", () => {
		render(PhoneHome, { carrying: "streaming" });
		expect(
			screen.getByRole("button", { name: "Restart the box" }),
		).toHaveProperty("disabled", true);
	});
	it("uses Copy at 390px and excludes kiosk QR", () => {
		expect(showPhoneQr(390, false)).toBe(false);
		expect(showPhoneQr(1280, false)).toBe(true);
		expect(showPhoneQr(1024, false)).toBe(true);
		expect(showPhoneQr(1024, true)).toBe(false);
	});
	it("remote lines never include local network names or credentials", () => {
		for (const state of ["streaming", "idle", "unknown"] as const) {
			expect(remotePhoneState(state)).toMatch(/check the stream itself/i);
			expect(remotePhoneState(state)).not.toMatch(/ssid|srt:\/\/|password/i);
		}
	});
	it("does not claim a phone stream after the box becomes unreachable", () => {
		render(PhoneHome, {
			carrying: "streaming",
			reachable: false,
			links: [{ id: "L1", label: "Wi-Fi", internet: "yes" }],
		});
		expect(
			screen.getByRole("heading", {
				name: "Checking whether a device is sending through the box",
			}),
		).toBeTruthy();
		expect(remotePhoneState("streaming", false)).toContain(
			"Can't reach the box",
		);
	});
	it("remembers the chosen way only once the box starts carrying", async () => {
		const onsave = vi.fn(async () => {});
		const { rerender } = render(PhoneHome, { carrying: "idle", onsave });
		await fireEvent.click(
			screen.getByRole("button", { name: "Connect a device" }),
		);
		await fireEvent.click(screen.getByRole("button", { name: "IRL Pro" }));
		expect(onsave).not.toHaveBeenCalled();
		await rerender({ carrying: "streaming", onsave });
		await waitFor(() => expect(onsave).toHaveBeenCalledWith("srt"));
	});
});

it("renders Moblin's password label as text", async () => {
	render(PhoneHome, { carrying: "idle" });
	await fireEvent.click(
		screen.getByRole("button", { name: "Connect a device" }),
	);
	await fireEvent.click(
		screen.getByRole("button", { name: "Moblin", exact: true }),
	);
	expect(
		screen.getByLabelText(
			"Moblin's password (from Moblin, not the Wi-Fi password)",
		),
	).toBeTruthy();
});
it("offers Just internet at both SRT dead ends with the SRT hint", async () => {
	render(PhoneHome, { carrying: "idle" });
	await fireEvent.click(
		screen.getByRole("button", { name: "Connect a device" }),
	);
	await fireEvent.click(
		screen.getByRole("button", { name: "IRL Pro", exact: true }),
	);
	expect(
		screen.getAllByRole("button", { name: "Just internet", exact: true }),
	).toHaveLength(2);
	expect(
		screen.getByText(
			"This box isn't set up to take SRT from an app yet. Use Just internet for now.",
		),
	).toBeTruthy();
	expect(
		screen.getByText(/Nothing after 30 seconds.*address and passphrase match/),
	).toBeTruthy();
	expect(screen.getByRole("button", { name: "Set your server" })).toBeTruthy();
});
it("does not claim to be checking internet while carrying", () => {
	render(PhoneHome, {
		carrying: "streaming",
		temperature: 50.8,
		wifi: { clients: 1 },
	});
	expect(screen.queryByText("Checking internet")).toBeNull();
	expect(screen.getByText("51 °C · Fine")).toBeTruthy();
	expect(screen.getByText("1 device on the box's Wi-Fi")).toBeTruthy();
	expect(screen.getByText("Not set up")).toBeTruthy();
});
it("explains the startup restart hold", () => {
	render(PhoneHome, { carrying: "unknown" });
	expect(
		screen.getByText(
			"You can restart once the box knows whether a device is sending through it.",
		),
	).toBeTruthy();
});

it.each(["streaming", "idle", "unknown"] as const)(
	"shows state-specific degraded health while %s",
	(carrying) => {
		render(PhoneHome, {
			carrying,
			health: [{ part: "cellular", since: 1 }],
			links: [{ id: "L1", label: "Wi-Fi (Example)", internet: "yes" }],
		});
		expect(
			screen.getByText(
				carrying === "streaming"
					? /didn't start. Your stream is going over Wi-Fi/
					: /didn't start. Links that work: Wi-Fi/,
			),
		).toBeTruthy();
	},
);
it("keeps maintenance-only failure out of the amber line", () => {
	const { container } = render(PhoneHome, {
		carrying: "idle",
		health: [{ part: "update-orchestrator-maintenance", since: 1 }],
	});
	expect(container.querySelector(".health-line")).toBeNull();
});

it("keeps unknown link probes calm while carrying", () => {
	render(PhoneHome, {
		carrying: "streaming",
		links: [{ id: "L1", label: "Wi-Fi", internet: "unknown" }],
	});
	expect(screen.queryByText("Checking internet")).toBeNull();
	expect(screen.getByText("Link details aren't available yet")).toBeTruthy();
});

describe("Moblin credential", () => {
	it("submits once and removes the secret from the form even after failure", async () => {
		const oncredential = vi.fn(async () => ({ success: false }));
		render(PhoneHome, {
			carrying: "idle",
			moblink: { available: true, configured: false },
			oncredential,
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Connect a device" }),
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Moblin", exact: true }),
		);
		const field = screen.getByLabelText(
			"Moblin's password (from Moblin, not the Wi-Fi password)",
		);
		expect(field).toHaveProperty("disabled", false);
		await fireEvent.input(field, { target: { value: "form-secret" } });
		await fireEvent.click(
			screen.getByRole("button", { name: "Save Moblin password" }),
		);
		await waitFor(() =>
			expect(oncredential).toHaveBeenCalledWith("form-secret"),
		);
		expect(field).toHaveProperty("value", "");
		expect(document.body.textContent).not.toContain("form-secret");
	});
	it.each(["streaming", "unknown"] as const)(
		"protects %s from credential replacement",
		async (carrying) => {
			const { rerender } = render(PhoneHome, {
				carrying: "idle",
				moblink: { available: true, configured: true },
			});
			await fireEvent.click(
				screen.getByRole("button", { name: "Connect a device" }),
			);
			await fireEvent.click(
				screen.getByRole("button", { name: "Moblin", exact: true }),
			);
			await rerender({
				carrying,
				moblink: { available: true, configured: true },
			});
			expect(
				screen.getByLabelText(
					"Moblin's password (from Moblin, not the Wi-Fi password)",
				),
			).toHaveProperty("disabled", true);
		},
	);
});

it.each([false, true])(
	"allows clearing with unavailable relay and configured=%s",
	async (configured) => {
		const onclearcredential = vi.fn(async () => ({ success: true }));
		render(PhoneHome, {
			carrying: "idle",
			moblink: { available: false, configured },
			onclearcredential,
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Connect a device" }),
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Moblin", exact: true }),
		);
		const field = screen.getByLabelText(
			"Moblin's password (from Moblin, not the Wi-Fi password)",
		);
		expect(field.getAttribute("autocomplete")).toBe("off");
		expect(field.hasAttribute("data-1p-ignore")).toBe(true);
		expect(field.getAttribute("data-lpignore")).toBe("true");
		expect(field.hasAttribute("data-bwignore")).toBe(true);
		expect(field.getAttribute("data-form-type")).toBe("other");
		const clear = screen.getByRole("button", { name: "Clear Moblin password" });
		expect(clear).toHaveProperty("disabled", false);
		await fireEvent.click(clear);
		await waitFor(() => expect(onclearcredential).toHaveBeenCalledOnce());
	},
);

it.each([false, true])(
	"Moblin choice reflects relay availability=%s",
	async (available) => {
		render(PhoneHome, {
			carrying: "idle",
			moblink: { available, configured: false },
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Connect a device" }),
		);
		const choice = screen.getByRole("button", { name: "Moblin", exact: true });
		expect(choice.textContent).toContain(
			available ? "Use your Moblin relay password." : "Not on this box yet",
		);
	},
);

it("clearing absent credentials reports the resulting state without claiming a stream stopped", async () => {
	const onclearcredential = vi.fn(async () => ({ success: true }));
	render(PhoneHome, {
		carrying: "idle",
		moblink: { available: false, configured: false },
		onclearcredential,
	});
	await fireEvent.click(
		screen.getByRole("button", { name: "Connect a device" }),
	);
	await fireEvent.click(
		screen.getByRole("button", { name: "Moblin", exact: true }),
	);
	await fireEvent.click(
		screen.getByRole("button", { name: "Clear Moblin password" }),
	);
	await waitFor(() => expect(onclearcredential).toHaveBeenCalledOnce());
	expect(
		screen.getByText("No Moblin password is saved on this box."),
	).toBeTruthy();
	expect(screen.queryByText(/has stopped lending/)).toBeNull();
});

it("keeps the Wi-Fi code behind Show code and offers New Wi-Fi password", async () => {
	const onrenew = vi.fn();
	render(PhoneHome, {
		carrying: "idle",
		wifi: { name: "Box", password: "correcthorse" },
		wifiRenew: { phase: "idle", streaming: false, onrenew },
	});
	await fireEvent.click(
		screen.getByRole("button", { name: "Connect a device" }),
	);
	await fireEvent.click(screen.getByRole("button", { name: "IRL Pro" }));
	const show = screen.getByRole("button", { name: "Show code" });
	expect(show.getAttribute("aria-expanded")).toBe("false");
	expect(screen.getByTestId("wifi-code-frame").querySelector("img")).toBeNull();
	await fireEvent.click(
		screen.getByRole("button", { name: "New Wi-Fi password" }),
	);
	await fireEvent.click(
		screen.getByRole("button", { name: "Change the password" }),
	);
	expect(onrenew).toHaveBeenCalledTimes(1);
});

it("shows a join only for the hotspot its card describes", async () => {
	const { noteHotspotRoster, resetHotspotJoinsForTest } = await import(
		"$lib/stores/hotspot-joins.svelte"
	);
	resetHotspotJoinsForTest();
	const ap = (macs: string[], incarnation: string) => ({
		ifname: "wlan0",
		conn: "ap",
		hw: "02:00:00:00:00:01",
		saved: {},
		mode: "hotspot" as const,
		incarnation,
		hotspot: {
			available_channels: { auto: { name: "Automatic" } },
			name: "Box",
			password: "correcthorse",
			channel: "auto",
			clients: { count: macs.length, stations: macs.map((mac) => ({ mac })) },
		},
	});
	const snapshot = (a: string[]) => ({
		"0": ap(a, "radio-A"),
		"1": ap(["bb:bb:bb:bb:bb:01"], "radio-B"),
	});
	noteHotspotRoster(snapshot(["aa:aa:aa:aa:aa:01"]));
	const onrenew = vi.fn();
	render(PhoneHome, {
		carrying: "idle",
		wifi: { name: "Box", password: "correcthorse" },
		wifiOwner: { device: "1", incarnation: "radio-B" },
		wifiRenew: { phase: "idle", streaming: false, onrenew },
	});
	await fireEvent.click(
		screen.getByRole("button", { name: "Connect a device" }),
	);
	await fireEvent.click(screen.getByRole("button", { name: "IRL Pro" }));
	noteHotspotRoster(snapshot(["aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02"]));
	await new Promise((settle) => setTimeout(settle, 0));
	expect(screen.getByTestId("wifi-code")).toBeTruthy();
	expect(screen.queryByTestId("wifi-code-joined")).toBeNull();
	expect(screen.queryByRole("button", { name: "Not mine?" })).toBeNull();
	resetHotspotJoinsForTest();
});
