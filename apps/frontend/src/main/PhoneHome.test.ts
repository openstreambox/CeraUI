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
				name: "Checking whether your phone uses the box",
			}),
		).toBeTruthy();
	});
	it("renders the carrying card without encoder controls", () => {
		render(PhoneHome, { carrying: "streaming" });
		expect(
			screen.getByRole("heading", { name: "Carrying your phone's stream" }),
		).toBeTruthy();
		expect(screen.queryByText(/engine offline|not live|idle/i)).toBeNull();
	});
	it("keeps the selected app and offers Change app", async () => {
		render(PhoneHome, { carrying: "idle" });
		await fireEvent.click(
			screen.getByRole("button", { name: "Connect your phone" }),
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
				name: "Checking whether your phone uses the box",
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
			screen.getByRole("button", { name: "Connect your phone" }),
		);
		await fireEvent.click(screen.getByRole("button", { name: "IRL Pro" }));
		expect(onsave).not.toHaveBeenCalled();
		await rerender({ carrying: "streaming", onsave });
		await waitFor(() => expect(onsave).toHaveBeenCalledWith("srt"));
	});
});
