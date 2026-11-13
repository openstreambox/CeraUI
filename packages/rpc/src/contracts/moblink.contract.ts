import { oc } from '@orpc/contract';
import {
	moblinkCredentialInputSchema,
	moblinkResultSchema,
	moblinkStatusSchema,
} from '../schemas/moblink.schema';
export const moblinkContract = oc.router({
	getStatus: oc.output(moblinkStatusSchema),
	setCredential: oc.input(moblinkCredentialInputSchema).output(moblinkResultSchema),
	clearCredential: oc.output(moblinkResultSchema),
});
