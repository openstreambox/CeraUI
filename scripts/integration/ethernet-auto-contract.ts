import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
	detectEthernetPort,
	type EthernetDiscovery,
} from '../../apps/backend/src/modules/network/ethernet-auto-detection.ts';

if (process.env.NM_CHECKPOINT_CONTRACT !== '1')
	throw new Error('Requires the isolated NetworkManager contract container');

const [port, capture] = process.argv.slice(2);
if (port !== 'auto0') throw new Error('Requires the contract veth');

const nm = (field: string) =>
	execFileSync('nmcli', ['--get-values', field, 'device', 'show', port], {
		encoding: 'utf8',
		timeout: 5_000,
	}).trim();
const carrier = readFileSync(`/sys/class/net/${port}/carrier`, 'utf8').trim() === '1';
const [address] = nm('IP4.ADDRESS').split('/');
const hasDhcpLease = nm('DHCP4.OPTION').includes('dhcp_server_identifier = ');
const evidence: EthernetDiscovery = {
	attachment: 1,
	carrier,
	window: 'complete',
	upstreamDhcpSeen: hasDhcpLease,
	ipv6RouterSeen: nm('IP6.GATEWAY') !== '',
	peerDhcpRequestSeen: capture !== undefined && readFileSync(capture, 'utf8').includes('Discover'),
	lease: hasDhcpLease && address ? { address, gateway: nm('IP4.GATEWAY') } : undefined,
};

process.stdout.write(JSON.stringify(detectEthernetPort('auto', evidence) ?? null));
