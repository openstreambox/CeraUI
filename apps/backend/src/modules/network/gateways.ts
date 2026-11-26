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

import type { EffectOwner } from "../../helpers/effect-owner.ts";
import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import { getms } from "../../helpers/time.ts";
import { emitEvent } from "../events/emit.ts";
import { hasCapability } from "../system/board-capabilities.ts";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";
import {
	decideConnectivityClaim,
	deviceBoundProbeExclusionReason,
	eligibleProbeCandidates,
	type ProbeCandidate,
	probeExclusionReason,
} from "./connectivity-candidates.ts";
import {
	type ConnectivityProbes,
	defaultConnectivityProbes,
	electConnectivityCandidate,
	logConnectivityElection,
	raceConnectivityAddresses,
} from "./connectivity-election.ts";
import type {
	DefaultRouteAdmission,
	DefaultRouteReleaseCondition,
} from "./default-route.ts";
import { dnsCacheResolve, dnsCacheValidate } from "./dns.ts";
import { resolveDefaultRouteInterface } from "./gateway-default-interface.ts";
import { recoverNaturalGateway } from "./gateway-natural-recovery.ts";
import { gatewayRoutePreference } from "./gateway-route-lifecycle.ts";
import { CONNECTIVITY_CHECK_DOMAIN, checkConnectivity } from "./internet.ts";
import { naturalUplinkRecovery } from "./natural-uplink-recovery.ts";
import { getNetworkInterfaces } from "./network-interfaces.ts";
import { isUplinkClientSteeringEligible } from "./uplink-health/state.ts";

export {
	buildRouteAddArgv,
	GatewayRouteError,
	type GwDeps,
	parseDefaultRouteLine,
	setDefaultRoute,
} from "./default-route.ts";

export const UPDATE_GW_INT = 2000;

export const NO_INTERNET_NOTIFICATION = "no_internet";

let internetReachable = true;
function recordInternetConnectivity(reachable: boolean): void {
	if (reachable === internetReachable) return;
	internetReachable = reachable;
	emitEvent(reachable ? "internet_restored" : "internet_lost", {});
}

let updateGwInFlight: Promise<boolean> | undefined;
// Who asked for the election in flight. The network module's own runs ask for
// nobody in particular (`unowned`); a package install asks as itself.
let updateGwRequesters: { unowned: boolean; owners: EffectOwner[] } = {
	unowned: false,
	owners: [],
};

function noteGwRequester(owner: EffectOwner | undefined): void {
	if (owner) updateGwRequesters.owners.push(owner);
	else updateGwRequesters.unowned = true;
}

/**
 * Whether anybody still wants the election's route write: false only when
 * every requester is an owner that has ended. One unowned requester, or one
 * owner still alive, keeps it wanted.
 */
function gwRouteWriteWanted(): boolean {
	return (
		updateGwRequesters.unowned ||
		updateGwRequesters.owners.some((owner) => !owner.ended())
	);
}
let updateGwLastRun = 0;
let updateGwQueue = true;

export function queueUpdateGw() {
	updateGwQueue = true;
	void updateGwWrapper();
}

export type GatewayElectionDeps = {
	readonly canRouteClients: () => Promise<boolean>;
	readonly resolve: () => ReturnType<typeof dnsCacheResolve>;
	readonly validateDns: () => void;
	readonly checkConnectivity: typeof checkConnectivity;
	readonly interfaces: typeof getNetworkInterfaces;
	readonly eligible: (ifname: string) => boolean;
	readonly defaultInterface: typeof resolveDefaultRouteInterface;
	readonly installRoute: (
		ifname: string,
		family: 4 | 6,
		admit?: DefaultRouteAdmission,
	) => Promise<void>;
	readonly releaseRoutes?: (
		condition?: DefaultRouteReleaseCondition,
		admit?: DefaultRouteAdmission,
	) => Promise<void>;
	readonly probes: ConnectivityProbes;
	readonly routeRunner?: typeof run;
	readonly now?: () => number;
};

