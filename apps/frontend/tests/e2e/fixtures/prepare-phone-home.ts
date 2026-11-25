import { compile } from "@inlang/paraglide-js";
import {
	PARAGLIDE_OUTDIR,
	PARAGLIDE_PROJECT,
	PARAGLIDE_STRATEGY,
} from "../../../vite.i18n.js";

// Run once before servers/workers, never from a worker fixture.
await compile({
	project: PARAGLIDE_PROJECT,
	outdir: PARAGLIDE_OUTDIR,
	outputStructure: "message-modules",
	strategy: [...PARAGLIDE_STRATEGY],
});
