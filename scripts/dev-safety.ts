import {
	assertLoopbackHost,
	installNetworkSafetyGuard,
	installProcessSafetyGuard,
	takeSafetyViolations,
} from './test-safety.ts';

installProcessSafetyGuard();
installNetworkSafetyGuard();
// Fail even when application retry/error handling catches a rejected effect.
setInterval(() => {
	const violations = takeSafetyViolations();
	if (violations.length) throw new Error(violations.join('\n'));
}, 100).unref();

const controlHub = process.env.CERALIVE_CONTROL_HUB_URL;
if (controlHub) assertLoopbackHost(new URL(controlHub).hostname);
