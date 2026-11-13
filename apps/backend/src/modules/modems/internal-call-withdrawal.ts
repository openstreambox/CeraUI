/** Durable stages of the one retained unit owner. The factory holds its
 * physical lease; this contract adds no lock, retry timer or modem owner.
 */
export interface InternalCallRetirement {
	readonly owned: () => boolean;
	readonly withdrawn: () => boolean;
	/** Latch the whole-owner record into withdrawal before any inverse effect. */
	readonly begin: () => Promise<"withdrawing" | "retiring" | false>;
	readonly contextReleased: () => boolean;
	readonly markContextReleased: () => Promise<void>;
	/** Remove durable authority and release the physical lease after its ack. */
	readonly finish: () => Promise<boolean>;
}
export interface InternalCallWithdrawalDeps {
	readonly retirement: InternalCallRetirement;
	readonly withdraw: () => void;
	readonly clearGrant: () => Promise<boolean>;
	readonly context: () => Promise<boolean>;
	readonly host: () => Promise<boolean>;
	readonly control: () => Promise<void>;
}
/** The same inverse order serves normal close and startup replay. In
 * particular, an uncertain uninhibition tail cannot repeat modem effects after
 * the host guard has already been restored. Each callback preserves its own
 * pending durable cursor and verifies this held scope around its awaited work.
 */
export async function withdrawInternalCall(
	deps: InternalCallWithdrawalDeps,
): Promise<boolean> {
	const scope = deps.retirement,
		current = () => scope.owned() && scope.withdrawn();
	if (!scope.owned()) return false;
	deps.withdraw();
	const stage = await scope.begin();
	if (!stage || !scope.owned()) return false;
	if (!(await deps.clearGrant()) || !current()) return false;
	if (stage === "retiring") return scope.finish();
	if (!scope.contextReleased()) {
		if (!(await deps.context()) || !current()) return false;
		await scope.markContextReleased();
		if (!current() || !scope.contextReleased()) return false;
	}
	if (!(await deps.host()) || !current()) return false;
	await deps.control();
	if (!current()) return false;
	return scope.finish();
}
