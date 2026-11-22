export interface WindowDeps {
	/** `via` is the proven receiving interface when the front door named one. */
	open(peer: string, radio: string, via?: string): Promise<void>;
	close(): Promise<void>;
	check(): Promise<boolean>;
	unchanged(): Promise<boolean>;
	arm(expire: () => void, peer: string, via?: string): () => void;
}
type Phase =
	| "idle"
	| "signing_in"
	| "checking"
	| "web_available"
	| "needs_sign_in"
	| "cleanup_unknown";

/**
 * One owner; kernel expiry remains authoritative if this process disappears.
 * The owner is the phone's address plus, behind the front door, the interface
 * it was proven to arrive on, so the same address seen on another link cannot
 * drive the window.
 */
const ownerKey = (peer: string, via?: string) =>
	via === undefined ? peer : `${peer}%${via}`;

export function createSignInWindow(deps: WindowDeps) {
	let owner: string | undefined;
	let phase: Phase = "idle";
	let busy = false;
	let refreshing = false;
	let generation = 0;
	let expiresAt: number | undefined;
	let disarm: () => void = () => undefined;
	const status = (peer: string, via?: string) => {
		const key = ownerKey(peer, via);
		return {
			phase: owner && key !== owner ? ("idle" as const) : phase,
			expiresAt: owner === key ? expiresAt : undefined,
		};
	};
	const finish = async (peer: string, via?: string) => {
		if (ownerKey(peer, via) !== owner || busy) throw Error("busy_other_phone");
		if (phase !== "signing_in" && phase !== "cleanup_unknown")
			return status(peer, via);
		busy = true;
		phase = "checking";
		try {
			await deps.close();
		} catch {
			phase = "cleanup_unknown";
			busy = false;
			return status(peer, via);
		}
		disarm();
		expiresAt = undefined;
		try {
			phase = (await deps.check()) ? "web_available" : "needs_sign_in";
		} catch {
			phase = "needs_sign_in";
		}
		busy = false;
		return status(peer, via);
	};
	return {
		status,
		finish,
		async start(peer: string, radio: string, via?: string) {
			if (busy || phase === "signing_in" || phase === "cleanup_unknown")
				throw Error("busy_other_phone");
			busy = true;
			owner = ownerKey(peer, via);
			phase = "idle";
			const ticket = ++generation;
			expiresAt = Date.now() + 600000;
			try {
				await deps.open(peer, radio, via);
				expiresAt = Date.now() + 600000;
				phase = "signing_in";
				disarm = deps.arm(
					() => {
						if (generation === ticket)
							void finish(peer, via).catch(() => undefined);
					},
					peer,
					via,
				);
			} catch (error) {
				try {
					await deps.close();
				} catch {
					phase = "cleanup_unknown";
					expiresAt = Date.now() + 600000;
					disarm = deps.arm(
						() => {
							void finish(peer, via).catch(() => undefined);
						},
						peer,
						via,
					);
					return status(peer, via);
				}
				expiresAt = undefined;
				throw error;
			} finally {
				busy = false;
			}
			return status(peer, via);
		},
		async refresh(peer: string, via?: string) {
			if (
				ownerKey(peer, via) !== owner ||
				(phase !== "signing_in" && phase !== "cleanup_unknown") ||
				busy ||
				refreshing
			)
				return status(peer, via);
			if (phase === "cleanup_unknown") return finish(peer, via);
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
				return finish(peer, via);
			return status(peer, via);
		},
	};
}
