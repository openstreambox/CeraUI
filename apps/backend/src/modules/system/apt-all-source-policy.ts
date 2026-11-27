import type { ImageAptSource } from "./image-apt-source.ts";

/**
 * The image's own source: exactly its URI, host and two suites, released as
 * OpenStreamBox. Its host is the origin shown; the URI (with its token) never is.
 */
function imageSourceOrigin(
	source: string,
	release: string,
	origin: string,
	image: ImageAptSource,
): string | null {
	const [uri, dist] = source.split(/\s+/);
	const suite = /(?:^|,)n=([^,]+)(?:,|$)/.exec(release)?.[1];
	return uri === image.uri &&
		origin === image.host &&
		suite !== undefined &&
		image.suites.includes(suite) &&
		dist === `${suite}/main` &&
		/(?:^|,)o=OpenStreamBox(?:,|$)/.test(release) &&
		/(?:^|,)l=OpenStreamBox(?:,|$)/.test(release)
		? image.host
		: null;
}

function sourceOrigin(
	source: string,
	release: string,
	origin: string,
): string | null {
	const url = /^https:\/\/\S+/.exec(source)?.[0];
	if (!url || !URL.canParse(url)) return null;
	const host = new URL(url).hostname;
	if (host !== origin) return null;
	if (
		host === "apt.ceralive.tv" &&
		/(?:^|,)o=CeraLive(?:,|$)/.test(release) &&
		/(?:^|,)l=CeraLive(?:,|$)/.test(release) &&
		/(?:^|,)n=(?:stable|beta)(?:,|$)/.test(release)
	)
		return host;
	const suite = /(?:^|,)n=(trixie(?:-updates|-security)?)(?:,|$)/.exec(
		release,
	)?.[1];
	if (
		(host === "deb.debian.org" || host === "security.debian.org") &&
		/(?:^|,)o=Debian(?:,|$)/.test(release) &&
		/(?:^|,)l=Debian(?:-Security)?(?:,|$)/.test(release) &&
		suite
	)
		return `Debian ${suite}`;
	return null;
}

/**
 * Each `apt-cache policy` package file and the origin it may install from, or
 * null. With `image` (an image that ships its own source) only that source is
 * an origin; every other one stays unknown.
 */
export function policySources(
	inventory: string,
	image?: ImageAptSource,
): Map<string, string | null> {
	const sources = new Map<string, string | null>();
	const lines = inventory.split("\n");
	if (lines[0] !== "Package files:") return sources;
	for (let i = 1; i < lines.length && lines[i] !== "Pinned packages:"; i++) {
		const source = /^\s*\d+\s+(https?:\/\/\S+\s+.+\s+Packages)\s*$/.exec(
			lines[i] ?? "",
		)?.[1];
		if (!source) continue;
		const release = /^\s+release\s+(.+)$/.exec(lines[i + 1] ?? "")?.[1];
		const origin = /^\s+origin\s+(\S+)\s*$/.exec(lines[i + 2] ?? "")?.[1];
		const allowed =
			release && origin
				? image
					? imageSourceOrigin(source, release, origin, image)
					: sourceOrigin(source, release, origin)
				: null;
		if (sources.has(source) && sources.get(source) !== allowed) {
			sources.set(source, null);
		} else if (!sources.has(source)) {
			sources.set(source, allowed);
		}
	}
	return sources;
}
