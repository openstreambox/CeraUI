/** Runtime-free power copy; wire strings retain an English fallback for older clients. */
export const POWER_COPY = {
	unavailable: "Power data not available",
	available: "Power data available",
	temperature: "Temperature unavailable",
	estimate: " (estimate)",
	bankA: "Bank A",
	bankB: "Bank B",
	packLabel: "Reserve pack",
	feed: "The box remains powered.",
	low: "Power is weak. Check the banks.",
	reserve:
		"The banks stopped supplying power. The reserve pack keeps the box on.",
	redundancy: "Power has no confirmed backup bank. Check both banks.",
	warm: "The power board reports warmth. Give the box more airflow.",
	hot: "The power board reports heat. Improve airflow; let the reserve cool before charging.",
	critical:
		"The power board reports high heat. Check the banks and reserve pack now.",
	shutdownHeat:
		"The reserve pack is over its heat limit. The box is shutting down.",
	packWarm: "The reserve pack is warm. Give it more airflow.",
	packHot:
		"The reserve pack is hot. Improve airflow. Let it cool before charging.",
	packCritical:
		"The reserve pack is very hot. The box switches off if it gets hotter.",
	bankWarm: "Bank {bank} is warm. Give it more airflow.",
	bankHot: "Bank {bank} is hot. Improve airflow or swap it for a cool bank.",
	bankCritical:
		"Bank {bank} is very hot. Improve airflow or swap it for a cool bank.",
	replacement: "Connect the replacement before removing the only bank.",
	restingHot: "Bank {bank} is hot and resting.",
	restingWeak: "Bank {bank} is weak and resting.",
	resting: "Bank {bank} is resting.",
	peer: "Bank {bank} powers the box.",
	bench: "Power protection is in bench mode: it only reports.",
	protection: "The power board reports reduced protection. It needs a check.",
	calibration:
		"The reserve pack has no heat protection: its sensor is not set up.",
	shutdown:
		"The power board has requested a box shutdown. Power remains on until the shutdown completes.",
	permission:
		"Power data not available: permission to read the power board was denied.",
	busy: "Power data not available: the power board is busy with another reader.",
	openError:
		"Power data not available: the power board could not be opened (error {errno}).",
	persist:
		"The power service cannot remember this board across restarts. Readings continue; saving will be retried.",
	packProbe:
		"The reserve pack's temperature sensor is not working. The box will not switch off if the pack overheats.",
	aProbe: "Bank A's temperature sensor is not working. Protection is reduced.",
	bProbe: "Bank B's temperature sensor is not working. Protection is reduced.",
	blind:
		"The power board cannot read one of the banks. It will not shut the box down cleanly if power is lost.",
	noAlive:
		"The power board cannot see whether the computer is running. A shutdown will take 30 seconds.",
	shdn: "The power board cannot confirm the shutdown signal. It needs a check.",
	nvs: "The power board cannot save its shutdown record. It will retry.",
	wdt: "The power board watchdog is unavailable. It needs a check.",
	skip: "The power board has left out an unresponsive sensor. It needs a check.",
	loop: "The power board keeps restarting. It needs a check.",
	blindStart: "The box started without any working temperature sensor.",
	flaky:
		"The reserve pack's temperature sensor has a loose contact. It still protects the pack, more slowly. It needs a check.",
	sink: "The power board cannot talk to a bank's charger chip. That bank cannot start the box or rest.",
	unproven:
		"The power board cannot see a bank feeding the box. It will not switch off if the reserve pack overheats.",
	jump: "The reserve pack's temperature jumped suddenly. The sensor may be faulty. The box switches off in a minute if it stays this high.",
} as const;
export type PowerCopyKey = keyof typeof POWER_COPY;
export function powerText(
	key: PowerCopyKey,
	params: Record<string, string> = {},
): string {
	return POWER_COPY[key].replace(
		/\{(\w+)\}/g,
		(_, name: string) => params[name] ?? "?",
	);
}
/** Localize the bounded, known power vocabulary, leaving unknown future text intact. */
export function localizePowerText(
	text: string,
	translate: (
		key: string,
		params: Record<string, string>,
	) => string | undefined,
): string {
	const entries = Object.entries(POWER_COPY).sort(
		(a, b) => b[1].length - a[1].length,
	);
	// Match against the original input once, so translated strings cannot be translated again.
	const escapePattern = (s: string) =>
		Array.from(s)
			.map((c) => ("\\^$.*+?()[]{}|".includes(c) ? `\\${c}` : c))
			.join("");
	const patterns = entries.map(([key, value]) => {
		const names: string[] = [];
		const pattern = value
			.split(/(\{\w+\})/)
			.map((part) => {
				if (part.startsWith("{")) {
					names.push(part.slice(1, -1));
					return "([A-Za-z0-9]+)";
				}
				return escapePattern(part);
			})
			.join("");
		return { key, names, regex: new RegExp(`^(?:${pattern})`) };
	});
	let result = "";
	for (let i = 0; i < text.length; ) {
		const found = patterns
			.map((p) => ({ p, match: p.regex.exec(text.slice(i)) }))
			.find((x) => x.match);
		if (!found?.match) {
			result += text[i++];
			continue;
		}
		const params = Object.fromEntries(
			found.p.names.map((name, n) => [name, found.match?.[n + 1] ?? ""]),
		);
		result +=
			translate(`notifications.power.${found.p.key}`, params) ?? found.match[0];
		i += found.match[0].length;
	}
	return result;
}
