/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Packages the system image ships as its own reviewed builds. apt.ceralive.tv
 * may publish a different build under the same name; installing it would
 * replace the image's copy, so no package update is offered for these names.
 * A system image update is what moves them.
 */

import { logger } from "../../helpers/logger.ts";
import { APT_PACKAGE_NAME_RE } from "./apt-package-name.ts";
import {
	readStoredStateFile,
	STORED_STATE_LIMITS,
	StoredStateReadError,
} from "./update-orchestrator/stored-state-file.ts";

/**
 * Written by the image's app layer: one name+version pin per package the build
 * took from a reviewed local override instead of apt.ceralive.tv.
 */
export const IMAGE_LOCAL_OVERRIDE_PIN =
	"/etc/apt/preferences.d/ceralive-local-override";

/**
 * Images without the pin file record nothing on the box. These are the names
 * such images take from reviewed local builds.
 */
export const FALLBACK_IMAGE_OWNED_PACKAGES: readonly string[] = [
	"ceralive-device",
	"libmm-glib0",
	"modemmanager",
];

export type ImageOwnedPackages = {
	readonly names: ReadonlySet<string>;
	readonly source: "image-record" | "fallback";
};

const FIELD_RE = /^([A-Za-z][A-Za-z-]*):[ \t]*(.*?)[ \t]*$/;
// The forms the image writes: the installed copy, or its exact version.
const PIN_RELEASE_NOW = "release a=now";
const PIN_VERSION_PREFIX = "version ";
const DPKG_MAX_EPOCH = 2_147_483_647;

/**
 * A version as dpkg parses it: an optional numeric epoch up to the first
 * colon, the revision after the last hyphen (if any), and an upstream part
 * that starts with a digit.
 */
export function isDebianVersion(version: string): boolean {
	const colon = version.indexOf(":");
	let rest = version;
	if (colon !== -1) {
		const epoch = version.slice(0, colon);
		if (!/^[0-9]+$/.test(epoch) || Number(epoch) > DPKG_MAX_EPOCH) return false;
		rest = version.slice(colon + 1);
	}
	const hyphen = rest.lastIndexOf("-");
	if (hyphen !== -1 && !/^[A-Za-z0-9.+~]+$/.test(rest.slice(hyphen + 1)))
		return false;
	return /^[0-9][A-Za-z0-9.+~:-]*$/.test(
		hyphen === -1 ? rest : rest.slice(0, hyphen),
	);
}

function isImagePinForm(pin: string): boolean {
	return (
		pin === PIN_RELEASE_NOW ||
		(pin.startsWith(PIN_VERSION_PREFIX) &&
			isDebianVersion(pin.slice(PIN_VERSION_PREFIX.length)))
	);
}

// A pin that holds a package must outrank the apt.ceralive.tv origin pin, and
// APT ignores a priority beyond a signed 16-bit value.
const ORIGIN_PIN_PRIORITY = 990;
const APT_MAX_PIN_PRIORITY = 32_767;

/**
 * The package names an APT preferences file pins, or null when any stanza is
 * not a complete `Package`/`Pin`/`Pin-Priority` record in a form the image
 * writes (`release a=now` or `version <v>`, above the origin pin's 990). A file
 * with only comments pins nothing.
 */
export function parseLocalOverridePin(text: string): string[] | null {
	const names: string[] = [];
	for (const stanza of text.split(/\n[ \t]*\n/)) {
		const fields = new Map<string, string>();
		for (const line of stanza.split("\n")) {
			if (line.trim() === "" || line.startsWith("#")) continue;
			const match = FIELD_RE.exec(line);
			if (!match) return null;
			const key = (match[1] ?? "").toLowerCase();
			if (fields.has(key)) return null;
			fields.set(key, match[2] ?? "");
		}
		fields.delete("explanation");
		if (fields.size === 0) continue;
		const packages = fields.get("package")?.split(/\s+/) ?? [];
		if (
			fields.size !== 3 ||
			!isImagePinForm(fields.get("pin") ?? "") ||
			!/^\d+$/.test(fields.get("pin-priority") ?? "") ||
			Number(fields.get("pin-priority")) <= ORIGIN_PIN_PRIORITY ||
			Number(fields.get("pin-priority")) > APT_MAX_PIN_PRIORITY ||
			packages.length === 0 ||
			packages.some((name) => !APT_PACKAGE_NAME_RE.test(name))
		)
			return null;
		names.push(...packages);
	}
	return names;
}

type PinReader = (path: string) => Promise<string | null>;

const defaultReader: PinReader = (path) =>
	readStoredStateFile(path, STORED_STATE_LIMITS.settings);
let reader: PinReader = defaultReader;
let pinPath = IMAGE_LOCAL_OVERRIDE_PIN;
// The check runs every few hours; say each distinct problem once.
let reported: string | undefined;

export function setImageOwnedPackagesReaderForTest(
	next: PinReader | null,
	path: string | null = null,
): void {
	reader = next ?? defaultReader;
	pinPath = path ?? IMAGE_LOCAL_OVERRIDE_PIN;
	reported = undefined;
}

function fallback(problem: string | null): ImageOwnedPackages {
	if (problem !== null && reported !== problem) {
		reported = problem;
		logger.warn(
			"Image package record unusable; keeping the built-in image package list",
			{ path: pinPath, problem },
		);
	}
	return { names: new Set(FALLBACK_IMAGE_OWNED_PACKAGES), source: "fallback" };
}

/**
 * What the booted image ships itself: the names in its local-override pin when
 * the file is there and complete, else the built-in list.
 */
export async function readImageOwnedPackages(): Promise<ImageOwnedPackages> {
	let text: string | null;
	try {
		text = await reader(pinPath);
	} catch (error) {
		return fallback(
			error instanceof StoredStateReadError ? error.reason : "read_failed",
		);
	}
	if (text === null) return fallback(null);
	const names = parseLocalOverridePin(text);
	if (names === null) return fallback("malformed");
	reported = undefined;
	return { names: new Set(names), source: "image-record" };
}

/** Whether an apt name (`name` or `name:arch`) is one the image ships itself. */
export function isImageOwned(
	name: string,
	owned: ImageOwnedPackages["names"],
): boolean {
	return owned.has(name.split(":")[0] ?? name);
}
