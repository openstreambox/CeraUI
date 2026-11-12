import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
	readPrivateText,
	writePrivateText,
} from "../../helpers/private-json-state.ts";
import { run } from "../../helpers/run.ts";
import type { CellularClatHostEffects } from "./cellular-clat-host.ts";
import {
	type CellularClatHostPlan,
	cellularClatIsolatesPhysical,
	cellularClatPhysicalSettings,
} from "./cellular-clat-host-plan.ts";
import { CellularClatReceipt } from "./cellular-clat-receipt.ts";
import { CellularFirewall, cellularFirewallIO } from "./cellular-firewall.ts";
import { CellularForwardFence } from "./cellular-forward-fence.ts";
import {
	cellularPhysicalState,
	compareAndSetScopedCellularSysctl,
	readScopedCellularSysctl,
} from "./cellular-host-identity.ts";
import {
	CellularIndexedIpState,
	cellularIndexedIpIO,
} from "./cellular-indexed-ip-state.ts";
import {
	CellularIpState,
	cellularIpEffectMatches,
	cellularIpIO,
} from "./cellular-ip-state.ts";
import type { CellularRoutePlan } from "./cellular-route-plan.ts";
import {
	CellularTranslator,
	cellularTranslatorConfigKey,
	cellularTranslatorIO,
} from "./cellular-translator.ts";
import { cellularTranslatorConfig } from "./cellular-translator-config.ts";
import { cellularTunIO, inspectCellularTun } from "./cellular-tun.ts";
import {
	configureCellularTun,
	quiesceCellularTun,
	verifyCellularTunConfiguration,
} from "./cellular-tun-configuration.ts";
import {
	cellularTunUnreferenced,
	readCellularTunReferences,
} from "./cellular-tun-retirement.ts";
import { formatIpv6, parseIpv6 } from "./nat64.ts";
import { isSafeIfname } from "./safe-ifname.ts";

