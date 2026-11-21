/**
 * Network interfaces ORPC Contract
 */
import { oc } from '@orpc/contract';

import {
	netifConfigInputSchema,
	netifConfigOutputSchema,
	netifMessageSchema,
	setEthernetRoleInputSchema,
	setEthernetRoleOutputSchema,
	setIngestEnabledInputSchema,
	setIngestEnabledOutputSchema,
	sharingPolicySchema,
} from '../schemas';

export const networkContract = oc.router({
	/**
	 * Get all network interfaces status
	 */
	getInterfaces: oc.output(netifMessageSchema),
	getSharingPolicy: oc.output(sharingPolicySchema),
	setSharingPolicy: oc.input(sharingPolicySchema).output(sharingPolicySchema),

	/**
	 * Configure a network interface
	 */
	configure: oc.input(netifConfigInputSchema).output(netifConfigOutputSchema),

	/**
	 * Enable/disable a LAN RTMP/SRT network-ingest gateway (operator desired state)
	 */
	setIngestEnabled: oc.input(setIngestEnabledInputSchema).output(setIngestEnabledOutputSchema),

	/**
	 * Declare an Ethernet port's role: an ordinary bonding uplink, or a
	 * shared-LAN port serving DHCP/DNS to clients.
	 */
	setEthernetRole: oc.input(setEthernetRoleInputSchema).output(setEthernetRoleOutputSchema),

	/**
	 * Subscribe to network interface status changes
	 */
	onStatusChange: oc,
});
