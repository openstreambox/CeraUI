# Link-family network acceptance

Run `proof.py` as root inside fresh PID, mount and network namespaces. Supply
`BUN`, `SRTLA_RECEIVER` (dual-stack), `SRTLA_IPV4_RECEIVER`, `TAYGA_BIN` and
`PROOF_OUTPUT` as explicit paths. The namespace must provide its own minimal
`/dev`, including a newly created TUN node; never pass host devices through.
The sender under test is `/usr/bin/srtla_send` inside that namespace.

Mixed-family acceptance requires the source-family destination and reload
registration fix in [sender PR #2](https://github.com/openstreambox/srtla-send-rs/pull/2),
commit `c926093842a8a4f51d65d9a7758c889fa6138b53` or a release containing it.
The tested build identifies as 4.2.0; a version string alone is insufficient
until that fix is released. Installed 4.1.0 is the negative control: it must
still fail forwarding after the IPv6-to-IPv4 transition.

Every packet case requires exactly 30 synthetic markers: native IPv6,
dual-stack native IPv4, IPv6-only CLAT/NAT64, before and after IPv6 loss,
mixed reload, reverse and repeated family changes, and mixed startup.
Mixed startup additionally requires registration of both source sockets and
no address-family error. Transitions reload the same sender process.
These checks qualify synthetic transport, not decoded media or hardware.

The CLAT case owns a receiver `/32` route. Its teardown removes that route
before restoring native IPv4; otherwise it overrides the connected `/24`
and contaminates subsequent cases. Keep the loss hold, reload delays and
packet assertions unchanged when changing fixture setup or teardown.
