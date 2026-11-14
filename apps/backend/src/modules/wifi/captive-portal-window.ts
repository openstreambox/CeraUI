export interface WindowDeps {
	open(peer: string, radio: string): Promise<void>;
	close(): Promise<void>;
	check(): Promise<boolean>;
	unchanged(): Promise<boolean>;
	arm(expire: () => void, peer: string): () => void;
}
type Phase =
	| "idle"
	| "signing_in"
	| "checking"
	| "web_available"
	| "needs_sign_in"
	| "cleanup_unknown";

/** One owner; kernel expiry remains authoritative if this process disappears. */
export function createSignInWindow(deps: WindowDeps) {
	let owner: string | undefined;
	let phase: Phase = "idle";
	let busy = false;
	let refreshing = false;
	let generation = 0;
	let expiresAt: number | undefined;
	let disarm: () => void = () => undefined;
	const status = (peer: string) => ({
		phase: owner && peer !== owner ? ("idle" as const) : phase,
		expiresAt: owner === peer ? expiresAt : undefined,
	});
	const finish = async (peer: string) => {
		if (peer !== owner || busy) throw Error("busy_other_phone");
		if (phase !== "signing_in" && phase !== "cleanup_unknown")
			return status(peer);
		busy = true;
		phase = "checking";
		try {
			await deps.close();
		} catch {
			phase = "cleanup_unknown";
			busy = false;
			return status(peer);
		}
		disarm();
		expiresAt = undefined;
		try {
			phase = (await deps.check()) ? "web_available" : "needs_sign_in";
		} catch {
			phase = "needs_sign_in";
		}
		busy = false;
		return status(peer);
	};
	return {
		status,
		finish,
		async start(peer: string, radio: string) {
			if (busy || phase === "signing_in" || phase === "cleanup_unknown")
				throw Error("busy_other_phone");
			busy = true;
			owner = peer;
			phase = "idle";
			const ticket = ++generation;
			expiresAt = Date.now() + 600000;
			try {
				await deps.open(peer, radio);
				expiresAt = Date.now() + 600000;
				phase = "signing_in";
				disarm = deps.arm(() => {
					if (generation === ticket) void finish(peer).catch(() => undefined);
				}, peer);
			} catch (error) {
				try {
					await deps.close();
				} catch {
					phase = "cleanup_unknown";
					expiresAt = Date.now() + 600000;
					disarm = deps.arm(() => {
						void finish(peer).catch(() => undefined);
					}, peer);
					return status(peer);
				}
				expiresAt = undefined;
				throw error;
			} finally {
				busy = false;
			}
			return status(peer);
		},
		async refresh(peer: string) {
			if (
				peer !== owner ||
				(phase !== "signing_in" && phase !== "cleanup_unknown") ||
				busy ||
				refreshing
			)
				return status(peer);
			if (phase === "cleanup_unknown") return finish(peer);
			refreshing = true;
			const ticket = generation;
			let unchanged = false;
			try {
				unchanged = await deps.unchanged();
			} catch {
				unchanged = false;
			} finally {
				refreshing = false;
			}
			if (
				ticket === generation &&
				!unchanged &&
				!busy &&
				phase === "signing_in"
			)
				return finish(peer);
			return status(peer);
		},
	};
}
