import { lstatSync } from "node:fs";

/** The image's root-only runtime directory for the front door's private ingress. */
export const LOCAL_INGRESS_DIRECTORY = "/run/ceralive-button-ingress";

/**
 * True when the image's front door may be in use. Behind it, every client that
 * does not take the private ingress reaches the TCP listener from loopback, so
 * a loopback peer proves nothing about where the client is. Fails closed: any
 * answer other than "the directory does not exist" counts as present.
 */
export function localIngressPresent(
	directory = LOCAL_INGRESS_DIRECTORY,
): boolean {
	try {
		lstatSync(directory);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}
