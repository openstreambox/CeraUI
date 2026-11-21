import { logger } from "../../../helpers/logger.ts";
import { mintLinkId } from "../../modems/physical-identity.ts";
import {
	type ShareRulesetState,
	SteeringUnavailableError,
	type SteeringUplink,
	type UplinkFlowsResetEvent,
} from "./contracts.ts";
import { buildShareRuleset } from "./ruleset.ts";

export interface UplinkRoutePlan {
	readonly identity: string;
	readonly ifname: string;
	readonly sourceAddress: string;
	readonly mark: number;
	readonly table: string;
	readonly managed: boolean;
	readonly sourceRulePriority?: number;
	readonly defaultRouteArgv?: readonly string[];
}

export interface PreparedSteeringState extends ShareRulesetState {
	readonly routes: readonly UplinkRoutePlan[];
}

export interface RouteProvisioning {
	readonly route: UplinkRoutePlan;
	readonly changed: boolean;
	readonly createdFwmarkRule?: boolean;
	readonly createdSourceRule?: boolean;
	readonly createdTableRoute?: boolean;
	readonly replacedTableRoute?: readonly string[];
	readonly addedTableRoute?: readonly string[];
	readonly removedTableRoutes?: readonly (readonly string[])[];
	readonly removedSourceRules?: readonly UplinkRoutePlan[];
}

export interface UplinkSteeringApplierDeps {
	discoverRoutes(): Promise<readonly UplinkRoutePlan[]>;
	ensureRoute(route: UplinkRoutePlan): Promise<RouteProvisioning>;
	rollbackRoute(provisioning: RouteProvisioning): Promise<void>;
	removeRoute(route: UplinkRoutePlan): Promise<void>;
	applyRuleset(ruleset: string, mode: "activate" | "reload"): Promise<void>;
	deactivateSharing(): Promise<void>;
	flushConntrack(mark: number): Promise<void>;
	setIpForwarding(enabled: boolean): Promise<void>;
	publishFlowsReset(event: UplinkFlowsResetEvent): void;
	/**
	 * Called whenever the client uplink selection that is live changes: as
	 * soon as a reload carries `next`'s selectable uplinks (the exclusion and
	 * transition rulesets already do), and with `previous` when a rollback
	 * restored it. `undefined` means client forwarding is off. A failed apply
	 * therefore still reports what clients actually use.
	 */
	selectionInstalled?(state: PreparedSteeringState | undefined): void;
	/**
	 * Asked right before each reload that would install `next`'s selection.
	 * `false` (the probe evidence for a newly selected uplink expired while
	 * routes were planned or provisioned) aborts the apply, which rolls back
	 * and is retried with a fresh plan.
	 */
	selectionQualified?(state: PreparedSteeringState): boolean;
}

export class UplinkSteeringApplier {
	readonly #deps: UplinkSteeringApplierDeps;
	#pendingRetirements: UplinkRoutePlan[] = [];
	#committedRoutes: readonly UplinkRoutePlan[] = [];
	readonly #cleanupFailures = new Set<string>();

	constructor(deps: UplinkSteeringApplierDeps) {
		this.#deps = deps;
	}

