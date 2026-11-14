import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "../../../helpers/logger.ts";
import { run } from "../../../helpers/run.ts";
import { getConfig, getConfigFilePath } from "../../config.ts";
import { TwoRadioCoordinator } from "./coordinator.ts";
import type { Identity, Journal } from "./effect-adapter.ts";
import type { IngressAuthority } from "./ingress.ts";
import { FileJournal } from "./journal.ts";
import {
	liveConfigSchema,
	type NativeDeps,
	NativeOwner,
	nativeObserver,
	type RadioState,
} from "./native-owner.ts";
import { boundProbe, type ProbeResult } from "./probe.ts";
import { type Event, type Radio, sameEpoch } from "./reducer.ts";
import { publishStatus } from "./status.ts";

export interface LiveDeps extends NativeDeps {
	journal: Journal;
	claim(): Promise<boolean>;
	probe(state: RadioState, signal: AbortSignal): Promise<ProbeResult | null>;
	/** Independent sender/receiver receipt, never a usefulness probe. */
	traffic(
		session: string,
		operation: number,
		identity: Identity,
	): Promise<boolean>;
	now(): number;
}
export async function startLive(
	enabled: boolean | undefined,
	config: unknown,
	deps: () => LiveDeps,
) {
	if (enabled !== true) return null;
	const c = liveConfigSchema.parse(config),
		d = deps();
	const owner = new NativeOwner(c, d);
	const retained = await d.claim();
	await owner.run(() => owner.prepare(retained, AbortSignal.timeout(4000)));
	const identities = new Map<Radio, RadioState>();
	const bindings = new Map<string, { identity: Identity; nonce: string }>();
	let traffic: { operation: number; identity: Identity } | null = null;
	const authority: IngressAuthority = {
		resolve: (physical) => {
			for (const [radio, s] of identities)
				if (s.identity.physical === physical)
					return { radio, identity: s.identity };
			return null;
		},
		absent: () => false,
		bound: (socket, identity, nonce) => {
			const b = bindings.get(socket);
			return (
				!!b &&
				b.nonce === nonce &&
				JSON.stringify(b.identity) === JSON.stringify(identity)
			);
		},
		traffic: (operation, identity) =>
			traffic?.operation === operation &&
			JSON.stringify(traffic.identity) === JSON.stringify(identity),
	};
	const session = crypto.randomUUID();
	const coordinator = new TwoRadioCoordinator(
		owner,
		d.journal,
		authority,
		session,
		d.now,
	);
	if (!(await coordinator.start()))
		throw new Error("Live owner reconciliation failed");
	await owner.run(() =>
		owner.verify(AbortSignal.timeout(4000), coordinator.view().holder),
	);
	const send = (event: Event, at = d.now()) => {
		const radio =
			event.type === "challenge"
				? event.challenge.radio
				: "radio" in event
					? event.radio
					: undefined;
		const external =
			event.type === "challenge"
				? { type: event.type, challenge: event.challenge }
				: event;
		return coordinator.submit(
			JSON.stringify({
				version: 1,
				at,
				...(radio
					? { physical: identities.get(radio)?.identity.physical }
					: {}),
				event: external,
			}),
		);
	};
	let running = false;
	let rounds = 0;
	return {
		coordinator,
		session,
		identities,
		async cycle() {
			if (running) throw new Error("Concurrent live cycle");
			if (++rounds > 10000)
				throw new Error(
					"Live evidence session exhausted; restart and reconcile",
				);
			running = true;
			try {
				const signal = AbortSignal.timeout(12000);
				for (const radio of ["a", "b"] as const) {
					const state = await d.observe(radio, signal);
					identities.set(radio, state);
					await send({ type: "identity", radio, epoch: state.identity.epoch });
				}
				const round = crypto.randomUUID();
				for (const radio of ["a", "b"] as const) {
					const state = identities.get(radio) as RadioState;
					const startedAt = d.now();
					const result = await d.probe(state, signal);
					if (!result) continue;
					const after = await d.observe(radio, signal);
					if (
						!sameEpoch(state.identity.epoch, after.identity.epoch) ||
						state.identity.physical !== after.identity.physical
					)
						throw new Error("Probe identity changed");
					bindings.set(result.socket, {
						identity: state.identity,
						nonce: result.nonce,
					});
					await send(
						{
							type: "challenge",
							deviceBound: true,
							challenge: {
								id: result.nonce,
								radio,
								epoch: state.identity.epoch,
								target: c.target,
								round,
								socket: result.socket,
								startedAt,
								expiresAt: startedAt + 15000,
							},
						},
						startedAt,
					);
					await send({
						type: "response",
						id: result.nonce,
						nonce: result.nonce,
						radio,
						epoch: state.identity.epoch,
						socket: result.socket,
						ok: result.ok,
					});
					bindings.delete(result.socket);
				}
				await send({ type: "round-complete", target: c.target, round });
				await send({ type: "tick" });
				const op = coordinator.view().op;
				if (op?.phase === "traffic") {
					const identity = identities.get(op.radio)?.identity;
					if (identity && (await d.traffic(session, op.id, identity))) {
						traffic = { operation: op.id, identity };
						await send({
							type: "traffic",
							operation: op.id,
							radio: op.radio,
							epoch: identity.epoch,
						});
						traffic = null;
					}
				}
			} finally {
				running = false;
			}
		},
	};
}

