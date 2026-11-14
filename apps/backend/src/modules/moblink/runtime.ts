import fs from "node:fs";
import { shouldUseMocks } from "../../mocks/mock-service";
import { getCarryingLiveness } from "../system/carrying";
import { clearBootDegraded, markBootDegraded } from "../system/readiness";
import { isStreamConfirmedIdle } from "../system/stream-liveness-source";
import { MoblinkOwner } from "./owner";
import { createRelayRunner } from "./relay-runner";

/** Provisioning asserts this backend is the sole relay supervisor. */
function available() {
	if (shouldUseMocks()) return false;
	try {
		for (const file of [
			"/etc/ceralive/moblink-managed",
			"/usr/local/bin/moblink-relay-service",
		]) {
			const s = fs.lstatSync(file);
			if (
				!s.isFile() ||
				s.isSymbolicLink() ||
				s.uid !== 0 ||
				(s.mode & 0o022) !== 0
			)
				return false;
		}
		fs.accessSync("/usr/local/bin/moblink-relay-service", fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
const health = (bad: boolean) =>
	bad ? markBootDegraded("moblink") : clearBootDegraded("moblink");
const relay = createRelayRunner(
	(args, options) => Bun.spawn(args, options),
	health,
);
export const moblinkOwner = new MoblinkOwner({
	directory: "/data/moblink",
	available,
	running: relay.running,
	idle: () => getCarryingLiveness() === "idle" && isStreamConfirmedIdle(),
	health,
	start: relay.start,
	stop: relay.stop,
});
export const stopMoblinkRelay = () => relay.stop().catch(() => undefined);