	async apply(
		previous: PreparedSteeringState | undefined,
		next: PreparedSteeringState,
	): Promise<void> {
		const provisioned: RouteProvisioning[] = [];
		const removedSupport: UplinkRoutePlan[] = [];
		const wasActive = (previous?.clientZones.length ?? 0) > 0;
		const isActive = next.clientZones.length > 0;
		let activatedService = false;
		let stateCommitted = false;
		let transitionPublished = false;
		const installed = (state: PreparedSteeringState | undefined) =>
			this.#deps.selectionInstalled?.(state);
		const assertQualified = () => {
			if (this.#deps.selectionQualified?.(next) === false)
				throw new SteeringUnavailableError(
					"ruleset_reload_failed",
					"client uplink evidence expired before install",
				);
		};
		let removedRoutes: UplinkRoutePlan[] = [];
		try {
			const recoveredRoutes =
				previous === undefined ? await this.#deps.discoverRoutes() : [];
			const staleRecoveredRoutes = recoveredRoutePlans(
				recoveredRoutes,
				next.routes,
			);
			for (const route of next.routes) {
				provisioned.push(await this.#deps.ensureRoute(route));
			}

			removedRoutes = removedRoutePlans(previous?.routes ?? [], next.routes);
			// Policy exclusions retire client conntracks while retaining all
			// healthy route support, including host source-routing rules.
			const excluded =
				previous?.uplinks.filter(
					(uplink) =>
						!next.uplinks.some((u) => u.mark === uplink.mark) &&
						!removedRoutes.some((route) => route.mark === uplink.mark),
				) ?? [];
			if (excluded.length > 0 && previous !== undefined) {
				assertQualified();
				await this.#deps.applyRuleset(
					buildShareRuleset({
						clientZones: next.clientZones,
						uplinks: [
							...next.uplinks,
							...excluded.map((u) => ({ ...u, selectable: false, weight: 0 })),
						],
					}),
					"reload",
				);
				// New flows already follow next's selection.
				transitionPublished = true;
				installed(next);
				for (const uplink of excluded) {
					await this.#deps.flushConntrack(uplink.mark);
					this.#deps.publishFlowsReset({
						iface: uplink.ifname,
						linkId: uplink.identity,
					});
				}
			}
			if (removedRoutes.length > 0 && previous !== undefined) {
				const transition = transitionState(previous, next, removedRoutes);
				assertQualified();
				await this.#deps.applyRuleset(buildShareRuleset(transition), "reload");
				transitionPublished = true;
				installed(next);
				for (const route of removedRoutes) {
					await this.#deps.flushConntrack(route.mark);
					await this.#deps.removeRoute(route);
					removedSupport.push(route);
					this.#deps.publishFlowsReset({
						iface: route.ifname,
						linkId: mintLinkId(route.identity),
					});
				}
			}

			if (!isActive) {
				await this.#deps.deactivateSharing();
				stateCommitted = true;
				installed(next);
				await this.#retireRecoveredRoutes(staleRecoveredRoutes);
				await this.#deps.setIpForwarding(false);
			} else {
				const mode = wasActive ? "reload" : "activate";
				assertQualified();
				await this.#deps.applyRuleset(buildShareRuleset(next), mode);
				activatedService = mode === "activate";
				stateCommitted = true;
				installed(next);
				await this.#retireRecoveredRoutes(staleRecoveredRoutes);
				if (!wasActive) await this.#deps.setIpForwarding(true);
			}
			this.#committedRoutes = next.routes;
		} catch (error) {
			const rollbackErrors: unknown[] = [];
			// Whether next's selection is what new client flows use right now.
			let nextLive = stateCommitted || transitionPublished;
			if (activatedService) {
				try {
					await this.#deps.deactivateSharing();
					installed(previous);
					nextLive = false;
				} catch (deactivateError) {
					rollbackErrors.push(deactivateError);
				}
			}
			if (!stateCommitted && transitionPublished && previous !== undefined) {
				// Route support first, so the restored ruleset finds its routes.
				const restored: UplinkRoutePlan[] = [];
				for (const route of [...removedSupport].reverse()) {
					try {
						await this.#deps.ensureRoute(route);
						restored.push(route);
					} catch (restoreError) {
						rollbackErrors.push(restoreError);
					}
				}
				try {
					await this.#deps.applyRuleset(buildShareRuleset(previous), "reload");
					installed(previous);
					nextLive = false;
				} catch (restoreError) {
					rollbackErrors.push(restoreError);
					// Next stays live; the support put back for previous is not
					// part of it and is retired with the pending cleanup.
					this.#queueRetirements(restored);
				}
			}
			if (nextLive) {
				// Keep next's route support: its selection carries new flows.
				// Routes next drops that were not removed yet retire later.
				this.#committedRoutes = next.routes;
				this.#queueRetirements(
					removedRoutes.filter((route) => !removedSupport.includes(route)),
				);
			} else {
				for (const item of provisioned.reverse()) {
					if (!item.changed) continue;
					try {
						await this.#deps.rollbackRoute(item);
					} catch (rollbackError) {
						rollbackErrors.push(rollbackError);
					}
				}
			}
			if (rollbackErrors.length > 0) {
				throw new AggregateError(
					[error, ...rollbackErrors],
					`${error instanceof Error ? error.message : String(error)}; route rollback failed`,
				);
			}
			throw error;
		}
	}

	#queueRetirements(routes: readonly UplinkRoutePlan[]): void {
		for (const route of routes) {
			const key = retirementWorkKey(route);
			if (
				!this.#pendingRetirements.some(
					(pending) => retirementWorkKey(pending) === key,
				)
			)
				this.#pendingRetirements.push(route);
		}
	}

	async retryPendingCleanup(): Promise<void> {
		const routes = recoveredRoutePlans(
			this.#pendingRetirements,
			this.#committedRoutes,
		);
		this.#pendingRetirements = [];
		await this.#retireRecoveredRoutes(routes);
	}

	async #retireRecoveredRoutes(
		routes: readonly UplinkRoutePlan[],
	): Promise<void> {
		for (const route of routes) {
			try {
				await this.#deps.flushConntrack(route.mark);
				await this.#deps.removeRoute(route);
			} catch (error) {
				const key = retirementWorkKey(route);
				if (
					!this.#pendingRetirements.some(
						(pending) => retirementWorkKey(pending) === key,
					)
				) {
					this.#pendingRetirements.push(route);
				}
				const failure = `${key}\u0000${error instanceof Error ? error.message : String(error)}`;
				if (!this.#cleanupFailures.has(failure)) {
					this.#cleanupFailures.add(failure);
					logger.warn("uplink steering route cleanup failed", {
						iface: route.ifname,
						mark: route.mark,
						table: route.table,
						err: error,
					});
				}
			}
		}
	}
}

