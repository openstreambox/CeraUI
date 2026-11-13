/*
    CeraUI - web UI for the CERALIVE project
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

import { getRecentLogLines, logger } from "../../helpers/logger.ts";
import { RunTimeoutError, run } from "../../helpers/run.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { getCarrierSupportSummary } from "../modems/modem-wire-producer.ts";
import type { MessageSocket } from "../ui/message-socket.ts";
import { notificationSend } from "../ui/notifications.ts";
import { buildMsg, getSocketSenderId } from "../ui/websocket-server.ts";
import { boundSupportJournal } from "./support-export.ts";

export interface LogResult {
	name: string;
	contents: string;
}

// Dev/CI hosts have no systemd journal: serve the in-memory ring buffer (the
// same backend records `journalctl -u ceralive.service` surfaces on a real
// device) so the observable-logs path works without hardware.
function buildMockJournal(service?: string): string {
	const header = service
		? `-- Logs begin for unit ${service} (CeraUI mock journal) --`
		: "-- Logs begin, full CeraUI system journal (mock) --";
	return [header, ...getRecentLogLines()].join("\n");
}

export async function getLog(
	conn: MessageSocket,
	service?: string,
): Promise<LogResult | undefined> {
	const senderId = getSocketSenderId(conn);
	// Argv-only: each token is a discrete element, so a `service` value can never
	// be re-parsed as shell syntax (no `sh -c`, so `;`/spaces/`$()` are inert).
	const args = [
		"--since=-7days",
		"--lines=10000",
		"--no-pager",
		"--output=short-iso",
	];
	let name = "ceralive_system_log.txt";

	if (service) {
		args.push("-u", service);
		name = `${service.replace("CeraLive", "ceralive")}_log.txt`;
	}

	const options = { maxBuffer: 10 * 1024 * 1024, timeout: 15000 };
	const fail = (error: unknown, fallback: boolean) => {
		// Classify locally; errors can contain raw stdout/stderr and must never leave.
		const message =
			error instanceof RunTimeoutError
				? fallback
					? "Log collection timed out for both history and current boot."
					: "Log collection timed out."
				: error instanceof Error &&
						/maxBuffer length exceeded/.test(error.message)
					? "Log collection exceeded the 10 MiB raw output limit."
					: fallback
						? "Failed to read the current-boot journal after history timed out."
						: "Failed to read the system journal.";
		notificationSend(conn, "log_error", "error", message, 10);
		logger.error(message);
	};
	let journal: string;
	let currentBootOnly = false;
	try {
		journal = shouldUseMocks()
			? buildMockJournal(service)
			: await run("journalctl", args, options);
	} catch (error) {
		if (!(error instanceof RunTimeoutError)) {
			fail(error, false);
			return undefined;
		}
		currentBootOnly = true;
		try {
			journal = await run("journalctl", ["-b", ...args], options);
		} catch (fallbackError) {
			fail(fallbackError, true);
			return undefined;
		}
	}
	let summary: string;
	try {
		summary = `Carrier support summary (current observations; APN and TAC only):\n${JSON.stringify(getCarrierSupportSummary())}`;
	} catch {
		summary =
			"Carrier support summary unavailable; journal evidence is included.";
		logger.warn("Carrier support summary unavailable during log export.");
	}
	const scope = currentBootOnly
		? "current boot only (history read timed out)"
		: "retained last 7 days";
	const contents = `Support log: ${scope}; newest 10000 entries; 15 s collection limit; 10 MiB raw limit; redacted journal clipped at 9 MiB; at most one current-boot retry (30 s total collection budget).\n${boundSupportJournal(journal)}\n\n${summary}`;
	try {
		conn.send(buildMsg("log", { name, contents }, senderId));
		return { name, contents };
	} catch {
		const message = "Failed to deliver the log download.";
		notificationSend(conn, "log_error", "error", message, 10);
		logger.error(message);
		return undefined;
	}
}