function defaultGatewayElectionDeps(): GatewayElectionDeps {
	return {
		canRouteClients: () => hasCapability("client-internet"),
		resolve: () => dnsCacheResolve(CONNECTIVITY_CHECK_DOMAIN),
		validateDns: () => {
			void dnsCacheValidate(CONNECTIVITY_CHECK_DOMAIN);
		},
		checkConnectivity,
		interfaces: getNetworkInterfaces,
		eligible: isUplinkClientSteeringEligible,
		defaultInterface: resolveDefaultRouteInterface,
		installRoute: (ifname, family, admit) =>
			gatewayRoutePreference.apply(ifname, family, admit),
		releaseRoutes: (condition, admit) =>
			condition
				? gatewayRoutePreference.release(condition, admit)
				: gatewayRoutePreference.apply(undefined, 4, admit),
		probes: defaultConnectivityProbes,
		routeRunner: run,
	};
}

function candidateRosterIdentity(
	candidates: readonly ProbeCandidate[],
): string {
	return JSON.stringify(
		candidates
			.map(({ name, ip, binding }) =>
				JSON.stringify([
					name,
					ip,
					binding.kind,
					binding.kind === "device" ? binding.ifname : binding.ip,
				]),
			)
			.sort(),
	);
}

export async function updateGw(
	deps: GatewayElectionDeps = defaultGatewayElectionDeps(),
	// Asked right before a route is written or released. The election is the
	// host's own and shared by its callers, so it is never refused for one of
	// them: it only leaves the route alone when nobody is left who wanted it.
	routeWriteWanted: () => boolean = () => true,
): Promise<boolean> {
	if (!(await deps.canRouteClients())) return true;
	let addrs: Array<string> = [];
	let fromCache = false;
	try {
		const resolveResult = await deps.resolve();
		addrs = resolveResult.addrs;
		fromCache = resolveResult.fromCache;
	} catch (err) {
		logger.warn(`Failed to resolve ${CONNECTIVITY_CHECK_DOMAIN}: ${err}`);
	}

	const defaultObservation = await raceConnectivityAddresses(
		addrs,
		deps.checkConnectivity,
	).catch((error: unknown) => {
		if (!(error instanceof AggregateError)) throw error;
		logger.warn("Default-route connectivity observation unavailable", {
			error,
		});
		return "unknown" as const;
	});
	const defaultReachable = defaultObservation === true;
	if (defaultReachable) {
		if (!fromCache) deps.validateDns();

		logger.info("Internet reachable via the default route");
		recordInternetConnectivity(true);
		notificationRemove(NO_INTERNET_NOTIFICATION);
	}

	const netif = deps.interfaces();
	const candidates = eligibleProbeCandidates(netif).filter((candidate) =>
		deps.eligible(candidate.name),
	);
	// Capture values before the awaits; the underlying netif records may mutate.
	const capturedRoster = candidateRosterIdentity(candidates);
	const currentRoster: DefaultRouteAdmission = () =>
		candidateRosterIdentity(
			eligibleProbeCandidates(deps.interfaces()).filter((candidate) =>
				deps.eligible(candidate.name),
			),
		) === capturedRoster;

	const defaultIf = await deps.defaultInterface(4);
	const recovery = await recoverNaturalGateway(deps, candidates);
	if (recovery !== undefined) {
		if (recovery) {
			recordInternetConnectivity(true);
			notificationRemove(NO_INTERNET_NOTIFICATION);
		}
		return recovery;
	}
	// Keep the current default ahead of equal-ranked peers to avoid route churn.
	candidates.sort(
		(a, b) => Number(b.name === defaultIf) - Number(a.name === defaultIf),
	);
	const claim = decideConnectivityClaim({
		candidateCount: candidates.length,
		defaultIfname: defaultIf,
		defaultExclusionReason: defaultIf
			? probeExclusionReason(netif[defaultIf])
			: undefined,
	});

	if (claim.kind === "suppressed") {
		logger.info(
			`Default route is on ${claim.ifname} (${claim.reason}) — not a connectivity verdict; re-electing from ${candidates.length} eligible interface(s)`,
		);
	} else if (!defaultReachable) {
		recordInternetConnectivity(false);
		notificationBroadcast(
			NO_INTERNET_NOTIFICATION,
			"warning",
			claim.message,
			10,
			true,
			false,
		);
	}

	for (const name in netif) {
		const reason = deviceBoundProbeExclusionReason(netif[name]);
		if (reason) {
			logger.warn(
				`Not probing internet connectivity via ${name} (${netif[name]?.ip}): ${reason}`,
			);
		}
	}

	const election = await electConnectivityCandidate(
		addrs,
		candidates,
		deps.probes,
	);
	// Also carried to the owner's first mutation; neither sampled check is a lease.
	if (!currentRoster()) {
		logger.info(
			"Gateway candidates changed during probing; withholding result",
		);
		return false;
	}
	logConnectivityElection(election);

	const goodIf = election.elected?.name;

	// Every requester was an install that has ended: no route is written or
	// released for it. A failed result queues the election again, so the
	// network module's next pass does it for the host.
	if (!routeWriteWanted()) return false;

	if (goodIf) {
		try {
			const family = election.family ?? 4;
			await deps.installRoute(goodIf, family, currentRoster);
			if (deps.routeRunner)
				await naturalUplinkRecovery(deps.routeRunner).observeOwnership();
		} catch (err) {
			logger.warn("Default-route application failed", {
				ifname: goodIf,
				error: err,
			});
			return false;
		}
		if (!fromCache && addrs.length > 0) deps.validateDns();
		recordInternetConnectivity(true);
		notificationRemove(NO_INTERNET_NOTIFICATION);
		if (
			election.results.find(({ candidate }) => candidate.name === goodIf)
				?.repository.used === "none"
		) {
			logger.warn(
				"Using connectivity-only host uplink; repository HTTPS unavailable",
				{ ifname: goodIf },
			);
		}

		return true;
	}

	// Deliberately NO notification here: the withheld claim stays withheld. A
	// failed candidate probe is not evidence — it steers by source address, which
	// selects a route only where the kernel supports policy routing (see
	// ConnectivityClaim). Log it so the state is still diagnosable.
	if (claim.kind === "suppressed") {
		logger.warn(
			`No eligible interface answered the connectivity check while the default route sits on ${claim.ifname} (${claim.reason}); not claiming the device is offline`,
		);
	}

	if (
		defaultObservation === "unknown" ||
		election.results.some(
			({ repository }) =>
				repository.ipv4 === "unknown" || repository.ipv6 === "unknown",
		)
	) {
		return false;
	}
	try {
		await deps.releaseRoutes?.(undefined, currentRoster);
	} catch (error) {
		logger.warn("Default-route release failed", { error });
		return false;
	}
	return defaultReachable;
}

