import { cellularConsumersAbsentWhile } from "../network/cellular-consumer-census.ts";
import {
	type CellularWithdrawalScope,
	createCellularWithdrawalReceipt,
} from "../streaming/cellular-withdrawal-receipt.ts";
import {
	type LifecycleLease,
	tryAcquireLifecycle,
} from "../streaming/lifecycle-admission.ts";

/** Consumer proof belongs to this retained path and exact withdrawn source.
 * A no-sender result additionally holds the existing stream-admission interlock
 * through the entire inverse, with positive service/cgroup absence. finish()
 * releases that interlock on every exit; a later retry takes fresh evidence.
 */
export class CellularRuntimeConsumers {
	private receipt: { readonly confirmed: () => boolean } | undefined;
	private lease: LifecycleLease | undefined;
	private absent = false;
	constructor(private readonly scope: CellularWithdrawalScope) {}
	async confirmed(): Promise<boolean> {
		if (this.receipt) return this.receipt.confirmed();
		this.receipt = await createCellularWithdrawalReceipt(this.scope, {
			absent: async () => {
				this.absent = true;
				if (!this.lease) {
					const admission = tryAcquireLifecycle("modem-transition");
					if (!admission.admitted) return false;
					this.lease = admission.lease;
				}
				return cellularConsumersAbsentWhile(
					() => !!this.lease && this.scope.owned(),
				);
			},
		});
		return !!this.receipt?.confirmed() && (!this.absent || !!this.lease);
	}
	finish(complete: boolean): void {
		this.lease?.release();
		this.lease = undefined;
		if (this.absent || complete) this.receipt = undefined;
		this.absent = false;
	}
}