function removedRoutePlans(
	previous: readonly UplinkRoutePlan[],
	next: readonly UplinkRoutePlan[],
): UplinkRoutePlan[] {
	const retained = new Set(next.map(routeKey));
	return previous.filter((route) => !retained.has(routeKey(route)));
}

function routeKey(route: UplinkRoutePlan): string {
	return `${route.identity}\u0000${route.table}\u0000${route.mark}`;
}

function recoveredRoutePlans(
	recovered: readonly UplinkRoutePlan[],
	desired: readonly UplinkRoutePlan[],
): UplinkRoutePlan[] {
	const retained = new Set(desired.map(recoveredRouteKey));
	return recovered.filter((route) => !retained.has(recoveredRouteKey(route)));
}

function recoveredRouteKey(route: UplinkRoutePlan): string {
	return `${route.mark}\u0000${route.table}`;
}

function retirementWorkKey(route: UplinkRoutePlan): string {
	return `${recoveredRouteKey(route)}\u0000${route.sourceAddress}\u0000${route.sourceRulePriority}`;
}

function transitionState(
	previous: PreparedSteeringState,
	next: PreparedSteeringState,
	removed: readonly UplinkRoutePlan[],
): ShareRulesetState {
	const removedKeys = new Set(removed.map(routeKey));
	const retainedSupport: SteeringUplink[] = [];
	for (const uplink of previous.uplinks) {
		const route = previous.routes.find(
			(candidate) =>
				candidate.identity === uplink.identity &&
				candidate.mark === uplink.mark,
		);
		if (route === undefined || !removedKeys.has(routeKey(route))) continue;
		retainedSupport.push({ ...uplink, selectable: false, weight: 0 });
	}
	return {
		clientZones: next.clientZones,
		uplinks: [...next.uplinks, ...retainedSupport],
	};
}
