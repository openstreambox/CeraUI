import {
	type DurableInverseRecord,
	parseDurableInverseRecord,
} from "../../helpers/durable-inverse.ts";
import {
	listPrivateStateKeys,
	type PrivateStateStore,
	readPrivateJson,
	readPrivateText,
} from "../../helpers/private-json-state.ts";
import {
	type CellularClatHostPlan,
	cellularClatHostSteps,
	parseCellularClatHostPlan,
} from "./cellular-clat-host-plan.ts";
import {
	cellularClatReceiptKey,
	parseCellularClatReceipt,
} from "./cellular-clat-receipt.ts";
import {
	type CellularClatBirthRecord,
	cellularClatBirthKey,
	parseCellularClatBirthRecord,
} from "./cellular-clat-session.ts";
import {
	type CellularNativeHostPlan,
	cellularNativeHostSteps,
	cellularUplinkSlotKey,
	parseCellularNativeHostPlan,
} from "./cellular-native-host-plan.ts";
import { planCellularRoutes } from "./cellular-route-plan.ts";
import { cellularTranslatorConfigKey } from "./cellular-translator.ts";
import { cellularTranslatorConfig } from "./cellular-translator-config.ts";

export type CellularHostAuthority =
	| {
			readonly kind: "native";
			readonly slot: number;
			readonly inverse: DurableInverseRecord<CellularNativeHostPlan>;
	  }
	| {
			readonly kind: "clat";
			readonly slot: number;
			readonly birth: CellularClatBirthRecord;
			readonly inverse?: DurableInverseRecord<CellularClatHostPlan>;
	  };

/** Complete private authority census, including auxiliary effect receipts and
 * translator configuration. Same schemas/step order as the actual owners;
 * misplaced records and orphan auxiliaries are retained and refuse recovery.
 * This reader never adopts kernel resources or repairs files.
 */
export async function inventoryCellularHosts(
	store: PrivateStateStore,
): Promise<readonly CellularHostAuthority[]> {
	try {
		const before = await listPrivateStateKeys(store),
			json = new Map<string, unknown>(),
			text = new Map<string, string>();
		for (const key of before.json) {
			const value = await readPrivateJson(store, key);
			if (value !== undefined) json.set(key, value);
		}
		for (const key of before.text) {
			const value = await readPrivateText(store, key);
			if (value !== undefined) text.set(key, value);
		}
		const remainingJson = new Set(json.keys()),
			remainingText = new Set(text.keys()),
			result: CellularHostAuthority[] = [];
		for (let slot = 1; slot <= 32; slot++) {
			const inverseKey = cellularUplinkSlotKey(slot),
				birthKey = cellularClatBirthKey(slot),
				rawInverse = json.get(inverseKey),
				rawBirth = json.get(birthKey);
			let inverse:
				| DurableInverseRecord<CellularNativeHostPlan | CellularClatHostPlan>
				| undefined;
			let translated = false;
			if (rawInverse !== undefined) {
				try {
					inverse = parseDurableInverseRecord(
						rawInverse,
						parseCellularNativeHostPlan,
						cellularNativeHostSteps,
					);
				} catch {
					inverse = parseDurableInverseRecord(
						rawInverse,
						parseCellularClatHostPlan,
						cellularClatHostSteps,
					);
					translated = true;
				}
				if (
					inverse.plan.input.slot !== slot ||
					inverse.owner !== inverse.plan.input.owner ||
					inverse.epoch !== inverse.plan.input.epoch
				)
					throw new Error("Cellular inverse slot identity changed");
				remainingJson.delete(inverseKey);
			}
			if (rawBirth === undefined) {
				if (translated) throw new Error("CLAT inverse has no retained birth");
				if (inverse)
					result.push({
						kind: "native",
						slot,
						inverse: inverse as DurableInverseRecord<CellularNativeHostPlan>,
					});
				continue;
			}
			const birth = parseCellularClatBirthRecord(rawBirth);
			if (birth.plan.input.slot !== slot || (inverse && !translated))
				throw new Error("Cellular birth slot identity changed");
			remainingJson.delete(birthKey);
			if (inverse) {
				if (
					!birth.childSubmitted ||
					!birth.tun ||
					JSON.stringify(
						parseCellularClatHostPlan({ ...birth.plan, tun: birth.tun }),
					) !== JSON.stringify(inverse.plan)
				)
					throw new Error("CLAT parent and child authority disagree");
				const plan = inverse.plan as CellularClatHostPlan,
					receiptKey = cellularClatReceiptKey(plan),
					configKey = cellularTranslatorConfigKey({
						slot: plan.input.slot,
						owner: plan.input.owner,
						epoch: plan.input.epoch,
						birth: plan.birth,
					}),
					receiptRaw = json.get(receiptKey),
					config = text.get(configKey),
					submitted = (step: string) =>
						inverse !== undefined &&
						inverse.cursor > inverse.steps.indexOf(step) &&
						inverse.steps.includes(step);
				if (receiptRaw !== undefined) {
					const receipt = parseCellularClatReceipt(receiptRaw, plan);
					if (
						!submitted("receipt") ||
						(inverse.phase !== "withdrawing" &&
							receipt.tunConfigurationStarted &&
							!submitted("tun-configuration")) ||
						(inverse.phase !== "withdrawing" &&
							receipt.translatorSubmitted &&
							!submitted("translator"))
					)
						throw new Error("CLAT receipt exceeds retained cursor");
					remainingJson.delete(receiptKey);
				}
				if (config !== undefined) {
					const routes = planCellularRoutes(plan.input);
					if (
						!submitted("configuration-file") ||
						receiptRaw === undefined ||
						!routes ||
						config !== cellularTranslatorConfig(routes)
					)
						throw new Error("CLAT configuration has no matching authority");
					remainingText.delete(configKey);
				}
			}
			result.push({
				kind: "clat",
				slot,
				birth,
				...(inverse
					? { inverse: inverse as DurableInverseRecord<CellularClatHostPlan> }
					: {}),
			});
		}
		if (remainingJson.size || remainingText.size)
			throw new Error("Unrecognized cellular host authority");
		// A same-key external replacement is not hidden by a stable filename census.
		for (const [key, value] of json)
			if (
				JSON.stringify(await readPrivateJson(store, key)) !==
				JSON.stringify(value)
			)
				throw new Error("Cellular host authority changed during inventory");
		for (const [key, value] of text)
			if ((await readPrivateText(store, key)) !== value)
				throw new Error("Cellular host configuration changed during inventory");
		if (
			JSON.stringify(before) !==
			JSON.stringify(await listPrivateStateKeys(store))
		)
			throw new Error("Cellular host inventory changed during recovery");
		return result;
	} catch (error) {
		store.readFault?.();
		throw error;
	}
}
