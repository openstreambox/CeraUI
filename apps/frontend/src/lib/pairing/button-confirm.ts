import type { ButtonInput, ButtonOutput } from "@ceraui/rpc/schemas";

/** Poll only while this UI owns the prompt. Epochs discard late replies. */
export class ButtonConfirm {
	private epoch = 0;
	private active = false;
	private timer?: ReturnType<typeof setTimeout>;
	constructor(
		private readonly call: (input: ButtonInput) => Promise<ButtonOutput>,
		private readonly changed: (output: ButtonOutput) => void,
		private readonly connected: (token: string) => void,
	) {}
	cancel() {
		this.epoch++;
		clearTimeout(this.timer);
		if (!this.active) return;
		this.active = false;
		void this.call({ action: "cancel" }).catch(() => {
			/* Optional service/transport may be absent. */
		});
	}
	async begin(purpose: "connect" | "disconnect") {
		this.active = true;
		const epoch = ++this.epoch;
		clearTimeout(this.timer);
		try {
			const output = await this.call({ action: "begin", purpose });
			if (epoch !== this.epoch) return;
			this.accept(output, epoch);
		} catch {
			if (epoch === this.epoch) this.changed({ state: "unavailable" });
		}
	}
	private accept(output: ButtonOutput, epoch: number) {
		this.active = output.state === "waiting";
		this.changed(output);
		if (output.state === "confirmed" && output.auth_token)
			this.connected(output.auth_token);
		if (output.state !== "waiting" || !output.id) return;
		const id = output.id;
		this.timer = setTimeout(async () => {
			try {
				const next = await this.call({ action: "poll", id });
				if (epoch === this.epoch) this.accept(next, epoch);
			} catch {
				if (epoch === this.epoch) {
					this.changed({ state: "unavailable" });
					this.cancel();
				}
			}
		}, 500);
	}
}
