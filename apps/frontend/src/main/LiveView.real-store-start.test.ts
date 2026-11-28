// @vitest-environment jsdom
/**
 * A start whose reply a connection reset swallowed is settled ONLY by a
 * lifecycle the device delivered after the loss, on the link that is current
 * now (FIX-16-FRONT3 R1). A session restoration is not that evidence: the
 * reconnect hydrate can fail and still count as restored, leaving the
 * pre-reset snapshot in the store.
 *
 * Everything on the status path is real: the subscription store's handlers,
 * its reconnect re-authentication and hydrate, the session epoch, the optimism
 * and async-operation stores, LiveView with its real cockpits, band and header,
 * and (for the remount cases) the real NavigationRenderer. Only the transport,
 * the static device getters (config, sources, network) and heavy leaves are
 * scripted. Expectations are literal control lists and optimism states.
 */
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { flushSync } from "svelte";
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
	band,
	button,
	controls,
	installJsdomShims,
} from "../tests/fixtures/real-cockpit-harness";
import {
	dropLink,
	firstLink,
	push,
	restoreLink,
	type ScriptedTransport,
} from "../tests/fixtures/real-store-live";
import {
	publishNavigation,
	resetNavigationFeed,
} from "./navigation/__fixtures__/navigation-feed.svelte";

const transport = vi.hoisted(
	(): ScriptedTransport => ({
		message: undefined,
		connection: undefined,
		authenticated: false,
	}),
);
const savedAsrc = vi.hoisted((): { value: string | undefined } => ({
	value: undefined,
}));

vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));
vi.mock("svelte-sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
		dismiss: vi.fn(),
	},
}));
vi.mock("$lib/rpc/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/rpc/client")>()),
	rpc: {
		auth: { login: vi.fn(async () => ({ success: true })) },
		streaming: {
			start: vi.fn(),
			stop: vi.fn(),
			setConfig: vi.fn(),
			getConfig: vi.fn(async () => ({})),
		},
		status: { getStatus: vi.fn() },
	},
	rpcClient: (await import("../tests/fixtures/real-store-live")).rpcClientMock(
		transport,
	),
}));
vi.mock("$lib/rpc/subscriptions.svelte", async (importOriginal) => {
	const { deviceGettersMock } = await import(
		"../tests/fixtures/real-store-live"
	);
	const getters = await deviceGettersMock(
		await importOriginal<typeof import("$lib/rpc/subscriptions.svelte")>(),
	);
	return {
		...getters,
		getConfig: () => ({ ...getters.getConfig(), asrc: savedAsrc.value }),
	};
});
vi.mock("$lib/stores/auth-status.svelte", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/stores/auth-status.svelte")>()),
	authStatusStore: {
		get value() {
			return transport.authenticated;
		},
	},
}));
vi.mock("$lib/helpers/NetworkHelper", () => ({
	generateDeviceAccessQr: vi.fn(async () => ""),
}));
const noop = vi.hoisted(
	() => async () =>
		({ default: (await import("../tests/fixtures/Noop.svelte")).default }) as {
			default: unknown;
		},
);
vi.mock("$lib/components/preview/PreviewCanvas.svelte", noop);
vi.mock("$lib/components/custom/ComingSoon.svelte", noop);
vi.mock("$main/live/CapabilityTierBanner.svelte", noop);
vi.mock("$main/dialogs/ServerDialog.svelte", noop);
vi.mock("$main/dialogs/AudioDialog.svelte", noop);
vi.mock("$main/dialogs/EncoderDialog.svelte", noop);
// NavigationRenderer's own seams, as its test replaces them: no Web Animations
// in jsdom, no hash listener, every destination's namespaces already loaded.
vi.mock("$lib/transitions", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/transitions")>()),
	einkGatedFade: () => ({ duration: 0 }),
	einkGatedFly: () => ({ duration: 0 }),
}));
vi.mock("$lib/helpers/NavigationHelper", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/helpers/NavigationHelper")>()),
	setupHashNavigation: () => () => undefined,
}));
vi.mock("$lib/i18n/namespace-activation", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/i18n/namespace-activation")>()),
	areDestinationNamespacesLoaded: () => true,
	ensureDestinationNamespaces: async () => undefined,
}));
vi.mock("$lib/stores/navigation.svelte", async (importOriginal) => {
	const feed = await import("./navigation/__fixtures__/navigation-feed.svelte");
	const readable = <T>(value: T) => ({
		subscribe: (run: (v: T) => void) => {
			run(value);
			return () => {};
		},
	});
	return {
		...(await importOriginal<typeof import("$lib/stores/navigation.svelte")>()),
		getCurrentNavigation: feed.getCurrentNavigationFeed,
		isNavigationTransitioning: readable(false),
		navigationError: readable(null),
		transitionDirection: readable("forward" as const),
	};
});

