import type { BoxSample, LinkBoxHeatSession } from "./heat-link-box-share.ts";

/** Preferences do not activate traffic control. A measured session owner and
 * qualified action adapter must be supplied separately. Production supplies none. */
export function createHeatSettings(
	read: () => { heat_pause_mode?: "auto" | "suggest" | undefined },
	save: () => void,
	owner?: { session: LinkBoxHeatSession; read: () => BoxSample },
) {
	const mode = () => read().heat_pause_mode ?? ("auto" as const);
	const sample = () => {
		if (!owner) throw new Error("No measured session");
		return { ...owner.read(), pauseMode: mode() };
	};
	const get = () => ({
		mode: mode(),
		active: !!owner,
		...(owner ? owner.session.inspect(sample()) : {}),
	});
	return {
		get,
		update: () => owner?.session.update(sample),
		async action(action: "pause" | "restore", id: string) {
			if (!owner) return false;
			if (action === "pause") {
				if (get().suggestion !== id) return false;
				const result = await owner.session.pauseSuggested(id, sample);
				return result.pause.includes(id);
			}
			if (get().paused !== id) return false;
			owner.session.letBackOn(id);
			const result = await owner.session.update(sample);
			return !result.pause.includes(id);
		},
		set(next: "auto" | "suggest") {
			const config = read();
			const previous = config.heat_pause_mode;
			config.heat_pause_mode = next;
			try {
				save();
			} catch {
				if (previous === undefined) delete config.heat_pause_mode;
				else config.heat_pause_mode = previous;
				return { success: false, mode: mode() };
			}
			return { success: true, mode: mode() };
		},
	};
}
