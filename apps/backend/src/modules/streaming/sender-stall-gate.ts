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

/*
  The sender's fast stall gate, a per-box setting (`srtla_fast_stall_gate`).

  The sender already skips a link that has packets in flight but no delivery
  proof, while another link can carry the traffic. Its defaults (32 packets in
  flight, up to 3,000 ms without proof) are rarely reached by a stream of a few
  hundred kbit/s: a radio that lost its access point keeps receiving originals
  until the link is removed some other way. With the setting on, the sender is
  started with 4 packets and 250 ms instead.

  Off is the default, and off adds no argument at all, so the argv is the one
  CeraUI has always used. The value is read when the sender starts; changing it
  applies at the next start. The sender never gates its last usable link, so a
  single-link stream is not affected either way.
*/

import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import { getConfig, saveConfig } from "../config.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";

type StallGateConfig = Pick<RuntimeConfig, "srtla_fast_stall_gate">;

/** Whether the next sender start carries the fast stall gate. Absent = off. */
export function isFastStallGateEnabled(
	config: StallGateConfig = getConfig(),
): boolean {
	return config.srtla_fast_stall_gate === true;
}

export interface FastStallGateDeps {
	readonly getConfig: () => RuntimeConfig;
	readonly saveConfig: () => void;
	readonly broadcast: (config: RuntimeConfig) => void;
}

const defaultDeps: FastStallGateDeps = {
	getConfig,
	saveConfig,
	broadcast: (config) => broadcastMsg("config", config),
};

/**
 * Persist the setting and announce the new config. Off removes the key, so a
 * box that never turned it on and one that turned it off again save the same
 * config. Returns the value now in effect for the next start.
 */
export function setFastStallGate(
	enabled: boolean,
	deps: FastStallGateDeps = defaultDeps,
): boolean {
	const config = deps.getConfig();
	const previous = config.srtla_fast_stall_gate;
	if (enabled) config.srtla_fast_stall_gate = true;
	else delete config.srtla_fast_stall_gate;
	try {
		deps.saveConfig();
	} catch (error) {
		if (previous === undefined) delete config.srtla_fast_stall_gate;
		else config.srtla_fast_stall_gate = previous;
		throw error;
	}
	deps.broadcast(config);
	return isFastStallGateEnabled(config);
}
