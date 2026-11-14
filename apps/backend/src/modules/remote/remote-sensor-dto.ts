/** Closed display vocabulary accepted at the remote sensor boundary. */
const POWER_PHRASES = [
	"Power data not available",
	"Power data available",
	"The box remains powered.",
	"Power is weak. Check the banks.",
	"The banks stopped supplying power. The reserve pack keeps the box on.",
	"Power has no confirmed backup bank. Check both banks.",
	"The power board reports warmth. Give the box more airflow.",
	"The power board reports heat. Improve airflow; let the reserve cool before charging.",
	"The power board reports high heat. Check the banks and reserve pack now.",
	"The reserve pack is over its heat limit. The box is shutting down.",
	"The reserve pack is warm. Give it more airflow.",
	"The reserve pack is hot. Improve airflow. Let it cool before charging.",
	"The reserve pack is very hot. The box switches off if it gets hotter.",
	"Bank {bank} is warm. Give it more airflow.",
	"Bank {bank} is hot. Improve airflow or swap it for a cool bank.",
	"Bank {bank} is very hot. Improve airflow or swap it for a cool bank.",
	"Connect the replacement before removing the only bank.",
	"Bank {bank} is hot and resting.",
	"Bank {bank} is weak and resting.",
	"Bank {bank} is resting.",
	"Bank {bank} powers the box.",
	"Power protection is in bench mode: it only reports.",
	"The power board reports reduced protection. It needs a check.",
	"The reserve pack has no heat protection: its sensor is not set up.",
	"The power board has requested a box shutdown. Power remains on until the shutdown completes.",
	"Power data not available: permission to read the power board was denied.",
	"Power data not available: the power board is busy with another reader.",
	"Power data not available: the power board could not be opened (error {errno}).",
	"The power service cannot remember this board across restarts. Readings continue; saving will be retried.",
	"The reserve pack's temperature sensor is not working. The box will not switch off if the pack overheats.",
	"Bank A's temperature sensor is not working. Protection is reduced.",
	"Bank B's temperature sensor is not working. Protection is reduced.",
	"The power board cannot read one of the banks. It will not shut the box down cleanly if power is lost.",
	"The power board cannot see whether the computer is running. A shutdown will take 30 seconds.",
	"The power board cannot confirm the shutdown signal. It needs a check.",
	"The power board cannot save its shutdown record. It will retry.",
	"The power board watchdog is unavailable. It needs a check.",
	"The power board has left out an unresponsive sensor. It needs a check.",
	"The power board keeps restarting. It needs a check.",
	"The box started without any working temperature sensor.",
	"The reserve pack's temperature sensor has a loose contact. It still protects the pack, more slowly. It needs a check.",
	"The power board cannot talk to a bank's charger chip. That bank cannot start the box or rest.",
	"The power board cannot see a bank feeding the box. It will not switch off if the reserve pack overheats.",
	"The reserve pack's temperature jumped suddenly. The sensor may be faulty. The box switches off in a minute if it stays this high.",
] as const;
const escapePhrase = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phrases = POWER_PHRASES.map(
	(value) =>
		new RegExp(
			"^(?:" +
				value
					.split(/(\{\w+\})/)
					.map((part) =>
						part === "{bank}"
							? "[AB]"
							: part === "{errno}"
								? "[A-Z0-9_-]{1,32}"
								: escapePhrase(part),
					)
					.join("") +
				")",
		),
).sort((a, b) => b.source.length - a.source.length);
export function isRemotePowerText(text: string): boolean {
	if (text.length === 0 || text.length > 8192) return false;
	let rest = text;
	while (rest.length > 0) {
		const match = phrases
			.map((p) => p.exec(rest)?.[0])
			.find((m) => m && m.length > 0);
		if (!match) return false;
		rest = rest.slice(match.length);
		if (rest.startsWith(" ")) rest = rest.slice(1);
	}
	return true;
}
export function projectRemoteSensors(
	input: Record<string, unknown>,
): Record<string, string> {
	const output: Record<string, string> = {};
	for (const [key, value] of Object.entries(input)) {
		if (typeof value !== "string") continue;
		if (
			key === "Power"
				? isRemotePowerText(value)
				: ["Bank A", "Bank B", "Reserve pack"].includes(key)
					? /^(?:-?\d+(?:\.\d+)? °C(?: \(estimate\))?|Temperature unavailable)$/.test(
							value,
						)
					: ["SoC temperature", "SoC voltage", "SoC current"].includes(key) &&
						(value === "unavailable" ||
							/^-?\d+(?:\.\d+)? (?:°C|V|A)$/.test(value))
		)
			output[key] = value;
	}
	if (!("SoC temperature" in output)) output["SoC temperature"] = "unavailable";
	return output;
}
