/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * Restart modem, the UI half: one flow for the whole cellular section.
 *
 * It is keyed by the modem's `stable_key`, never by its row id. A restarted
 * modem comes back under a NEW ModemManager index, so its row unmounts and a new
 * one mounts; state filed under the row id would vanish exactly when the
 * operator is waiting for it. The section renders the status from this flow, so
 * "Restarting…" stays on screen while the row is gone.
 *
 * The backend is the authority on every guard. The only one the UI shapes is the
 * only-link case: the first request goes out without `onlyLinkConfirmed`, and a
 * refusal of `only_link_live` turns into a second, explicit confirmation of that
 * cost rather than an error.
 */
import {
	type Modem,
	modemRestartQualification,
	type RestartModemInput,
	type RestartModemOutput,
	type RestartModemRefusal,
} from "@ceraui/rpc/schemas";

import { type LoadOutcome, loadWithinBound } from "./async-surface";

export type ModemRestartTarget = {
	readonly device: string;
	readonly stableKey: string;
	readonly name: string;
	readonly expectedSeconds: number;
};

export type ModemRestartPhase =
	| { readonly kind: "idle" }
	| {
			readonly kind: "confirm";
			readonly target: ModemRestartTarget;
			readonly streaming: boolean;
	  }
	| { readonly kind: "confirm-only-link"; readonly target: ModemRestartTarget }
	| {
			readonly kind: "restarting";
			readonly target: ModemRestartTarget;
			readonly startedAt: number;
	  }
	| {
			readonly kind: "result";
			readonly target: ModemRestartTarget;
			readonly result: RestartModemOutput;
	  }
	| {
			readonly kind: "refused";
			readonly target: ModemRestartTarget;
			readonly refusal: RestartModemRefusal;
			readonly retryAfterSeconds?: number;
	  }
	| { readonly kind: "no-answer"; readonly target: ModemRestartTarget };

/** What the row needs to offer the action; `undefined` when it must not be offered. */
export function restartTargetFor(
	device: string,
	modem: Pick<Modem, "model" | "stable_key">,
	name: string,
): ModemRestartTarget | undefined {
	const qualification = modemRestartQualification(modem.model);
	if (qualification === undefined || !modem.stable_key) return undefined;
	return {
		device,
		stableKey: modem.stable_key,
		name,
		expectedSeconds: qualification.expectedSeconds,
	};
}

export type ModemRestartCall = (
	input: RestartModemInput,
) => Promise<RestartModemOutput>;

export class ModemRestartFlow {
	phase = $state<ModemRestartPhase>({ kind: "idle" });

	constructor(
		private readonly call: ModemRestartCall,
		private readonly now: () => number = () => Date.now(),
		private readonly bounded: <T>(
			run: () => Promise<T>,
		) => Promise<LoadOutcome<T>> = (run) => loadWithinBound("restart", run),
	) {}

	/** Whether a restart is being confirmed or is running (one at a time). */
	get busy(): boolean {
		return this.phase.kind === "restarting";
	}

	/** The stable key the current phase is about, if any. */
	get stableKey(): string | undefined {
		return this.phase.kind === "idle" ? undefined : this.phase.target.stableKey;
	}

	ask(target: ModemRestartTarget, streaming: boolean): void {
		if (this.busy) return;
		this.phase = { kind: "confirm", target, streaming };
	}

	cancel(): void {
		if (
			this.phase.kind === "confirm" ||
			this.phase.kind === "confirm-only-link"
		)
			this.phase = { kind: "idle" };
	}

	dismiss(): void {
		if (!this.busy) this.phase = { kind: "idle" };
	}

	async confirm(): Promise<void> {
		const phase = this.phase;
		if (phase.kind !== "confirm" && phase.kind !== "confirm-only-link") return;
		const target = phase.target;
		const onlyLinkConfirmed = phase.kind === "confirm-only-link";
		this.phase = { kind: "restarting", target, startedAt: this.now() };
		const outcome = await this.bounded(() =>
			this.call({
				device: target.device,
				confirm: true,
				...(onlyLinkConfirmed ? { onlyLinkConfirmed: true } : {}),
			}),
		);
		if (outcome.phase !== "loaded") {
			this.phase = { kind: "no-answer", target };
			return;
		}
		const result = outcome.value;
		if (!result.started) {
			const refusal = result.refusal ?? "unknown_modem";
			if (refusal === "only_link_live" && !onlyLinkConfirmed) {
				this.phase = { kind: "confirm-only-link", target };
				return;
			}
			this.phase = {
				kind: "refused",
				target,
				refusal,
				...(result.retryAfterSeconds !== undefined
					? { retryAfterSeconds: result.retryAfterSeconds }
					: {}),
			};
			return;
		}
		this.phase = { kind: "result", target, result };
	}
}
