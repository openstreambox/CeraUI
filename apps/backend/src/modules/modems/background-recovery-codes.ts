/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * The bounded values the held-back modem recovery lines carry, kept free of
 * imports so the support-bundle filter can allow exactly these and nothing
 * else (`support-log-filter.ts`).
 */

/** Which automatic recovery a line is about. */
export const BACKGROUND_RECOVERIES = [
	"data_session_reconnect",
	"ready_redial",
	"first_activation",
] as const;
export type BackgroundRecovery = (typeof BACKGROUND_RECOVERIES)[number];

/** Why the data-session reconnect leaves a dead path alone. */
export const DEAD_PATH_HELD = [
	"profile_not_owned",
	"native_path_answers",
	"carrying_stream_traffic",
	"stream_traffic_unknown",
	"session_not_connected",
	"modem_not_registered",
	"other",
] as const;
export type DeadPathHeld = (typeof DEAD_PATH_HELD)[number];

/** The lifecycle holder named beside a lease refusal (`none`: nobody). */
export const RECOVERY_LIFECYCLE_HOLDERS = [
	"streaming",
	"modem-transition",
	"none",
] as const;
