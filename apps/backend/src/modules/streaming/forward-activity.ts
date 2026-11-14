// Live forwarding exclusion is separate from the short admission lease.
let active = false;
export const isForwardActive = () => active;
export function setForwardActive(value: boolean): void {
	active = value;
}