import {
	destroyAsyncOperations,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import { ConnectionResetError, rpc } from "$lib/rpc/client";
import {
	destroyStreamingOptimism,
	getStreamingOptimismState,
} from "$lib/rpc/streaming-optimism.svelte";
import {
	getStatus,
	initSubscriptions,
	resetState,
} from "$lib/rpc/subscriptions.svelte";

import Noop from "../tests/fixtures/Noop.svelte";
import LiveView from "./LiveView.svelte";
import NavigationRenderer from "./navigation/NavigationRenderer.svelte";

const start = vi.mocked(rpc.streaming.start);
const getStatusRpc = vi.mocked(rpc.status.getStatus);

beforeAll(() => {
	installJsdomShims(vi.fn());
});

beforeEach(() => {
	vi.clearAllMocks();
	savedAsrc.value = undefined;
	localStorage.setItem("auth", "token-abc");
	resetState();
	initSubscriptions();
	initAsyncOperations();
	getStreamingOptimismState();
	resetNavigationFeed();
	firstLink(transport);
	push(transport, { is_streaming: false, stream_lifecycle: "idle" });
});

afterEach(() => {
	destroyAsyncOperations();
	destroyStreamingOptimism();
	dropLink(transport);
	localStorage.clear();
	document.body.innerHTML = "";
});

it("keeps the saved microphone visible when verification fails, cancels queued Start and lets the operator recheck", async () => {
	savedAsrc.value = "Old microphone";
	push(transport, { asrcs: ["Old microphone", "New microphone"] });
	const save = vi.mocked(rpc.streaming.setConfig);
	const reply = Promise.withResolvers<Awaited<ReturnType<typeof save>>>();
	save.mockReturnValueOnce(reply.promise);
	const { container } = render(LiveView);

	const picker = screen.getByRole("combobox", { name: "Old microphone" });
	await fireEvent.keyDown(picker, { key: "ArrowDown" });
	await fireEvent.pointerUp(
		await screen.findByRole("option", { name: "New microphone" }),
	);
	expect(save).toHaveBeenCalledExactlyOnceWith({
		asrc: "New microphone",
		audio_pick: true,
	});
	await fireEvent.click(button(container, "Start Stream"));
	await act(async () => {
		reply.resolve({
			success: false,
			error: "audio_source_probe_failed",
			applied: { asrc: "New microphone" },
		});
		await reply.promise;
	});

	const message =
		"Your choice was saved, but the microphone couldn't be verified for Start. Try again to recheck it.";
	await waitFor(() =>
		expect(button(container, "Start Stream").disabled).toBe(false),
	);
	expect({
		picker: screen.getByTestId("audio-source-select").textContent?.trim(),
		notice: screen.queryByText(message)?.textContent?.trim(),
	}).toEqual({ picker: "New microphone", notice: message });
	expect(toast.error).not.toHaveBeenCalled();
	expect(start).not.toHaveBeenCalled();

	save.mockResolvedValueOnce({
		success: true,
		applied: { asrc: "New microphone" },
	});
	await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
	expect(save.mock.calls).toEqual([
		[{ asrc: "New microphone", audio_pick: true }],
		[{ asrc: "New microphone", audio_pick: true }],
	]);
	expect(screen.queryByText(message)).toBeNull();
	expect(screen.getByTestId("audio-source-select").textContent?.trim()).toBe(
		"New microphone",
	);
	expect(start).not.toHaveBeenCalled();
});

/**
 * Press Start in the real idle cockpit; the socket then closes under the
 * request, rejecting it before the edge is reported, as `RPCClient.onclose` does.
 */
async function pressStartAndLoseReply(container: HTMLElement): Promise<void> {
	let lose!: (error: unknown) => void;
	start.mockReturnValueOnce(
		new Promise((_resolve, reject) => {
			lose = reject;
		}) as never,
	);
	await fireEvent.click(button(container, "Start Stream"));
	await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
	lose(new ConnectionResetError(["streaming", "start"]));
	dropLink(transport);
	await Promise.resolve();
	flushSync();
	expect(controls(container)).toEqual([
		{ label: "Starting...", disabled: true },
	]);
}

describe("R1: a lost start reply is settled only by current-link lifecycle evidence", () => {
	it("a failed status hydrate never settles a lost start", async () => {
		const { container } = render(LiveView);
		await pressStartAndLoseReply(container);

		// Re-authentication succeeds, the status hydrate FAILS: restored, but
		// the store still holds the pre-reset snapshot.
		await restoreLink(transport, getStatusRpc, { fails: true });
		expect(getStatus()?.stream_lifecycle).toBe("idle");
		expect(getStatus()?.is_streaming).toBe(false);

		expect(getStreamingOptimismState()).toBe("starting");
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Starting...", disabled: true },
		]);

		// A push on the new link that does not carry the lifecycle says nothing about it.
		push(transport, { is_streaming: false });
		expect(getStreamingOptimismState()).toBe("starting");

		// The device then delivers its idle lifecycle over the new link.
		push(transport, { stream_lifecycle: "idle" });
		expect(getStreamingOptimismState()).toBe("idle");
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
	});

	it("a hydrate that delivers idle settles the lost start", async () => {
		const { container } = render(LiveView);
		await pressStartAndLoseReply(container);

		await restoreLink(transport, getStatusRpc, {
			status: { is_streaming: false, stream_lifecycle: "idle" },
		});

		expect(getStreamingOptimismState()).toBe("idle");
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
	});

	it("a hydrate that delivers starting keeps Starting...", async () => {
		const { container } = render(LiveView);
		await pressStartAndLoseReply(container);

		await restoreLink(transport, getStatusRpc, {
			status: { is_streaming: false, stream_lifecycle: "starting" },
		});

		expect(getStreamingOptimismState()).toBe("starting");
		expect(controls(container)).toEqual([
			{ label: "Starting...", disabled: true },
		]);
	});
});

