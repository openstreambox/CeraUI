// @vitest-environment jsdom
/**
 * NetifDialog — the wired-port role control (todo 15, STAGED by todo 37).
 *
 * Five properties, and each replaces something an operator could not previously
 * see or could previously do by accident:
 *
 *   1. BOTH roles are on screen, each with its ONE-LINE CONSEQUENCE. A role is
 *      not a preference; it decides whether the port carries bonded stream
 *      traffic or hands itself to the client zone.
 *   2. SELECTION STAGES, IT DOES NOT APPLY. A role change reconfigures the port
 *      and can drop the LAN path the operator is reading the page over, so a
 *      radio click dispatches NOTHING — `setEthernetRole` is called from the
 *      Save handler and nowhere else.
 *   3. A STAGED CHANGE IS VISIBLE AND NAMES ITS COST. A picked rung looks like
 *      the rung the device is already on, so a differing staged role renders a
 *      standing band; an unchanged one renders none.
 *   4. CANCEL DISCARDS. Nothing is dispatched and the applied role comes back.
 *   5. The DEVICE moves the control. The op stays pending past the RPC, the
 *      displayed role is held on the prior one, and a typed refusal renders
 *      inline rather than as a toast that expires.
 */
import type { NetifEntry } from "@ceraui/rpc/schemas";
import { setEthernetRoleInputSchema } from "@ceraui/rpc/schemas";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
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

const streaming = { value: false };
const roleSupport = { value: false };

