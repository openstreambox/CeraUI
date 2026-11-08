// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import ModemEsimSection from "./ModemEsimSection.svelte";

const operation = vi.hoisted(() => vi.fn());
vi.mock("$lib/rpc", () => ({ rpc: { modems: { esimOperation: operation } } }));
const token = "a".repeat(64);
const profileId = "b".repeat(64);
const empty = { success: true, snapshot: { token, profiles: [] } };

beforeEach(() => {
	operation.mockReset();
	operation.mockResolvedValue(empty);
});
afterEach(cleanup);

async function openAndRead(): Promise<void> {
	await fireEvent.click(screen.getByRole("button", { name: "Manage eSIMs" }));
	await fireEvent.click(
		screen.getByRole("checkbox", {
			name: "I understand that this modem will disconnect.",
		}),
	);
	await fireEvent.click(screen.getByRole("button", { name: "Read profiles" }));
	await screen.findByText("No profiles installed.");
}

it("keeps unsupported hardware absent and the default-off gate inert", () => {
	const view = render(ModemEsimSection, {
		claim: "unavailable",
		deviceId: "0",
	});
	expect(screen.queryByTestId("modem-esim-management")).toBeNull();
	view.unmount();
	render(ModemEsimSection, { claim: "implemented", deviceId: "0" });
	expect(
		screen.getByText(
			"Enable eSIM management in Settings to configure this modem.",
		),
	).toBeTruthy();
	expect(screen.queryByRole("button")).toBeNull();
	expect(operation).not.toHaveBeenCalled();
});

it("requires acknowledgement for the disruptive profile read", async () => {
	render(ModemEsimSection, { claim: "enabled", deviceId: "0" });
	await fireEvent.click(screen.getByRole("button", { name: "Manage eSIMs" }));
	expect(
		(screen.getByRole("button", { name: "Read profiles" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	expect(operation).not.toHaveBeenCalled();
	await fireEvent.click(
		screen.getByRole("checkbox", {
			name: "I understand that this modem will disconnect.",
		}),
	);
	await fireEvent.click(screen.getByRole("button", { name: "Read profiles" }));
	await screen.findByText("No profiles installed.");
	expect(operation).toHaveBeenCalledWith({
		action: "inspect",
		device: "0",
		acknowledged: true,
	});
});

it("keeps downloads separate from activation and requires a second confirmation", async () => {
	render(ModemEsimSection, { claim: "enabled", deviceId: "0" });
	await openAndRead();
	const input = screen.getByLabelText(
		"Full LPA activation code",
	) as HTMLInputElement;
	expect(input.type).toBe("password");
	await fireEvent.input(input, {
		target: { value: "LPA:1$rsp.example.com$TEST" },
	});
	await fireEvent.click(screen.getByRole("button", { name: "Add eSIM" }));
	expect(operation).toHaveBeenCalledTimes(1);
	await screen.findByText(/The profile will remain disabled/);
	await fireEvent.click(
		screen.getByRole("button", { name: "Confirm", exact: true }),
	);
	await waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
	expect(operation.mock.calls[1]?.[0]).toMatchObject({
		action: "download",
		snapshot: token,
		activationCode: "LPA:1$rsp.example.com$TEST",
	});
	await waitFor(() =>
		expect(
			(screen.getByLabelText("Full LPA activation code") as HTMLInputElement)
				.value,
		).toBe(""),
	);
});

it("refuses a missing ePIN before submitting a download", async () => {
	render(ModemEsimSection, { claim: "enabled", deviceId: "0" });
	await openAndRead();
	await fireEvent.input(screen.getByLabelText("Full LPA activation code"), {
		target: { value: "LPA:1$rsp.example.com$TEST$$1" },
	});
	await fireEvent.click(screen.getByRole("button", { name: "Add eSIM" }));
	await screen.findByRole("alert");
	expect(operation).toHaveBeenCalledTimes(1);
});

it("protects an enabled profile from deletion", async () => {
	operation.mockResolvedValue({
		success: true,
		snapshot: {
			token,
			profiles: [
				{
					id: profileId,
					name: "Test profile",
					provider: "Example",
					state: "enabled",
				},
			],
		},
	});
	render(ModemEsimSection, { claim: "enabled", deviceId: "0" });
	await fireEvent.click(screen.getByRole("button", { name: "Manage eSIMs" }));
	await fireEvent.click(
		screen.getByRole("checkbox", {
			name: "I understand that this modem will disconnect.",
		}),
	);
	await fireEvent.click(screen.getByRole("button", { name: "Read profiles" }));
	await screen.findByText("Test profile");
	expect(
		(screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	await fireEvent.click(screen.getByRole("button", { name: "Disable" }));
	expect(operation).toHaveBeenCalledTimes(1);
	await screen.findByText(
		"Disable this profile? This modem will lose its cellular service.",
	);
});

it("discards the old snapshot after a refused write and explains uncertainty", async () => {
	render(ModemEsimSection, { claim: "enabled", deviceId: "0" });
	await openAndRead();
	operation.mockRejectedValue(new Error("transport lost"));
	await fireEvent.input(screen.getByLabelText("Full LPA activation code"), {
		target: { value: "LPA:1$rsp.example.com$TEST" },
	});
	await fireEvent.click(screen.getByRole("button", { name: "Add eSIM" }));
	await fireEvent.click(
		screen.getByRole("button", { name: "Confirm", exact: true }),
	);
	await screen.findByText(/Do not repeat the download/);
	expect(screen.queryByLabelText("Full LPA activation code")).toBeNull();
});

it("clears credentials when the management section closes", async () => {
	render(ModemEsimSection, { claim: "enabled", deviceId: "0" });
	await openAndRead();
	await fireEvent.input(screen.getByLabelText("Full LPA activation code"), {
		target: { value: "LPA:1$rsp.example.com$TEST" },
	});
	await fireEvent.click(screen.getByRole("button", { name: "Manage eSIMs" }));
	expect(screen.queryByLabelText("Full LPA activation code")).toBeNull();
	await fireEvent.click(screen.getByRole("button", { name: "Manage eSIMs" }));
	expect(screen.queryByRole("button", { name: "Add eSIM" })).toBeNull();
});
