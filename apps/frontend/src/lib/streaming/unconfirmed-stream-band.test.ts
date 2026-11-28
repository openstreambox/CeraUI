/**
 * unconfirmedStreamBandShown: the one answer the band and the Start bar share.
 * Beyond the device's reconciling/stop_failed state, it keeps the band up while
 * the operator's own Stop is unresolved and while a lost Start reply could not
 * be recovered for the current attempt.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearOperation } from "$lib/rpc/async-operation.svelte";
import {
	destroyStreamingOptimism,
	getStreamingAttemptGeneration,
} from "$lib/rpc/streaming-optimism.svelte";
import { UNCONFIRMED_STOP_OPERATION } from "./unconfirmed-stream";
import { unconfirmedStreamBandShown } from "./unconfirmed-stream-band.svelte";
import {
	claimOperatorStop,
	clearStartRecoveryUnknown,
	noteStartRecoveryUnknown,
	ownStartAttempt,
	settleOperatorStop,
} from "./unresolved-stream-actions.svelte";

const settledIdle = {
	lifecycle: "idle",
	isStreaming: false,
	optimismState: "idle",
} as const;

beforeEach(() => {
	destroyStreamingOptimism();
	clearOperation(UNCONFIRMED_STOP_OPERATION);
});

afterEach(() => {
	destroyStreamingOptimism();
});

describe("unconfirmedStreamBandShown", () => {
	it("a settled idle device with nothing unresolved: no band", () => {
		expect(unconfirmedStreamBandShown(settledIdle)).toBe(false);
	});

	it("keeps the band while the operator's Stop is unresolved, until it settles", () => {
		const owner = claimOperatorStop();
		expect(unconfirmedStreamBandShown(settledIdle)).toBe(true);

		expect(settleOperatorStop(owner)).toBe(true);
		expect(unconfirmedStreamBandShown(settledIdle)).toBe(false);
	});

	it("keeps the band while the current attempt's lost Start could not be recovered", () => {
		const generation = getStreamingAttemptGeneration();
		ownStartAttempt(generation);
		noteStartRecoveryUnknown(generation);
		expect(unconfirmedStreamBandShown(settledIdle)).toBe(true);

		clearStartRecoveryUnknown(generation);
		expect(unconfirmedStreamBandShown(settledIdle)).toBe(false);
	});

	it("an unrecovered Start of another attempt does not count", () => {
		const other = getStreamingAttemptGeneration() + 1;
		ownStartAttempt(other);
		noteStartRecoveryUnknown(other);
		expect(unconfirmedStreamBandShown(settledIdle)).toBe(false);
	});

	it("a live stream hides it, whatever is unresolved", () => {
		claimOperatorStop();
		const generation = getStreamingAttemptGeneration();
		ownStartAttempt(generation);
		noteStartRecoveryUnknown(generation);
		expect(
			unconfirmedStreamBandShown({
				lifecycle: "streaming",
				isStreaming: true,
				optimismState: "idle",
			}),
		).toBe(false);
	});
});
