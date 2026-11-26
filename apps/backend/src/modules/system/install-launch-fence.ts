/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * The launch fence of a package install on an image with its own apt source.
 *
 * An attempt begins when a start is accepted and stays `pending` until one of
 * two things happens, both inside one serialized section: its unit is
 * submitted (`systemd-run` returned, or an uncertain submission was counted as
 * a launch), or the attempt ends (a stream, updates turned off, a refusal, a
 * failure). Stream admission, the settings recheck and the launcher all pass
 * through that section, so none of them sees an attempt between the two:
 * whoever enters first decides, and the other finds the decision made.
 *
 * Ownership follows from that. Everything an install does before launch (a
 * write, a command, a file, a routing rule) it does as the pending attempt:
 * `owns(attempt)` is the one question every such effect asks first, and an
 * attempt that ended, or that a newer one replaced, gets "no" for good.
 *
 * An ended attempt may still have a wait in flight. Until that has returned
 * (`hold` and its release), the attempt is `draining`: the updater is not free
 * for the next install yet, so what the old one left running cannot meet it.
 *
 * Free of this project's modules on purpose (but for the refusal's type): the
 * fence holds state and order, its callers bring the effects.
 */

import { OwnerEndedError } from "../../helpers/effect-owner.ts";

export type InstallAttemptState = "pending" | "ended" | "submitted";

export type InstallAttempt = {
	readonly id: number;
	readonly state: () => InstallAttemptState;
	/** Neither submitted nor ended: the only state in which it may go on. */
	readonly pending: () => boolean;
};

/**
 * What a stream start found.
 * - `none`: no attempt of this process (a reattached unit is `submitted`).
 * - `cancelled`: a pending attempt, ended now by this stream.
 * - `ended`: the attempt had ended before its unit launched already.
 * - `submitted`: the unit launched; the stream takes the post-launch path.
 */
export type StreamFenceVerdict = "none" | "cancelled" | "ended" | "submitted";

/**
 * The attempt ended before the launcher reached the section: nothing ran. It
 * is the owner-ended refusal of effect-owner.ts, so what recognises one stays
 * silent for the other.
 */
export class InstallAttemptEndedError extends OwnerEndedError {
	constructor() {
		super("the install's unit");
		this.message = "the install ended before its unit was submitted";
		this.name = "InstallAttemptEndedError";
	}
}

type Mutable = InstallAttempt & {
	value: InstallAttemptState;
	holds: number;
	/** `systemd-run` has been asked for and its outcome is not known yet. */
	submitting: boolean;
};

export type InstallLaunchFence = ReturnType<typeof createInstallLaunchFence>;

