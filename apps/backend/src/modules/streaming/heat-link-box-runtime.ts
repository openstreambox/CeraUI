import { getCarryingLiveness } from "../system/carrying.ts";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";
import { updateHeatWifi } from "../wifi/heat-wifi-runtime.ts";
import { initialHeat } from "./heat-ladder.ts";
import { linkBoxHeatTick } from "./heat-link-box.ts";

let heat = initialHeat();
let published = "";
/** The client sender and per-client pause owners are not present on this base.
 * Until they supply path/client identity and capacity, never shed a used link
 * or stop the hotspot. The unused-radio owner still has its full admission. */
export function updateLinkBoxHeat(
	soc: number | null,
	now: number,
	encoder: boolean,
): boolean {
	const tick = linkBoxHeatTick(heat, soc, now, getCarryingLiveness(), encoder);
	heat = tick.heat;
	if (!tick.owned) {
		if (published) notificationRemove("link-box-heat");
		published = "";
		return false;
	}
	updateHeatWifi(
		heat.stage,
		tick.plan.usb || (!heat.unknown && heat.stage === 0),
	);
	const key = tick.key;
	if (key === published) return true;
	published = key;
	if (!key) {
		notificationRemove("link-box-heat");
		return true;
	}
	notificationBroadcast(
		"link-box-heat",
		"warning",
		key === "live.heat.warm"
			? "The box is warm. Give it air."
			: "The box is hot. Keeping the phone's links available while capacity is checked. Give it air.",
		0,
		true,
		false,
		true,
		key,
	);
	return true;
}
