/**
 * How long an RPC call waits for its reply before it rejects. A rejection here
 * means the reply never arrived, NOT that the device refused: the procedure may
 * still be running on the device (an OS install answers only once staging is
 * done). Its own module so a surface can size its busy state from it without
 * importing the transport.
 */
export const RPC_CALL_TIMEOUT_MS = 30_000;

/** Explicit budgets for operations that can legitimately exceed the default call window. */
export const PROCEDURE_TIMEOUT_MS: Readonly<Record<string, number>> = {
	"streaming.start": 75_000,
	// Two 15 s journal attempts plus cancellation, redaction and delivery.
	"system.getLog": 45_000,
	"system.getSyslog": 45_000,
	// Boot sweep + pre-open sweep + open/rollback + retirement, plus identity reads.
	"wifi.portal": 540_000,
	"modems.esimOperation": 245_000,
};

export function rpcCallTimeoutMs(path: string): number {
	return PROCEDURE_TIMEOUT_MS[path] ?? RPC_CALL_TIMEOUT_MS;
}