/**
 * `owner` is the caller the election is asked for (a package install on an
 * image with its own apt source); the network module passes none. The run in
 * flight is shared: joining it adds the caller to those who want its result.
 */
export function updateGwWrapper(
	force = false,
	deps: GatewayElectionDeps = defaultGatewayElectionDeps(),
	owner?: EffectOwner,
): Promise<boolean> {
	if (updateGwInFlight) {
		noteGwRequester(owner);
		return updateGwInFlight;
	}
	// Do nothing if no request is queued
	if (!force && !updateGwQueue) return Promise.resolve(false);

	// Rate limit
	const ts = getms();
	const to = updateGwLastRun + UPDATE_GW_INT;
	if (!force && ts < to) return Promise.resolve(false);

	// Proceeding, update status
	updateGwLastRun = ts;
	updateGwQueue = false;
	updateGwRequesters = { unowned: false, owners: [] };
	noteGwRequester(owner);

	updateGwInFlight = updateGw(deps, gwRouteWriteWanted)
		.catch((error: unknown) => {
			logger.warn("Gateway election failed", { error });
			return false;
		})
		.then((result) => {
			if (
				!result ||
				(deps.routeRunner && naturalUplinkRecovery(deps.routeRunner).pending)
			)
				updateGwQueue = true;
			return result;
		})
		.finally(() => {
			updateGwInFlight = undefined;
		});
	return updateGwInFlight;
}
