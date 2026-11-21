import { execFileP } from "../../helpers/exec.ts";

/** The two systemd queries behind the SSH status (argv-only, may reject). */
export type SshSystemctlProbes = {
	systemctlIsActive: () => Promise<{ stdout: string; stderr: string }>;
	systemctlIsEnabled: () => Promise<{ stdout: string; stderr: string }>;
};

const productionProbes: SshSystemctlProbes = {
	systemctlIsActive: () => execFileP("systemctl", ["is-active", "ssh"]),
	systemctlIsEnabled: () => execFileP("systemctl", ["is-enabled", "ssh"]),
};
let probes = productionProbes;

/** The probes `getSshStatus()` uses when its caller injects none. */
export function sshSystemctlProbes(): SshSystemctlProbes {
	return probes;
}

/**
 * Test seam, kept in this leaf module so a test preload can set it without
 * loading the SSH module's dependency graph. `null` restores production.
 * Never call from production code.
 */
export function setSshSystemctlProbesForTest(
	next: Partial<SshSystemctlProbes> | null,
): void {
	probes = next ? { ...productionProbes, ...next } : productionProbes;
}
