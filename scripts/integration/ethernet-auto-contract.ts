import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
	detectEthernetPort,
	type EthernetDiscovery,
} from '../../apps/backend/src/modules/network/ethernet-auto-detection.ts';

if (process.env.NM_CHECKPOINT_CONTRACT !== '1')
	throw new Error('Requires the isolated NetworkManager contract container');

const [port, capture] = process.argv.slice(2);
if (port !== 'auto0') throw new Error('Requires the contract veth');
const statePath = process.env.CONTRACT_AUTO_STATE;
const attachment = Number(process.env.CONTRACT_AUTO_ATTACHMENT);
if (!statePath || !Number.isSafeInteger(attachment) || attachment < 1) {
	throw new Error('Requires the contract state file and an attachment generation');
}

const nm = (field: string) =>
	execFileSync('nmcli', ['--get-values', field, 'device', 'show', port], {
		encoding: 'utf8',
		timeout: 5_000,
	}).trim();
const carrier = readFileSync(`/sys/class/net/${port}/carrier`, 'utf8').trim() === '1';
const ifindex = Number(readFileSync(`/sys/class/net/${port}/ifindex`, 'utf8'));
const [address] = nm('IP4.ADDRESS').split('/');
const hasDhcpLease = nm('DHCP4.OPTION').includes('dhcp_server_identifier = ');
const scope = `${ifindex}:${attachment}`;
// The contract controls attachment boundaries and leaves the previous entry
// in place across a replug to prove it can't carry over to the next attachment.
if (carrier && (hasDhcpLease || nm('IP6.GATEWAY') !== '')) {
	writeFileSync(statePath, scope);
}
const evidence: EthernetDiscovery = {
	ifindex,
	attachment,
	routeGeneration: 1,
	carrier,
	window: 'complete',
	upstreamSeen: existsSync(statePath) && readFileSync(statePath, 'utf8') === scope,
	peerDhcpRequestSeen:
		capture !== undefined &&
		Number(process.env.CONTRACT_CAPTURE_ATTACHMENT) === attachment &&
		readFileSync(capture, 'utf8').includes('Discover'),
	lease: hasDhcpLease && address ? { address, gateway: nm('IP4.GATEWAY') } : undefined,
};

process.stdout.write(JSON.stringify(detectEthernetPort('auto', evidence) ?? null));