/** Invoked by the existing network-monitor owner; absent/false does no IO. */
export async function initTwoRadioLive() {
	if (getConfig().two_radio_enabled !== true) return;
	const config = liveConfigSchema.parse(
		JSON.parse(
			await readFile(
				process.env.CERAUI_TWO_RADIO_CONFIG ??
					join(dirname(getConfigFilePath()), "two-radio.json"),
				"utf8",
			),
		),
	);
	const directory = join(dirname(getConfigFilePath()), "two-radio");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const claimPath = join(directory, "owner.json");
	let retained = false;
	try {
		if ((await readFile(claimPath, "utf8")) !== JSON.stringify(config))
			throw new Error("Owner configuration changed");
		retained = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	let tail: Promise<unknown> = Promise.resolve();
	const observe = nativeObserver(config);
	const deps: LiveDeps = {
		runner: run,
		observe,
		run: (work) => {
			const next = tail.then(work);
			tail = next.catch(() => undefined);
			return next;
		},
		journal: new FileJournal(join(directory, "journal.json")),
		claim: async () => {
			if (retained) return true;
			// Preflight empty slots before durable ownership is acquired.
			const rules = JSON.parse(
				await run("ip", ["-4", "-j", "rule", "show"], { timeout: 1500 }),
			) as { priority: number }[];
			for (const slot of [config, config.radios.a, config.radios.b]) {
				if (rules.some((r) => r.priority === slot.priority))
					throw new Error("Occupied rule priority");
				const rows = JSON.parse(
					await run(
						"ip",
						["-4", "-j", "route", "show", "table", String(slot.table)],
						{ timeout: 1500 },
					).catch((error) => {
						if (String(error).includes("FIB table does not exist")) return "[]";
						throw error;
					}),
				);
				if (rows.length) throw new Error("Occupied policy table");
			}
			const file = await open(claimPath, "wx", 0o600);
			try {
				await file.writeFile(JSON.stringify(config));
				await file.sync();
			} finally {
				await file.close();
			}
			const parent = await open(directory, "r");
			try {
				await parent.sync();
			} finally {
				await parent.close();
			}
			retained = true;
			return false;
		},
		probe: (state, signal) =>
			boundProbe(state.ifname, config.target, config.port, signal),
		traffic: async (session, operation, identity) => {
			try {
				const path = join(directory, "traffic.json");
				const info = await stat(path);
				if (
					info.uid !== process.getuid?.() ||
					(info.mode & 0o077) !== 0 ||
					info.size > 16384
				)
					return false;
				const receipt = JSON.parse(await readFile(path, "utf8"));
				return (
					receipt.session === session &&
					receipt.operation === operation &&
					Number.isSafeInteger(receipt.receivedBytes) &&
					receipt.receivedBytes > 0 &&
					JSON.stringify(receipt.identity) === JSON.stringify(identity)
				);
			} catch {
				return false;
			}
		},
		now: () => Math.floor(performance.now()),
	};
	// Fresh startup must not adopt a foreign installation.
	const live = await startLive(true, config, () => deps);
	if (!live) return;
	const cycle = async () => {
		await live.cycle();
		const view = live.coordinator.view();
		publishStatus({
			session: live.session,
			identities: Object.fromEntries(
				[...live.identities].map(([r, s]) => [r, s.identity]),
			),
			...view,
		});
	};
	await cycle();
	const next = async () => {
		try {
			await cycle();
			const timer = setTimeout(() => {
				void next();
			}, 1000);
			timer.unref();
		} catch (error) {
			logger.warn(`Two-radio reconciliation required: ${error}`);
			publishStatus({
				session: live.session,
				error: String(error),
				state: live.coordinator.view(),
			});
		}
	};
	const timer = setTimeout(() => {
		void next();
	}, 1000);
	timer.unref();
}
