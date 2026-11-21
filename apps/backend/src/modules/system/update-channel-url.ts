import { loadUpdateSettings } from "./update-settings.ts";
export const DEFAULT_UPDATE_CHANNEL_URL = "https://images.ceralive.tv";
export async function updateChannelUrl(): Promise<string> {
	return new URL(
		(await loadUpdateSettings()).channelUrl ?? DEFAULT_UPDATE_CHANNEL_URL,
	).href.replace(/\/$/, "");
}