type Instance = "present" | "absent" | "foreign" | "unknown";
export interface CellularClatKernelOptions {
	readonly store: { readonly dir: string };
	readonly bootId: string;
	/** Read-only forwarding policy context, including a synchronous dispatch fence. */
	readonly forwarding?: {
		readonly read: () => Promise<string>;
		readonly current: () => string;
	};
	/** A namespace fixture supplies index/instance evidence and its own child;
	 * it must never invoke the host's PID 1 from an isolated network namespace.
	 */
	readonly physicalState?: () => Promise<Instance>;
	readonly translator?: Pick<CellularTranslator, "inspect" | "start" | "stop">;
}
type Guard = {
	readonly current: () => Promise<boolean>;
	readonly writable: () => boolean;
};
export function createCellularClatKernelEffects(
	plan: CellularClatHostPlan,
	routes: CellularRoutePlan,
	guard: Guard,
	options: CellularClatKernelOptions,
): CellularClatHostEffects {
	if (
		!routes.translated ||
		!routes.mapped ||
		!routes.nat64 ||
		routes.device !== plan.tun.name
	)
		throw new Error("Translated kernel plan required");
	const forwarding = options.forwarding ?? {
		read: async () =>
			(await readFile("/proc/sys/net/ipv6/conf/all/forwarding", "utf8")).trim(),
		current: () =>
			readFileSync("/proc/sys/net/ipv6/conf/all/forwarding", "utf8").trim(),
	};
	const sameBoot = plan.bootId === options.bootId,
		writable = () => sameBoot && guard.writable(),
		current = async () =>
			writable() &&
			(await guard.current()) &&
			(await forwarding.read()) === plan.globalForwarding &&
			writable(),
		tunIO = cellularTunIO(async () => writable());
	const tunState = async (): Promise<Instance> => {
		const observed = inspectCellularTun(
			await tunIO.links(),
			plan.input.slot,
			plan.input.owner,
			plan.tunEpoch,
		);
		if (observed === "absent") return "absent";
		if (
			typeof observed === "string" ||
			!sameBoot ||
			observed.index !== plan.tun.index ||
			!observed.persistent
		)
			return "foreign";
		return "present";
	};
	const physicalState = async (): Promise<Instance> => {
		if (!sameBoot) return "absent"; // This is only the old physical baseline, never a new-boot mutation.
		if (options.physicalState) return options.physicalState();
		if ((await cellularPhysicalState(plan.physical)) === "present")
			return "present";
		try {
			const rows: unknown = JSON.parse(
				await run("ip", ["-j", "link", "show"], {
					timeout: 4000,
					maxBuffer: 256 * 1024,
				}),
			);
			if (
				!Array.isArray(rows) ||
				rows.length > 4096 ||
				rows.some(
					(row) =>
						!Number.isInteger(row?.ifindex) ||
						row.ifindex < 1 ||
						row.ifindex > 0x7fffffff ||
						typeof row.ifname !== "string" ||
						!isSafeIfname(row.ifname),
				) ||
				new Set(rows.map((row) => row.ifindex)).size !== rows.length ||
				new Set(rows.map((row) => row.ifname)).size !== rows.length
			)
				return "unknown";
			return rows.some((row) => row.ifindex === Number(plan.physical.ifindex))
				? "foreign"
				: "absent";
		} catch {
			return "unknown";
		}
	};
	const nft = cellularFirewallIO(current),
		nftIO = {
			...nft,
			write: async (text: string) => {
				if (!writable()) throw new Error("CLAT firewall lease retired");
				await nft.write(text);
			},
		},
		output = new CellularFirewall(
			{
				owner: plan.input.owner,
				slot: plan.input.slot,
				source: routes.source,
				ifindex: plan.tun.index,
				translated: true,
				dns: [],
			},
			nftIO,
		),
		forward = new CellularForwardFence(
			{
				owner: plan.input.owner,
				slot: plan.input.slot,
				tunIndex: plan.tun.index,
				physicalIndex: Number(plan.physical.ifindex),
				mapped: routes.mapped,
				nat64: routes.nat64,
				isolatePhysical: cellularClatIsolatesPhysical(plan),
			},
			nftIO,
		),
		ipIO = cellularIpIO(current),
		ip = new CellularIpState(routes, {
			...ipIO,
			write: async (argv) => {
				if (!writable()) throw new Error("CLAT routing lease retired");
				await ipIO.write(argv);
			},
		}),
		addressEffect = {
			kind: "address",
			family: 4,
			address: routes.source,
			prefix: 32,
		} as const,
		proxyEffect = { kind: "proxy", family: 6, address: routes.mapped } as const,
		address = new CellularIndexedIpState(
			{ name: plan.tun.name, index: plan.tun.index },
			[addressEffect],
			cellularIndexedIpIO(tunState, writable),
		),
		proxy = new CellularIndexedIpState(
			{ name: plan.physical.ifname, index: Number(plan.physical.ifindex) },
			[proxyEffect],
			cellularIndexedIpIO(physicalState, writable),
		),
		physical = {
			ifname: plan.physical.ifname,
			writable: () =>
				writable() && forwarding.current() === plan.globalForwarding,
			current: async () =>
				writable() &&
				(await forwarding.read()) === plan.globalForwarding &&
				(await physicalState()) === "present" &&
				forwarding.current() === plan.globalForwarding,
		},
		settings = cellularClatPhysicalSettings(plan),
		receipt = new CellularClatReceipt(plan, options.store, guard.writable),
		identity = {
			owner: plan.input.owner,
			epoch: plan.input.epoch,
			slot: plan.input.slot,
			birth: plan.birth,
		},
		configKey = cellularTranslatorConfigKey(identity),
		config = cellularTranslatorConfig(routes),
		translator =
			options.translator ??
			new CellularTranslator(
				identity,
				options.store.dir,
				config,
				cellularTranslatorIO(
					current,
					async () => writable(),
					() => readPrivateText(options.store, configKey),
				),
			),
		tunConfiguration = {
			slot: plan.input.slot,
			owner: plan.input.owner,
			epoch: plan.tunEpoch,
			index: plan.tun.index,
			linkMtu: routes.linkMtu,
		};
	const requireReceipt = async () => {
		const value = await receipt.read();
		if (!value) throw new Error("CLAT effect receipt missing");
		return value;
	};
	const noOtherProxies = async (): Promise<boolean> => {
		const rows: unknown = JSON.parse(
			await run("ip", ["-6", "-j", "neigh", "show", "proxy"], {
				timeout: 4000,
				maxBuffer: 256 * 1024,
			}),
		);
		if (!Array.isArray(rows) || rows.length > 4096) return false;
		for (const row of rows) {
			if (
				typeof row?.dev !== "string" ||
				typeof row.dst !== "string" ||
				row.dst.includes("%")
			)
				return false;
			const bytes = parseIpv6(row.dst);
			if (!bytes) return false;
			if (
				row.dev === plan.physical.ifname &&
				formatIpv6(bytes) !== routes.mapped
			)
				return false;
		}
		return true;
	};
	const routeEffect = (step: string) => {
		const index = Number(step.slice(3));
		const effect = routes.effects[index];
		if (!/^ip-\d+$/.test(step) || !effect)
			throw new Error("Unknown CLAT route effect");
		return effect;
	};
	const setting = (step: string) => {
		const row = settings.find(
			(row) => `physical-${row.key.replaceAll("_", "-")}` === step,
		);
		if (!row) throw new Error("Unknown CLAT physical effect");
		return row;
	};
	const mapped = (value: string) =>
		value === "absent" || value === "foreign" ? value : "owned";
	const assertTunReferencesClear = async (terminalRulesRemain: boolean) => {
		for (const fence of [output, forward]) {
			const state = await fence.inspect();
			if (state !== "absent" && state !== "withdrawn")
				throw new Error("CLAT quiescence fence unavailable");
		}
		const references = await readCellularTunReferences(plan.tun),
			state = await address.inspect(addressEffect);
		if (
			state === "foreign" ||
			!Array.isArray(references.addresses) ||
			references.addresses.length !== 1
		)
			throw new Error("CLAT TUN references retained");
		const link = references.addresses[0];
		if (!Array.isArray(link?.addr_info))
			throw new Error("CLAT TUN references retained");
		// Removing the last IPv4 address, or stopping its last queue, can also
		// remove routes. Check before either boundary, not just before link-down.
		const ownedLocal = (row: Record<string, unknown>) =>
			state === "owned" &&
			[2, "2", "local"].includes(row.type as string | number) &&
			[255, "255", "local"].includes(row.table as string | number) &&
			[2, "2", "kernel"].includes(row.protocol as string | number) &&
			[row.dst, row.prefsrc].every(
				(value) => value === routes.source || value === `${routes.source}/32`,
			) &&
			row.dev === plan.tun.name &&
			[254, "254", "host"].includes(row.scope as string | number) &&
			(row.flags === undefined ||
				(Array.isArray(row.flags) && row.flags.length === 0)) &&
			Object.keys(row).every((key) =>
				[
					"type",
					"dst",
					"dev",
					"table",
					"protocol",
					"scope",
					"prefsrc",
					"flags",
				].includes(key),
			);
		const rules = (raw: unknown, family: 4 | 6) => {
			if (!Array.isArray(raw)) throw new Error("Unknown TUN rule references");
			return raw.filter(
				(row) =>
					!terminalRulesRemain ||
					!routes.effects.some(
						(effect) =>
							effect.family === family &&
							effect.kind === "rule" &&
							effect.terminal &&
							cellularIpEffectMatches(effect, row),
					),
			);
		};
		if (!Array.isArray(references.routes4))
			throw new Error("Unknown TUN route references");
		const filtered = {
			...references,
			addresses: [
				{
					...link,
					addr_info:
						state === "owned" && link.addr_info.length === 1
							? []
							: link.addr_info,
				},
			],
			routes4: references.routes4.filter((row) => !ownedLocal(row)),
			rules4: rules(references.rules4, 4),
			rules6: rules(references.rules6, 6),
		};
		if (
			!cellularTunUnreferenced(plan.tun, filtered, [
				`ceracell_${plan.input.slot}`,
				`ceracell_forward_${plan.input.slot}`,
			])
		)
			throw new Error("CLAT TUN references retained");
	};
	const inspect: CellularClatHostEffects["inspect"] = async (step, inverse) => {
		if (step === "receipt") return (await receipt.read()) ? "owned" : "absent";
		if (step === "output") return mapped(await output.inspect());
		if (step === "forward") return mapped(await forward.inspect());
		if (step === "forward-active") {
			const value = await forward.inspect();
			return value === "active"
				? "owned"
				: value === "foreign"
					? "foreign"
					: "absent";
		}
		if (step.startsWith("ip-")) return ip.inspect(routeEffect(step), inverse);
		if (step.startsWith("physical-")) {
			const instance = await physicalState();
			if (instance === "absent") return "absent";
			if (instance !== "present") return "foreign";
			const row = setting(step),
				value = await readScopedCellularSysctl(physical, row.key);
			if (
				value === row.desired &&
				row.key === "proxy_ndp" &&
				!(await noOtherProxies())
			)
				return "foreign";
			return value === row.desired
				? "owned"
				: value === row.before
					? "absent"
					: "foreign";
		}
		if (step === "address") return address.inspect(addressEffect);
		if (step === "proxy") return proxy.inspect(proxyEffect);
		if (step === "configuration-file") {
			const value = await readPrivateText(options.store, configKey);
			return value === undefined
				? "absent"
				: value === config
					? "owned"
					: "foreign";
		}
		if (step === "tun-configuration") {
			const value = await receipt.read();
			if (!value?.tunConfigurationStarted) return "absent";
			const state = await tunState();
			if (state === "absent") return inverse ? "owned" : "foreign";
			if (state !== "present") return "foreign";
			return inverse ||
				(await verifyCellularTunConfiguration(
					tunConfiguration,
					{ ...tunIO, current },
					writable,
				))
				? "owned"
				: "foreign";
		}
		if (step === "translator") {
			const value = await receipt.read(),
				state = await translator.inspect(value?.invocation);
			if (state.kind === "absent") return "absent";
			return state.kind === "owned" &&
				value?.translatorSubmitted &&
				(inverse || state.running)
				? "owned"
				: "foreign";
		}
		throw new Error("Unknown CLAT kernel effect");
	};
	const apply: CellularClatHostEffects["apply"] = async (step) => {
		if (!(await current())) throw new Error("CLAT kernel owner unavailable");
		if (step === "receipt") return receipt.create();
		if (step === "output") return output.create("withdrawn");
		if (step === "forward") return forward.create("withdrawn");
		if (step === "forward-active") return forward.transition("active");
		if (step.startsWith("ip-")) return ip.apply(routeEffect(step));
		if (step.startsWith("physical-")) {
			const row = setting(step);
			if (row.key === "proxy_ndp" && !(await noOtherProxies()))
				throw new Error("Foreign physical proxies remain disabled");
			if (
				!(await compareAndSetScopedCellularSysctl(
					physical,
					row.key,
					row.before,
					row.desired,
				))
			)
				throw new Error("CLAT physical setting unconfirmed");
			return;
		}
		if (step === "address") return address.apply(addressEffect);
		if (step === "proxy") return proxy.apply(proxyEffect);
		if (step === "configuration-file") {
			await writePrivateText(options.store, configKey, config);
			return;
		}
		if (step === "tun-configuration") {
			await receipt.markTunConfiguration(true);
			if (
				!(await configureCellularTun(
					tunConfiguration,
					{ ...tunIO, current },
					writable,
				))
			)
				throw new Error("CLAT TUN configuration unconfirmed");
			return;
		}
		if (step === "translator") {
			await receipt.markTranslatorSubmission();
			const invocation = await translator.start();
			if (!invocation) throw new Error("CLAT translator start uncertain");
			await receipt.rememberInvocation(invocation);
			return;
		}
		throw new Error("Unknown CLAT kernel apply");
	};
	const remove: CellularClatHostEffects["remove"] = async (step) => {
		if (!guard.writable()) throw new Error("CLAT kernel inverse lease retired");
		if (step === "receipt") return receipt.remove();
		if (step === "output") {
			if (!(await output.remove()))
				throw new Error("CLAT output fence retained");
			return;
		}
		if (step === "forward") {
			if (!(await forward.remove()))
				throw new Error("CLAT forward fence retained");
			return;
		}
		if (step === "forward-active") return forward.transition("withdrawn");
		if (step.startsWith("ip-")) {
			if (!(await ip.remove(routeEffect(step))))
				throw new Error("CLAT route retained");
			return;
		}
		if (step.startsWith("physical-")) {
			const row = setting(step);
			if (
				(await physicalState()) !== "absent" &&
				!(await compareAndSetScopedCellularSysctl(
					physical,
					row.key,
					row.desired,
					row.before,
				))
			)
				throw new Error("CLAT physical baseline retained");
			return;
		}
		if (step === "address") {
			if ((await tunState()) === "present")
				await assertTunReferencesClear(false);
			if (!(await address.remove(addressEffect)))
				throw new Error("CLAT address retained");
			return;
		}
		if (step === "proxy") {
			if (!(await proxy.remove(proxyEffect)))
				throw new Error("CLAT proxy retained");
			return;
		}
		if (step === "configuration-file") {
			await writePrivateText(options.store, configKey, undefined);
			return;
		}
		if (step === "tun-configuration") {
			const instance = await tunState();
			if (instance !== "present" && instance !== "absent")
				throw new Error("CLAT TUN instance is foreign");
			if (instance === "present") {
				// Link-down itself removes routes. Prove no foreign references before
				// quiescing, while the two independently verified deny fences remain.
				for (const fence of [output, forward]) {
					const state = await fence.inspect();
					if (state !== "absent" && state !== "withdrawn")
						throw new Error("CLAT quiescence fence unavailable");
				}
				if (
					!cellularTunUnreferenced(
						plan.tun,
						await readCellularTunReferences(plan.tun),
						[
							`ceracell_${plan.input.slot}`,
							`ceracell_forward_${plan.input.slot}`,
						],
					)
				)
					throw new Error("CLAT TUN references retained");
				const inventory: unknown = JSON.parse(
					await run("ip", ["-j", "addr", "show", "dev", plan.tun.name], {
						timeout: 4000,
						maxBuffer: 16 * 1024,
					}),
				);
				if (
					!Array.isArray(inventory) ||
					inventory.length !== 1 ||
					inventory[0]?.ifindex !== plan.tun.index ||
					!Array.isArray(inventory[0].addr_info) ||
					inventory[0].addr_info.length !== 0 ||
					!(await quiesceCellularTun(tunConfiguration, tunIO, writable))
				)
					throw new Error("CLAT TUN configuration retained");
			}
			await receipt.markTunConfiguration(false);
			return;
		}
		if (step === "translator") {
			if ((await tunState()) === "present")
				await assertTunReferencesClear(true);
			const value = await requireReceipt(),
				state = await translator.inspect(value.invocation);
			if (state.kind === "absent") return;
			if (
				state.kind !== "owned" ||
				!value.translatorSubmitted ||
				!state.invocation
			)
				throw new Error("CLAT translator ownership unavailable");
			await receipt.rememberInvocation(state.invocation);
			if (!(await translator.stop(state.invocation)))
				throw new Error("CLAT translator retained");
			return;
		}
		throw new Error("Unknown CLAT kernel inverse");
	};
	return {
		output,
		inspect,
		apply,
		remove,
		deny: async () => {
			for (const fence of [output, forward]) {
				const state = await fence.inspect();
				if (state === "foreign") throw new Error("CLAT fence is foreign");
				if (state !== "absent") await fence.transition("withdrawn");
			}
		},
		valid: async () => {
			if (
				!(await current()) ||
				(await tunState()) !== "present" ||
				(await physicalState()) !== "present" ||
				(
					await readFile("/proc/sys/net/ipv6/conf/all/forwarding", "utf8")
				).trim() !== plan.globalForwarding ||
				!(await verifyCellularTunConfiguration(
					tunConfiguration,
					{ ...tunIO, current },
					writable,
				))
			)
				return false;
			for (const key of [
				"accept_ra",
				"accept_ra_defrtr",
				"forwarding",
				"proxy_ndp",
				"force_forwarding",
			] as const) {
				const desired =
					settings.find((row) => row.key === key)?.desired ??
					plan.physicalBefore[key];
				if ((await readScopedCellularSysctl(physical, key)) !== desired)
					return false;
			}
			return (await readPrivateText(options.store, configKey)) === config;
		},
	};
}
