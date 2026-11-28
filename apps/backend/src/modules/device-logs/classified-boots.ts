import type { DeviceEvent, LogBootInfo } from "@ceraui/rpc/schemas";
import { readEvents } from "../events/store.ts";
import { listBoots as listUnclassifiedBoots } from "./boots.ts";
import { classifyBoot } from "./shutdown-classifier.ts";
import { readShutdownWindow } from "./shutdown-window.ts";

const finished = new Map<string, Promise<ReturnType<typeof classifyBoot>>>();

/**
 * How one finished boot ended, from its journal tail, the next boot's head and
 * its stored events. A result is cached once the next boot is known, because
 * neither window can change after that.
 */
export async function classifyFinishedBoot(
	boot: Pick<LogBootInfo, "bootId" | "logsAvailable">,
	next: Pick<LogBootInfo, "bootId"> | undefined,
	events: readonly DeviceEvent[],
): Promise<ReturnType<typeof classifyBoot>> {
	let classification = finished.get(boot.bootId);
	if (!classification) {
		classification = (async () =>
			classifyBoot({
				isCurrent: false,
				tail: boot.logsAvailable
					? await readShutdownWindow(boot.bootId, "tail")
					: [],
				nextBootHead: next ? await readShutdownWindow(next.bootId, "head") : [],
				storeEvents: events.filter((event) => event.bootId === boot.bootId),
			}))();
		if (next) finished.set(boot.bootId, classification);
	}
	try {
		return await classification;
	} catch (error) {
		finished.delete(boot.bootId);
		throw error;
	}
}

/** Classified public boot list; the discovery module remains independently owned. */
export async function listBoots(): Promise<LogBootInfo[]> {
	const rows = await listUnclassifiedBoots();
	const events = readEvents();
	const journal = rows.filter((boot) => boot.logsAvailable);
	const result: LogBootInfo[] = [];
	for (const boot of rows) {
		if (boot.current) {
			result.push({ ...boot, shutdown: "current", evidence: [] });
			continue;
		}
		const next = journal[journal.indexOf(boot) - 1];
		const summary = await classifyFinishedBoot(boot, next, events);
		result.push({ ...boot, ...summary, evidence: [...summary.evidence] });
	}
	return result;
}