describe("the lost-reply record survives NavigationRenderer replacing the Live view", () => {
	function navigate(to: "live" | "network"): void {
		publishNavigation(
			to === "live"
				? { live: { component: LiveView } }
				: { network: { component: Noop } },
		);
		flushSync();
	}

	it("idle delivered while away settles the start on return", async () => {
		navigate("live");
		const { container } = render(NavigationRenderer);
		await pressStartAndLoseReply(container);

		navigate("network");
		await waitFor(() => expect(controls(container)).toEqual([]));
		await restoreLink(transport, getStatusRpc, {
			status: { is_streaming: false, stream_lifecycle: "idle" },
		});

		navigate("live");
		await waitFor(() => expect(getStreamingOptimismState()).toBe("idle"));
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
	});

	it("idle delivered on a link that dropped again is not current: Starting... stays", async () => {
		navigate("live");
		const { container } = render(NavigationRenderer);
		await pressStartAndLoseReply(container);

		navigate("network");
		await waitFor(() => expect(controls(container)).toEqual([]));
		await restoreLink(transport, getStatusRpc, {
			status: { is_streaming: false, stream_lifecycle: "idle" },
		});
		dropLink(transport);
		await restoreLink(transport, getStatusRpc, { fails: true });

		navigate("live");
		await waitFor(() =>
			expect(controls(container)).toEqual([
				{ label: "Starting...", disabled: true },
			]),
		);
		expect(getStreamingOptimismState()).toBe("starting");
	});
});