vi.mock("$lib/rpc", () => ({
	rpc: { network: { configure: vi.fn(), setEthernetRole: vi.fn() } },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getIsStreaming: () => streaming.value,
	getConnectionState: () => "connected",
	supportsEthernetRoleOp: () => roleSupport.value,
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

import { toast } from "svelte-sonner";
import { rpc } from "$lib/rpc";
import {
	beginOperation,
	confirmOperation,
	destroyAsyncOperations,
	failOperation,
	getOperationPhase,
	getOperationTarget,
	initAsyncOperations,
	timeoutOperation,
} from "$lib/rpc/async-operation.svelte";
import { ethernetRoleOpKey } from "$main/network/ethernet-role-view";

import NetifDialog from "./NetifDialog.svelte";

const setEthernetRole = vi.mocked(rpc.network.setEthernetRole);
const configure = vi.mocked(rpc.network.configure);
const KEY = ethernetRoleOpKey("eth0");

function iface(overrides: Partial<NetifEntry> = {}): NetifEntry {
	return {
		tp: 4096,
		enabled: true,
		ip: "192.168.1.50",
		ethRole: "uplink",
		...overrides,
	};
}

function open(entry: NetifEntry = iface(), name = "eth0") {
	return render(NetifDialog, { props: { open: true, name, iface: entry } });
}

/** The dialog's own Save, via AppDialog's default footer. */
function save() {
	return fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

/** The dialog's own Cancel, via AppDialog's default footer. */
function cancel() {
	return fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
}

function stage(role: "uplink" | "shared-lan", name = "eth0") {
	return fireEvent.click(screen.getByTestId(`eth-role-option-${name}-${role}`));
}

function checked(role: "uplink" | "shared-lan", name = "eth0"): string | null {
	return screen
		.getByTestId(`eth-role-option-${name}-${role}`)
		.getAttribute("aria-checked");
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

describe("explicit Shared LAN recovery", () => {
	it("stages Retry for unchanged addressless Shared LAN and sends it only on Save", async () => {
		open(iface({ ethRole: "shared-lan", ip: undefined, enabled: false }));
		await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(setEthernetRole).not.toHaveBeenCalled();
		expect(configure).not.toHaveBeenCalled();
		expect(
			screen.getByTestId("eth-role-recovery-staged-eth0").textContent,
		).toContain("Applies when you save");
		await save();
		await waitFor(() => expect(setEthernetRole).toHaveBeenCalledTimes(1));
		expect(setEthernetRole).toHaveBeenCalledWith({
			name: "eth0",
			role: "shared-lan",
		});
	});

	it("a late applied role cannot configure or close a reopened different port", async () => {
		const pending = deferred<{ success: true; applied: "shared-lan" }>();
		setEthernetRole.mockReturnValueOnce(pending.promise);
		const view = open();
		await stage("shared-lan");
		await save();
		await waitFor(() => expect(setEthernetRole).toHaveBeenCalledTimes(1));
		await view.rerender({ open: false, name: "eth0", iface: iface() });
		await view.rerender({
			open: true,
			name: "eth1",
			iface: iface({ ip: "192.0.2.10" }),
		});
		await act(() => {
			pending.resolve({ success: true, applied: "shared-lan" });
		});
		expect(configure).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog")).toBeTruthy();
	});
});

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
	const proto = window.Element.prototype as unknown as Record<string, unknown>;
	proto.hasPointerCapture ??= vi.fn(() => false);
	proto.setPointerCapture ??= vi.fn();
	proto.releasePointerCapture ??= vi.fn();
	proto.scrollIntoView ??= vi.fn();
});

beforeEach(() => {
	vi.clearAllMocks();
	streaming.value = false;
	roleSupport.value = false;
	setEthernetRole.mockResolvedValue({ success: true, applied: "shared-lan" });
	configure.mockResolvedValue({ success: true });
	initAsyncOperations();
});

afterEach(() => {
	destroyAsyncOperations();
	vi.restoreAllMocks();
});

describe("NetifDialog — the role control's offering", () => {
	it("offers BOTH roles, each with its own one-line consequence", () => {
		open();

		expect(checked("uplink")).toBe("true");
		expect(checked("shared-lan")).toBe("false");

		expect(
			screen.getByTestId("eth-role-consequence-eth0-uplink").textContent,
		).toContain("SRTLA bond");
		const sharedConsequence = screen.getByTestId(
			"eth-role-consequence-eth0-shared-lan",
		).textContent;
		expect(sharedConsequence).toContain("Leaves the SRTLA bond");
		expect(sharedConsequence).toContain("plugged into this port");
	});

	it("marks the shared-LAN rung selected when the device reports that role", () => {
		open(iface({ ethRole: "shared-lan", enabled: false, ip: "10.42.0.1" }));

		expect(checked("shared-lan")).toBe("true");
	});

	it("meets the 44px touch target on every rung", () => {
		open();
		for (const role of ["uplink", "shared-lan"]) {
			expect(
				screen.getByTestId(`eth-role-option-eth0-${role}`).className,
			).toContain("min-h-[var(--touch-target-min)]");
		}
	});

	it("renders NOTHING for a row the device published no role for", () => {
		// ABSENT is "not an ethernet port, or an older backend" — never `uplink`.
		open(iface({ ethRole: undefined }));
		expect(screen.queryByTestId("eth-role-selector")).toBeNull();
	});

	it("no longer claims the change takes effect right away", () => {
		open();
		expect(screen.getByTestId("eth-role-selector").textContent).not.toContain(
			"right away",
		);
	});
});

describe("NetifDialog — the role is STAGED until Save", () => {
	it("sends a fresh correlation ID on each supported dispatch and owns that target (#489)", async () => {
		roleSupport.value = true;
		const firstOp = "00".repeat(16);
		const secondOp = "ff".repeat(16);
		let sequence = 0;
		vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
			throw new Error("randomUUID requires a secure context");
		});
		const random = vi
			.spyOn(crypto, "getRandomValues")
			.mockImplementation((array) => {
				if (array instanceof Uint8Array) array.fill(sequence++ === 0 ? 0 : 255);
				return array;
			});
		setEthernetRole.mockResolvedValueOnce({
			success: false,
			error: "apply_failed",
		});
		open();
		await stage("shared-lan");
		await save();
		await screen.findByTestId("eth-role-error-eth0");
		expect(setEthernetRole).toHaveBeenNthCalledWith(1, {
			name: "eth0",
			role: "shared-lan",
			op: firstOp,
		});
		expect(getOperationTarget(KEY)).toEqual({
			name: "eth0",
			role: "shared-lan",
			op: firstOp,
		});
		await save();
		expect(setEthernetRole).toHaveBeenNthCalledWith(2, {
			name: "eth0",
			role: "shared-lan",
			op: secondOp,
		});
		expect(getOperationTarget(KEY)).toEqual({
			name: "eth0",
			role: "shared-lan",
			op: secondOp,
		});
		for (const [request] of setEthernetRole.mock.calls) {
			expect(setEthernetRoleInputSchema.parse(request)).toEqual(request);
		}
		random.mockRestore();
	});

	it("dispatches NOTHING when a rung is picked", async () => {
		open();

		await stage("shared-lan");

		expect(setEthernetRole).not.toHaveBeenCalled();
		expect(getOperationPhase(KEY)).toBe("idle");
	});

	it("moves the selection to the staged rung so the operator sees their pick", async () => {
		open();

		await stage("shared-lan");

		await waitFor(() => expect(checked("shared-lan")).toBe("true"));
		expect(checked("uplink")).toBe("false");
		expect(
			screen
				.getByTestId("eth-role-option-eth0-shared-lan")
				.getAttribute("data-staged"),
		).toBe("true");
	});

	it("dispatches EXACTLY ONE setEthernetRole on Save", async () => {
		open();

		await stage("shared-lan");
		await save();

		await waitFor(() => expect(setEthernetRole).toHaveBeenCalledTimes(1));
		expect(setEthernetRole).toHaveBeenCalledWith({
			name: "eth0",
			role: "shared-lan",
		});
	});

	it("stages the LAST pick only — re-picking never queues a second dispatch", async () => {
		open();

		await stage("shared-lan");
		await stage("uplink");
		await stage("shared-lan");
		await save();

		await waitFor(() => expect(setEthernetRole).toHaveBeenCalledTimes(1));
		expect(setEthernetRole).toHaveBeenCalledWith({
			name: "eth0",
			role: "shared-lan",
		});
	});

	it("dispatches NOTHING on Save when the staged role equals the applied one", async () => {
		open();

		await stage("shared-lan");
		await stage("uplink");
		await save();

		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		expect(setEthernetRole).not.toHaveBeenCalled();
	});

	it("dispatches NOTHING on Save when the role was never touched", async () => {
		open();

		await save();

		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		expect(setEthernetRole).not.toHaveBeenCalled();
	});

	it("stages the additive direction back to uplink the same way", async () => {
		open(iface({ ethRole: "shared-lan", enabled: false, ip: "10.42.0.1" }));

		await stage("uplink");
		expect(setEthernetRole).not.toHaveBeenCalled();

		await save();

		await waitFor(() => expect(setEthernetRole).toHaveBeenCalledTimes(1));
		expect(setEthernetRole).toHaveBeenCalledWith({
			name: "eth0",
			role: "uplink",
		});
	});

	it("applies the role BEFORE the bond toggle it governs", async () => {
		const order: string[] = [];
		setEthernetRole.mockImplementation(async () => {
			order.push("role");
			return { success: true, applied: "shared-lan" };
		});
		configure.mockImplementation(async () => {
			order.push("configure");
			return { success: true };
		});
		open();

		await stage("shared-lan");
		await save();

		await waitFor(() => expect(order).toEqual(["role", "configure"]));
	});

	it("a REFUSED role change stops the save instead of applying half of it", async () => {
		setEthernetRole.mockResolvedValueOnce({
			success: false,
			error: "apply_failed",
		});
		open();

		await stage("shared-lan");
		await save();

		await waitFor(() => expect(setEthernetRole).toHaveBeenCalledTimes(1));
		expect(configure).not.toHaveBeenCalled();
		const band = await screen.findByTestId("eth-role-error-eth0");
		expect(band.getAttribute("data-error")).toBe("apply_failed");
		expect(band.textContent).toContain(
			"Couldn't confirm the role change. The network profile may already have changed.",
		);
	});
});

describe("NetifDialog — the staged-change warning band", () => {
	it("renders ONLY when the staged role differs from the applied one", async () => {
		open();
		expect(screen.queryByTestId("eth-role-staged-eth0")).toBeNull();

		await stage("shared-lan");

		const band = await screen.findByTestId("eth-role-staged-eth0");
		expect(band.getAttribute("data-target")).toBe("shared-lan");
		expect(band.textContent).toContain("Applies when you save");
		expect(band.textContent).toContain("drop LAN connectivity to this device");
		expect(band.textContent).toContain("managing it through this port");
	});

	it("disappears again when the operator stages back to the applied role", async () => {
		open();

		await stage("shared-lan");
		await screen.findByTestId("eth-role-staged-eth0");
		await stage("uplink");

		await waitFor(() =>
			expect(screen.queryByTestId("eth-role-staged-eth0")).toBeNull(),
		);
	});

	it("warns in BOTH directions — leaving shared-LAN reconfigures the port too", async () => {
		open(iface({ ethRole: "shared-lan", enabled: false, ip: "10.42.0.1" }));

		await stage("uplink");

		const band = await screen.findByTestId("eth-role-staged-eth0");
		expect(band.getAttribute("data-target")).toBe("uplink");
	});

	it("adds the live-bond sentence when a bonded uplink is staged away mid-stream", async () => {
		streaming.value = true;
		open();

		await stage("shared-lan");

		const band = await screen.findByTestId("eth-role-staged-eth0");
		expect(band.getAttribute("data-consequence")).toBe("drops-bonded-uplink");
		expect(
			screen.getByTestId("eth-role-staged-consequence-eth0").textContent,
		).toContain("bonded stream traffic");
		expect(band.textContent).toContain("drop LAN connectivity to this device");
	});

	it("carries no live-bond sentence for a port that carries no bonded traffic", async () => {
		streaming.value = true;
		open(iface({ enabled: false }));

		await stage("shared-lan");

		const band = await screen.findByTestId("eth-role-staged-eth0");
		expect(band.getAttribute("data-consequence")).toBe("");
		expect(screen.queryByTestId("eth-role-staged-consequence-eth0")).toBeNull();
	});
});

describe("NetifDialog — Cancel discards the staged role", () => {
	it("dispatches nothing and drops the pick", async () => {
		const view = open();

		await stage("shared-lan");
		await screen.findByTestId("eth-role-staged-eth0");
		await cancel();

		expect(setEthernetRole).not.toHaveBeenCalled();
		expect(configure).not.toHaveBeenCalled();

		await view.rerender({ open: true, name: "eth0", iface: iface() });

		await waitFor(() => expect(checked("uplink")).toBe("true"));
		expect(screen.queryByTestId("eth-role-staged-eth0")).toBeNull();
	});
});

describe("NetifDialog — the DEVICE moves the control", () => {
	it("stays pending past the RPC and holds the PRIOR role on screen", async () => {
		open();
		await stage("shared-lan");
		await save();

		await waitFor(() => expect(setEthernetRole).toHaveBeenCalledTimes(1));
		// `setEthernetRole` resolving is not the device reaching the role — the
		// terminal `eth_role` frame is, and it has not arrived.
		await waitFor(() => expect(getOperationPhase(KEY)).toBe("pending"));
	});

	it("makes a transition dispatched from ANOTHER client visible", async () => {
		open();
		beginOperation(KEY, "shared-lan");

		expect(
			(await screen.findByTestId("eth-role-pending-eth0")).getAttribute(
				"data-target",
			),
		).toBe("shared-lan");
	});

	it("renders a typed refusal INLINE, with the prior role still selected", async () => {
		open();
		beginOperation(KEY, "shared-lan");
		failOperation(KEY, "apply_failed");

		const band = await screen.findByTestId("eth-role-error-eth0");
		expect(band.getAttribute("data-error")).toBe("apply_failed");
		expect(band.textContent).toContain(
			"Couldn't confirm the role change. The network profile may already have changed.",
		);
		expect(checked("uplink")).toBe("true");
	});

	it("never renders a machine token at the operator", async () => {
		open();
		beginOperation(KEY, "shared-lan");
		failOperation(KEY, "some_future_token");

		const band = await screen.findByTestId("eth-role-error-eth0");
		expect(band.textContent).not.toContain("some_future_token");
		expect(band.textContent).toContain(
			"Couldn't confirm the role change. Review this port's reported role and address before trying again.",
		);
	});

	it("carries an emulated-host refusal through the RPC reply", async () => {
		setEthernetRole.mockResolvedValueOnce({
			success: false,
			error: "unavailable_in_emulated_mode",
		});
		open();

		await stage("shared-lan");
		await save();

		// No frame is published for this refusal, so the RPC reply is the ONLY
		// settlement — a control that only listened to the broadcast would spin.
		const band = await screen.findByTestId("eth-role-error-eth0");
		expect(band.getAttribute("data-error")).toBe(
			"unavailable_in_emulated_mode",
		);
		expect(band.textContent).toContain("real hardware");
	});
});

type RoleReply = Awaited<ReturnType<typeof rpc.network.setEthernetRole>>;
type ConfigureReply = Awaited<ReturnType<typeof rpc.network.configure>>;
const shared = () =>
	iface({ ethRole: "shared-lan", enabled: false, ip: undefined });
const retry = () => screen.getByRole("button", { name: "Retry" });
const savePending = () =>
	screen.getByRole("button", { name: "Save" }).hasAttribute("disabled");
const outcomes = ["applied", "refusal", "rejection"] as const;

async function replyRole(
	pending: ReturnType<typeof deferred<RoleReply>>,
	outcome: (typeof outcomes)[number],
) {
	await act(() => {
		if (outcome === "rejection") pending.reject(new Error("lost role reply"));
		else
			pending.resolve(
				outcome === "applied"
					? { success: true, applied: "shared-lan" }
					: { success: false, error: "apply_failed" },
			);
	});
}

describe("one-shot Shared LAN recovery intent", () => {
	it("ordinary unchanged Shared LAN Save still sends no role request", async () => {
		open(shared());
		await save();
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		expect(setEthernetRole).not.toHaveBeenCalled();
	});

	it("Retry toggles a visible staged warning without a request", async () => {
		open(shared());
		expect(retry().getAttribute("aria-pressed")).toBe("false");
		expect(retry().className).toContain("min-h-[var(--touch-target-min)]");
		await fireEvent.click(retry());
		expect(retry().getAttribute("aria-pressed")).toBe("true");
		expect(
			screen.getByTestId("eth-role-recovery-staged-eth0").textContent,
		).toContain("managing it through this port");
		await fireEvent.click(retry());
		expect(screen.queryByTestId("eth-role-recovery-staged-eth0")).toBeNull();
		expect(setEthernetRole).not.toHaveBeenCalled();
		expect(configure).not.toHaveBeenCalled();
	});

	it("Cancel/reopen clears the one-shot request and ordinary Save remains ordinary", async () => {
		const view = open(shared());
		await fireEvent.click(retry());
		await cancel();
		expect(setEthernetRole).not.toHaveBeenCalled();
		await view.rerender({ open: true, name: "eth0", iface: shared() });
		expect(retry().getAttribute("aria-pressed")).toBe("false");
		await save();
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		expect(setEthernetRole).not.toHaveBeenCalled();
	});

	it("changing ports without closing drops the unsent recovery before ordinary Save", async () => {
		const view = open(shared());
		await fireEvent.click(retry());
		await view.rerender({ open: true, name: "eth1", iface: shared() });
		expect(retry().getAttribute("aria-pressed")).toBe("false");
		await save();
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		expect(configure).toHaveBeenCalledWith({
			name: "eth1",
			ip: undefined,
			enabled: false,
		});
		expect(setEthernetRole).not.toHaveBeenCalled();
	});

	it("selecting Uplink discards recovery even if the operator returns to Shared LAN", async () => {
		open(shared());
		await fireEvent.click(retry());
		await stage("uplink");
		expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
		await stage("shared-lan");
		expect(retry().getAttribute("aria-pressed")).toBe("false");
		await save();
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		expect(setEthernetRole).not.toHaveBeenCalled();
	});

	it.each(["role", "netif"] as const)(
		"a current same-port %s operation blocks Retry and Save",
		async (kind) => {
			open(shared());
			await act(() => {
				beginOperation(kind === "role" ? KEY : "netif:eth0");
			});
			expect(retry().hasAttribute("disabled")).toBe(true);
			await fireEvent.click(retry());
			await save();
			expect(setEthernetRole).not.toHaveBeenCalled();
			expect(configure).not.toHaveBeenCalled();
		},
	);

	it("another port's pending operations do not block this port", async () => {
		beginOperation(ethernetRoleOpKey("eth1"));
		beginOperation("netif:eth1");
		open(shared());
		expect(retry().hasAttribute("disabled")).toBe(false);
		await fireEvent.click(retry());
		await save();
		await waitFor(() => expect(setEthernetRole).toHaveBeenCalledTimes(1));
		expect(setEthernetRole).toHaveBeenCalledWith({
			name: "eth0",
			role: "shared-lan",
		});
	});

	it("recovery stays on Shared LAN while pending, guards double Save, and does not fabricate confirmation", async () => {
		const pending = deferred<RoleReply>();
		setEthernetRole.mockReturnValueOnce(pending.promise);
		open(shared());
		await fireEvent.click(retry());
		await save();
		await save();
		expect(setEthernetRole).toHaveBeenCalledTimes(1);
		expect(checked("shared-lan")).toBe("true");
		expect(checked("uplink")).toBe("false");
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(retry().hasAttribute("disabled")).toBe(true);
		await replyRole(pending, "applied");
		expect(getOperationPhase(KEY)).toBe("pending");
		confirmOperation(KEY);
		expect(getOperationPhase(KEY)).toBe("confirmed");
		expect(configure).toHaveBeenCalledTimes(1);
	});

	it.each(["refusal", "rejection"] as const)(
		"a current %s consumes recovery, stops configure, and needs a new explicit Retry",
		async (kind) => {
			const pending = deferred<RoleReply>();
			setEthernetRole.mockReturnValueOnce(pending.promise);
			open(shared());
			await fireEvent.click(retry());
			await save();
			await replyRole(pending, kind);
			expect(configure).not.toHaveBeenCalled();
			expect(savePending()).toBe(false);
			expect(screen.getByTestId("eth-role-error-eth0")).toBeTruthy();
			expect(retry().getAttribute("aria-pressed")).toBe("false");
			expect(screen.queryByTestId("eth-role-recovery-staged-eth0")).toBeNull();
			await save();
			await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
			expect(setEthernetRole).toHaveBeenCalledTimes(1);
		},
	);

	it("failure, timeout and confirmation observations never arm or dispatch recovery", async () => {
		open(shared());
		for (const phase of ["failure", "timeout", "confirmed"]) {
			await act(() => {
				beginOperation(KEY);
				if (phase === "failure") failOperation(KEY, "no_connection");
				else if (phase === "timeout") timeoutOperation(KEY);
				else confirmOperation(KEY);
			});
			expect(retry().getAttribute("aria-pressed")).toBe("false");
			expect(screen.queryByTestId("eth-role-recovery-staged-eth0")).toBeNull();
		}
		expect(setEthernetRole).not.toHaveBeenCalled();
		expect(configure).not.toHaveBeenCalled();
	});

	it("a row without role support has no recovery offering", () => {
		open(iface({ ethRole: undefined }));
		expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
	});
});

for (const replacement of ["eth0", "eth1"]) {
	describe(`deferred recovery ownership after reopen on ${replacement}`, () => {
		it.each(outcomes)(
			"late role A %s cannot alter pending B or configure its port",
			async (outcome) => {
				const a = deferred<RoleReply>(),
					b = deferred<RoleReply>();
				setEthernetRole
					.mockReturnValueOnce(a.promise)
					.mockReturnValueOnce(b.promise);
				const view = open(shared());
				await fireEvent.click(retry());
				await save();
				await waitFor(() => expect(setEthernetRole).toHaveBeenCalledTimes(1));
				await cancel();
				if (replacement === "eth0") timeoutOperation(KEY);
				await view.rerender({ open: true, name: replacement, iface: shared() });
				expect(savePending()).toBe(false);
				await fireEvent.click(retry());
				await save();
				await waitFor(() => expect(setEthernetRole).toHaveBeenCalledTimes(2));
				await replyRole(a, outcome);
				expect(configure).not.toHaveBeenCalled();
				expect(savePending()).toBe(true);
				expect(checked("shared-lan", replacement)).toBe("true");
				expect(retry().getAttribute("aria-pressed")).toBe("false");
				expect(getOperationPhase(ethernetRoleOpKey(replacement))).toBe(
					"pending",
				);
				expect(toast.success).not.toHaveBeenCalled();
				expect(toast.error).not.toHaveBeenCalled();
				confirmOperation(ethernetRoleOpKey(replacement));
				await replyRole(b, "applied");
				expect(configure).toHaveBeenCalledTimes(1);
				expect(configure).toHaveBeenCalledWith({
					name: replacement,
					ip: undefined,
					enabled: false,
				});
				await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
			},
		);

		it.each(outcomes)(
			"late configure A %s cannot close, unlock, report refusal or toast into B",
			async (outcome) => {
				const a = deferred<ConfigureReply>(),
					b = deferred<ConfigureReply>();
				configure.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
				const view = open(shared());
				await fireEvent.click(retry());
				await save();
				await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
				confirmOperation(KEY);
				await cancel();
				if (replacement === "eth0") timeoutOperation("netif:eth0");
				await view.rerender({ open: true, name: replacement, iface: shared() });
				await save();
				await waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
				await act(() => {
					if (outcome === "rejection")
						a.reject(new Error("lost configure reply"));
					else
						a.resolve(
							outcome === "applied"
								? { success: true }
								: { success: false, error: "stale_address" },
						);
				});
				expect(savePending()).toBe(true);
				expect(screen.queryByTestId("netif-save-error")).toBeNull();
				expect(toast.success).not.toHaveBeenCalled();
				expect(toast.error).not.toHaveBeenCalled();
				expect(retry().getAttribute("aria-pressed")).toBe("false");
				await act(() => {
					b.resolve({ success: true });
				});
				await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
				expect(configure).toHaveBeenCalledTimes(2);
				expect(setEthernetRole).toHaveBeenCalledTimes(1);
			},
		);
	});
}

describe("unmounted save lifetime", () => {
	it.each(outcomes)(
		"late role %s after unmount cannot dispatch configure or feedback",
		async (outcome) => {
			const a = deferred<RoleReply>();
			setEthernetRole.mockReturnValueOnce(a.promise);
			const view = open(shared());
			await fireEvent.click(retry());
			await save();
			await waitFor(() => expect(setEthernetRole).toHaveBeenCalledTimes(1));
			view.unmount();
			await replyRole(a, outcome);
			expect(configure).not.toHaveBeenCalled();
			expect(toast.success).not.toHaveBeenCalled();
			expect(toast.error).not.toHaveBeenCalled();
		},
	);
});
