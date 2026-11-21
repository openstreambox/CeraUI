/**
 * Drives the network-change owner against a real NetworkManager for
 * network-checkpoint-contract.sh. One command per call, so the shell can stop,
 * restart or "reboot" NetworkManager between steps. The two effects outside
 * NetworkManager are file-backed stand-ins behind the recorded-undo interface:
 * no hotspot, radio or modem command is ever issued.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { serve, sleep } from 'bun';
import {
	createEffectRegistry,
	HOTSPOT_INTERFACE_EFFECT,
	type JsonValue,
	MODEM_RADIO_MODE_EFFECT,
} from '../../apps/backend/src/modules/network/network-change-effects.ts';
import {
	createFileJournalStore,
	type NetworkChangePlan,
} from '../../apps/backend/src/modules/network/network-change-journal.ts';
import { createNetworkChangeOwner } from '../../apps/backend/src/modules/network/network-checkpoint.ts';
import { createNmCheckpointAdapter } from '../../apps/backend/src/modules/network/network-checkpoint-nm.ts';
import { createIngressEvidence } from '../../apps/backend/src/modules/network/network-ingress.ts';

if (process.env.NM_CHECKPOINT_CONTRACT !== '1')
	throw new Error('Requires the isolated contract container');

const STATE = process.env.CONTRACT_STATE ?? '/var/lib/ceralive-contract';
const EFFECTS = `${STATE}/effects.json`;
mkdirSync(STATE, { recursive: true, mode: 0o700 });

const runner = async (bin: string, args: string[]) =>
	execFileSync(bin, args, {
		encoding: 'utf8',
		timeout: 40_000,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

type EffectState = { interfaces: string[]; radio: Record<string, string> };
function readEffects(): EffectState {
	try {
		return JSON.parse(readFileSync(EFFECTS, 'utf8'));
	} catch {
		return { interfaces: ['ap0'], radio: { modem0: '4g|5g' } };
	}
}
function writeEffects(state: EffectState) {
	writeFileSync(EFFECTS, JSON.stringify(state));
}

const effects = createEffectRegistry([
	{
		kind: HOTSPOT_INTERFACE_EFFECT,
		async prepare(spec) {
			const ifname = (spec as { ifname: string }).ifname;
			return { ifname, existed: readEffects().interfaces.includes(ifname) };
		},
		async apply(spec) {
			const s = readEffects();
			const ifname = (spec as { ifname: string }).ifname;
			writeEffects({ ...s, interfaces: s.interfaces.filter((i) => i !== ifname) });
		},
		async undo(recorded) {
			const { ifname, existed } = recorded as { ifname: string; existed: boolean };
			const s = readEffects();
			if (existed && !s.interfaces.includes(ifname))
				writeEffects({ ...s, interfaces: [...s.interfaces, ifname] });
		},
	},
	{
		kind: MODEM_RADIO_MODE_EFFECT,
		async prepare(spec) {
			const modem = (spec as { modem: string }).modem;
			return { modem, mode: readEffects().radio[modem] ?? null } as JsonValue;
		},
		async apply(spec) {
			const { modem, mode } = spec as { modem: string; mode: string };
			const s = readEffects();
			writeEffects({ ...s, radio: { ...s.radio, [modem]: mode } });
		},
		async undo(recorded) {
			const { modem, mode } = recorded as { modem: string; mode: string };
			const s = readEffects();
			writeEffects({ ...s, radio: { ...s.radio, [modem]: mode } });
		},
	},
]);

const nm = createNmCheckpointAdapter(runner);
const owner = createNetworkChangeOwner({
	now: () => Date.now(),
	bootId: async () =>
		process.env.CONTRACT_BOOT_ID ?? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
	nm,
	effects,
	journal: createFileJournalStore(`${STATE}/network-change.json`),
	windowSeconds: Number(process.env.CONTRACT_WINDOW ?? 3),
	settleMs: Number(process.env.CONTRACT_SETTLE_MS ?? 0),
});

async function uuidsNamed(name: string) {
	const out = await runner('nmcli', ['-t', '-f', 'UUID,NAME', 'connection', 'show']);
	return out
		.split('\n')
		.filter((l) => l.endsWith(`:${name}`))
		.map((l) => l.split(':')[0] as string);
}

async function buildPlan(name: string): Promise<NetworkChangePlan> {
	const summary = { key: 'network.changeSafety.notice.make' };
	if (name === 'dormant')
		return {
			summary,
			devices: ['spare0'],
			profiles: (await uuidsNamed('checkpoint-dormant')).map((uuid) => ({
				uuid,
				set: [['ipv4.addresses', '198.51.100.9/24']],
			})),
			effects: [],
		};
	const [active] = await uuidsNamed('checkpoint-active');
	const plan: NetworkChangePlan = {
		summary,
		devices: ['checkpoint0'],
		profiles: [
			{
				uuid: active as string,
				set: [['ipv4.addresses', process.env.CONTRACT_ADDRESS ?? '192.0.2.9/24']],
				activateOn: 'checkpoint0',
			},
		],
		effects:
			name === 'effects'
				? [
						{ kind: HOTSPOT_INTERFACE_EFFECT, devices: ['ap0'], spec: { ifname: 'ap0' } },
						{
							kind: MODEM_RADIO_MODE_EFFECT,
							devices: ['wwan0'],
							spec: { modem: 'modem0', mode: '4g' },
						},
					]
				: [],
	};
	return plan;
}

const session = (id: string, ingress: string) => ({
	id,
	openedAt: Date.now(),
	authenticated: true,
	ingress: ingress === '-' ? undefined : ingress,
});

const [command, ...args] = process.argv.slice(2);
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (command === 'ingress-server') {
	// Reports what the kernel recorded next to what a destination guess says.
	const evidence = createIngressEvidence(runner);
	const server = serve({
		port: Number(args[0] ?? 8080),
		hostname: '0.0.0.0',
		async fetch(req, srv) {
			const peer = srv.requestIP(req);
			const via = peer ? await evidence.lookup(peer.address, peer.port) : undefined;
			return Response.json({ via: via ?? null, destination: new URL(req.url).hostname });
		},
	});
	process.stdout.write('listening\n');
	await sleep(Number(args[1] ?? 20) * 1000);
	server.stop(true);
	process.exit(0);
}

let result: unknown;
switch (command) {
	case 'apply': {
		const [planName = '', ingress = '-', answer] = args;
		result = await owner.apply(
			{ ...session('creator', ingress), openedAt: 0 },
			await buildPlan(planName),
			answer ? { answer: answer as 'undo-automatically' | 'keep-change' } : {},
		);
		break;
	}
	case 'confirm':
		await owner.confirm(args[0] as string, session(args[1] as string, args[2] as string));
		result = 'confirmed';
		break;
	case 'tick':
		result = await owner.tick();
		break;
	case 'reconcile':
		result = await owner.reconcile(args[0] as 'backend-start' | 'network-restart' | 'boot');
		break;
	case 'status':
		result = await owner.status();
		break;
	case 'undo-kept':
		await owner.undoKept(args[0] as string, session('phone', args[1] as string));
		result = 'undone';
		break;
	case 'leave':
		await owner.leaveUndone(args[0] as string, session('phone', '-'));
		result = 'left';
		break;
	case 'effects':
		result = readEffects();
		break;
	default:
		throw new Error(`Unknown command: ${command}`);
}
print(result);