export function createInstallLaunchFence() {
	let sequence = 0;
	let current: Mutable | null = null;
	let section: Promise<void> = Promise.resolve();
	// Attempts with a wait still in flight, and who waits for the ended ones.
	const held = new Set<Mutable>();
	const waiters: (() => void)[] = [];
	const draining = (): boolean =>
		[...held].some((attempt) => attempt.value === "ended");
	const settle = (): void => {
		if (draining()) return;
		for (const resolve of waiters.splice(0)) resolve();
	};

	// One at a time, in arrival order; a failed entry does not block the next.
	const serialized = <T>(work: () => T | Promise<T>): Promise<T> => {
		const result = section.then(work);
		section = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	const create = (value: InstallAttemptState): Mutable => {
		const attempt: Mutable = {
			id: ++sequence,
			value,
			holds: 0,
			submitting: false,
			state: () => attempt.value,
			pending: () => attempt.value === "pending",
		};
		return attempt;
	};

	return {
		/**
		 * The attempt of an accepted start. A start that joins one still waiting
		 * to run (the delayed start) is that same attempt, never a second one.
		 */
		begin(): InstallAttempt {
			if (current?.value !== "pending") current = create("pending");
			return current;
		},
		/** The start was not accepted after all: there is no attempt. */
		drop(attempt: InstallAttempt): void {
			if (current === attempt && attempt.pending()) current = null;
		},
		/** A unit found running or finished (recovery): its result decides. */
		adopt(): void {
			current = create("submitted");
		},
		current: (): InstallAttempt | null => current,
		/**
		 * Whether `attempt` is the install in progress and may still act: the
		 * current attempt, neither ended nor submitted.
		 */
		owns: (attempt: InstallAttempt): boolean =>
			current === attempt && attempt.pending(),
		/**
		 * `attempt`'s submission is in flight: `systemd-run` was asked for and
		 * the section holds the decision. Nothing ends the attempt from outside
		 * now, and what the launcher does to learn the outcome (its second look
		 * for the unit) is not refused.
		 */
		submitting: (attempt: InstallAttempt): boolean =>
			current === attempt && (attempt as Mutable).submitting,
		/**
		 * `attempt` has a wait in flight until the returned release is called
		 * (once). Taken for the install's own run and for its launcher.
		 */
		hold(attempt: InstallAttempt): () => void {
			const owner = attempt as Mutable;
			owner.holds++;
			held.add(owner);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				if (--owner.holds === 0) held.delete(owner);
				settle();
			};
		},
		/** An attempt that ended still has a wait in flight. */
		draining,
		/** Resolves once no ended attempt has a wait in flight any more. */
		drained(): Promise<void> {
			if (!draining()) return Promise.resolve();
			return new Promise<void>((resolve) => {
				waiters.push(resolve);
			});
		},
		/** The current attempt's unit was submitted (or a unit was adopted). */
		launched: (): boolean => current?.value === "submitted",
		/**
		 * Ends a pending attempt. False when it is not the current pending one
		 * (ended already, submitted, or replaced): the caller then writes nothing.
		 */
		end(attempt: InstallAttempt): boolean {
			if (current !== attempt || !attempt.pending()) return false;
			current.value = "ended";
			return true;
		},
		/**
		 * The launcher's turn. `refusal` is read inside the section, right before
		 * `launch`: a reason ends the attempt (`refuse` publishes it) and nothing
		 * is submitted. `launch` resolving means submitted; rejecting means the
		 * unit was definitively not created, and `refused` publishes that end.
		 */
		submit<T>(
			attempt: InstallAttempt,
			steps: {
				readonly refusal: () => string | null;
				readonly refuse: (reason: string) => void;
				readonly launch: () => Promise<T>;
				readonly refused: (error: unknown) => void;
			},
		): Promise<T> {
			return serialized(async () => {
				const owner = current;
				if (owner === null || owner !== attempt || !owner.pending())
					throw new InstallAttemptEndedError();
				const reason = steps.refusal();
				if (reason !== null) {
					owner.value = "ended";
					steps.refuse(reason);
					throw new InstallAttemptEndedError();
				}
				owner.submitting = true;
				try {
					const result = await steps.launch();
					owner.value = "submitted";
					return result;
				} catch (error) {
					// The launch can find, at its own last look, that the attempt
					// has just ended: that end is published already.
					if (owner.value !== "ended") {
						owner.value = "ended";
						steps.refused(error);
					}
					throw error;
				} finally {
					owner.submitting = false;
				}
			});
		},
		/**
		 * A stream start's turn. A pending attempt ends here (`cancel` publishes
		 * it); one already decided is reported as it was decided.
		 */
		admitStream(cancel: () => void): Promise<StreamFenceVerdict> {
			return serialized(() => {
				if (current === null) return "none";
				if (current.value === "submitted") return "submitted";
				if (current.value === "ended") return "ended";
				current.value = "ended";
				cancel();
				return "cancelled";
			});
		},
		/** Test seam: forget the attempt. */
		reset(): void {
			current = null;
			section = Promise.resolve();
			held.clear();
			for (const resolve of waiters.splice(0)) resolve();
		},
	};
}
