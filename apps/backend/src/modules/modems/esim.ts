import { access } from "node:fs/promises";
import type {
	CapabilityEvidence,
	EsimOperationInput,
	EsimOperationOutput,
} from "@ceraui/rpc/schemas";
import {
	ESIM_OPERATION_BOUND_MS,
	esimOperationOutputSchema,
	parseEsimActivationCode,
} from "@ceraui/rpc/schemas";

import { runWithStdin } from "../../helpers/run.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { getConfig } from "../config.ts";
import { noteCapabilityEvidenceChanged } from "./capability-gates.ts";
import { withCapabilityModuleMutation } from "./capability-mutation.ts";
import { withJournaledModemMutation } from "./mutation-lease.ts";
import {
	defaultResolveIdentity,
	type ResolvedModemIdentity,
} from "./usb-mode-identity.ts";

export const ESIM_HELPER = "/usr/libexec/ceralive/esim-helper";
const evidence = new Map<string, CapabilityEvidence>();

export function esimEvidence(
	stableKey: string | undefined,
): CapabilityEvidence {
	return stableKey === undefined
		? "unknown"
		: (evidence.get(stableKey) ?? "unknown");
}

export interface EsimDeps {
	resolve(device: string): Promise<ResolvedModemIdentity | undefined>;
	available(): Promise<boolean>;
	execute(
		stableKey: string,
		input: EsimOperationInput,
	): Promise<EsimOperationOutput>;
}

const defaultDeps: EsimDeps = {
	resolve: defaultResolveIdentity,
	async available() {
		// Development mocks must never acquire a real modem's ports.
		if (shouldUseMocks()) return false;
		try {
			await access(ESIM_HELPER);
			await access("/etc/ceralive/esim-devices.json");
			return true;
		} catch {
			return false;
		}
	},
	async execute(stableKey, input) {
		const reply = await runWithStdin(
			ESIM_HELPER,
			[],
			JSON.stringify({ stableKey, ...input }),
			{
				timeout: ESIM_OPERATION_BOUND_MS - 10_000,
				maxBuffer: 64 * 1024,
			},
		);
		return esimOperationOutputSchema.parse(JSON.parse(reply));
	},
};

/** Even listing owns a journaled lease because direct APDU access inhibits the modem. */
export async function runEsimOperation(
	input: EsimOperationInput,
	deps: EsimDeps = defaultDeps,
): Promise<EsimOperationOutput> {
	if (getConfig().modem_capabilities?.esim !== true)
		return { success: false, error: "module_disabled" };
	if (
		input.action === "download" &&
		parseEsimActivationCode(input.activationCode)?.confirmationRequired &&
		!input.confirmationCode
	) {
		return { success: false, error: "confirmation_required" };
	}
	if (!(await deps.available()))
		return { success: false, error: "not_configured" };
	const identity = await deps.resolve(input.device);
	if (!identity) return { success: false, error: "identity_unresolved" };
	const preState = {
		vidPid: identity.vidPid,
		model: identity.model,
		firmwareRevision: identity.firmwareRevision,
		...(identity.currentMode === undefined
			? {}
			: { mode: identity.currentMode }),
	};
	const execute = async () => {
		let result: EsimOperationOutput;
		try {
			result = await deps.execute(identity.stableKey, input);
		} catch {
			// APDU errors can contain activation credentials. Keep them off the journal and wire.
			result = { success: false, error: "outcome_unknown" };
		}
		const confirmed = result.success || result.error !== "outcome_unknown";
		if (result.success) {
			const changed = evidence.get(identity.stableKey) !== "present";
			evidence.set(identity.stableKey, "present");
			if (changed) noteCapabilityEvidenceChanged();
		} else {
			evidence.delete(identity.stableKey);
			noteCapabilityEvidenceChanged();
		}
		return {
			confirmed,
			value: result,
			detail: "eSIM outcome requires inspection",
		};
	};
	const run = async (journal: { markExecuting(): Promise<void> }) => {
		await journal.markExecuting();
		return execute();
	};
	// The first explicit probe establishes capability. Subsequent writes use the shared capability gate.
	const outcome =
		input.action === "inspect"
			? await withJournaledModemMutation(
					identity.stableKey,
					"esim",
					preState,
					run,
				)
			: await withCapabilityModuleMutation(
					{
						module: "esim",
						stableKey: identity.stableKey,
						preState,
						implemented: ["esim"],
					},
					async ({ journal }) => {
						if (!journal) throw new Error("eSIM journal required");
						return run(journal);
					},
				);
	return outcome.ok
		? outcome.value
		: { success: false, error: outcome.refusal };
}
