import { PauseLease } from "../../modules/network/heat-client-pause.ts";

const owner = new PauseLease();
if (process.argv[2] === "clear") {
	await owner.clear();
} else {
	await owner.update(() => ({
		iface: "ap0",
		address: "192.0.2.3",
		phone: false,
		management: false,
		ipv6Absent: true,
	}));
	if (process.argv[2] === "hold") {
		const ready = process.argv[3];
		if (!ready) throw new Error("Missing readiness path");
		await Bun.write(ready, "ready");
		setInterval(() => {
			// Keep the actual lease owner alive until the crash fixture kills it.
		}, 1000);
	}
}
