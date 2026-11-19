/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * Helper actions. These do not use the auth middleware: a missing login
 * and a remote channel are both structured refusals from the action gate.
 * Hiding the button is not the enforcement.
 */

import { os } from "@orpc/server";
import { z } from "zod";

import {
	HELPER_ACTION_REFUSALS,
	type HelperCaller,
	readHelperActionOffer,
	runHelperAction,
} from "../../modules/devices/usb-helper-actions.ts";
import type { RPCContext } from "../types.ts";

const base = os.$context<RPCContext>();

const refusalSchema = z.enum(HELPER_ACTION_REFUSALS);

const resultSchema = z
	.object({
		ok: z.boolean(),
		refusal: refusalSchema.optional(),
	})
	.strict();

const offerSchema = z
	.object({
		ok: z.boolean(),
		refusal: refusalSchema.optional(),
		retryPort: z.boolean(),
		rearmExhausted: z.boolean(),
		usb2: z.boolean(),
	})
	.strict();

const confirmedSchema = z
	.object({
		confirmed: z.boolean(),
	})
	.strict();

const usb2Schema = z
	.object({
		confirmed: z.boolean(),
		key: z.string().min(1).max(120),
	})
	.strict();

function callerFrom(context: RPCContext): HelperCaller {
	return {
		authenticated: context.isAuthenticated(),
		senderId: context.getSenderId(),
		remoteAddress: context.ws.remoteAddress,
	};
}

export const helperOfferProcedure = base
	.output(offerSchema)
	.handler(async ({ context }) => {
		const offer = await readHelperActionOffer(callerFrom(context));
		if (!offer.ok) {
			return {
				ok: false as const,
				refusal: offer.refusal,
				retryPort: false,
				rearmExhausted: false,
				usb2: false,
			};
		}
		return offer;
	});

export const helperRetryPortProcedure = base
	.input(confirmedSchema)
	.output(resultSchema)
	.handler(async ({ input, context }) => {
		return runHelperAction(
			{ action: "retry-port", confirmed: input.confirmed },
			callerFrom(context),
		);
	});

export const helperUsb2Procedure = base
	.input(usb2Schema)
	.output(resultSchema)
	.handler(async ({ input, context }) => {
		return runHelperAction(
			{ action: "usb2", confirmed: input.confirmed, key: input.key },
			callerFrom(context),
		);
	});
