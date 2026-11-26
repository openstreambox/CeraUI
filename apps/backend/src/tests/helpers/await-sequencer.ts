/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Steps a flow through its waits, one at a time.
 *
 * Every fake a test gives the flow waits on `gate(label)` before it answers.
 * While the sequencer is armed, such a wait parks until the test releases it,
 * so the test stands at each wait of the flow in turn and can let something
 * else happen there. Unarmed, a gate passes at once, and so does a gate
 * reached from `outside()`: what the test lets happen at a wait (another
 * request, a tick) uses the same fakes and is not the flow being stepped.
 *
 * `record()` proves the list of waits complete: between two gates the flow may
 * only use microtasks. If it gets further by waiting for the event loop (a
 * file, a process, a timer no gate stands for), a wait exists that no test
 * could stand at, and `record()` throws naming the gate before it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

type Parked = {
	readonly label: string;
	readonly timer: boolean;
	readonly release: () => void;
};

/** Microtasks and next ticks only: nothing that needs the event loop runs. */
export async function settleMicrotasks(rounds = 8): Promise<void> {
	for (let round = 0; round < rounds; round++) {
		for (let turn = 0; turn < 400; turn++) await Promise.resolve();
		await new Promise<void>((resolve) => process.nextTick(resolve));
	}
}

/** Lets the event loop turn: timers and I/O completions run. */
export async function settleEventLoop(turns = 3): Promise<void> {
	for (let turn = 0; turn < turns; turn++)
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const GATE_LIMIT = 5_000;

export type AwaitSequencer = ReturnType<typeof createAwaitSequencer>;

export function createAwaitSequencer() {
	let armed = false;
	let gates = 0;
	let parked: Parked[] = [];
	const foreign = new AsyncLocalStorage<true>();
	const released: string[] = [];

	// Waits on I/O come first, in arrival order; a timer fires when nothing
	// else is left to answer, as it would after its delay.
	const next = (): Parked | undefined =>
		parked.find((wait) => !wait.timer) ?? parked[0];

	const sequencer = {
		arm(): void {
			armed = true;
		},
		/** Releases everything parked and lets later gates pass. */
		disarm(): void {
			armed = false;
			for (const wait of parked.splice(0)) wait.release();
		},
		armed: (): boolean => armed,
		/** Runs `work` as something other than the flow: its gates pass. */
		outside: <T>(work: () => T): T => foreign.run(true, work),
		/** Whether the caller runs inside `outside()`. */
		isOutside: (): boolean => foreign.getStore() === true,
		/** Starts the flow from within `outside()`: its gates park again. */
		inside: <T>(work: () => T): T => foreign.exit(work),
		/** A fake's wait. `timer` marks a wait on a delay rather than on I/O. */
		gate(label: string, options: { timer?: boolean } = {}): Promise<void> {
			// A flow that keeps coming back here is looping, not waiting.
			if (++gates > GATE_LIMIT)
				throw new Error(
					`"${label}": more than ${GATE_LIMIT} waits in one flow`,
				);
			if (!armed || foreign.getStore() === true) return Promise.resolve();
			return new Promise<void>((release) => {
				parked.push({ label, timer: options.timer === true, release });
			});
		},
		/** A parked timer was cancelled: it never fires. */
		cancel(label: string): void {
			parked = parked.filter((wait) => !(wait.timer && wait.label === label));
		},
		/** The wait `step()` would release next. */
		next: (): string | undefined => next()?.label,
		parked: (): string[] => parked.map((wait) => wait.label),
		/** The labels released so far, in order. */
		released: (): string[] => [...released],
		/** Releases the next parked wait. False when nothing is parked. */
		step(): boolean {
			const wait = next();
			if (wait === undefined) return false;
			parked = parked.filter((other) => other !== wait);
			released.push(wait.label);
			wait.release();
			return true;
		},
		/**
		 * Steps the flow until `until(label)` says the wait about to be released
		 * is the last one, releases that too, and returns every label in order.
		 * Throws when the flow needs the event loop between two gates.
		 */
		async record(until: (label: string) => boolean): Promise<string[]> {
			const labels: string[] = [];
			const after = () => labels.at(-1) ?? "the start";
			for (;;) {
				await settleMicrotasks();
				let wait = next();
				if (wait === undefined || wait.timer) {
					// Nothing but a delay is left to answer. Whatever still runs
					// must be waiting for the event loop, which no gate stands for.
					const before = parked.length;
					await settleEventLoop(wait === undefined ? 20 : 2);
					if (parked.length !== before || next() !== wait)
						throw new Error(
							`after "${after()}" the flow waited on something no gate stands for (next gate: "${sequencer.next()}")`,
						);
					if (wait === undefined)
						throw new Error(
							`the flow stopped after "${after()}" without reaching its last wait`,
						);
					wait = next();
				}
				if (labels.length >= 2_000)
					throw new Error(`the flow never reached its last wait (${after()})`);
				const label = (wait as Parked).label;
				labels.push(label);
				sequencer.step();
				if (until(label)) return labels;
			}
		},
		/** Steps `count` waits, microtasks only between them. */
		async advance(count: number): Promise<void> {
			for (let index = 0; index < count; index++) {
				await settleMicrotasks();
				if (!sequencer.step())
					throw new Error(`no wait is parked at step ${index} of ${count}`);
			}
			await settleMicrotasks();
		},
		/**
		 * Lets everything run to rest: releases each wait as it parks and lets
		 * the event loop turn, until nothing parks any more.
		 */
		async drain(): Promise<void> {
			let steps = 0;
			for (let idle = 0; idle < 4; ) {
				await settleMicrotasks(2);
				if (sequencer.step()) {
					idle = 0;
					if (++steps > GATE_LIMIT)
						throw new Error("the flow never came to rest");
				} else {
					await settleEventLoop(1);
					idle++;
				}
			}
		},
	};
	return sequencer;
}
