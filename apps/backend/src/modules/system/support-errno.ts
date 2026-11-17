import { constants } from "node:os";

/** Error codes a system-call error may carry: the platform's errno names plus
 * the resolver failures Node reports (getaddrinfo ENOTFOUND, EAI_AGAIN …).
 */
export const errno: ReadonlySet<string> = new Set([
	...Object.keys(constants.errno),
	"ENOTFOUND",
	"EAI_AGAIN",
	"EAI_FAIL",
	"EAI_NONAME",
	"EAI_NODATA",
	"EAI_SERVICE",
]);
