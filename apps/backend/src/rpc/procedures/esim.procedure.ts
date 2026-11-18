import {
	esimOperationInputSchema,
	esimOperationOutputSchema,
} from "@ceraui/rpc/schemas";

import { runEsimOperation } from "../../modules/modems/esim.ts";
import { modemProcedure } from "./modems.procedure.ts";

export const esimOperationProcedure = modemProcedure
	.input(esimOperationInputSchema)
	.output(esimOperationOutputSchema)
	.handler(({ input }) => runEsimOperation(input));
