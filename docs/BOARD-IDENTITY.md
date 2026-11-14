# Image board identity

The image owns `/etc/ceralive/release` (root-owned, mode 0444, in each OS
slot). In addition to branding, it supplies data-only `ID=ceralive`, `BOARD`,
`FAMILY` and a quoted space-separated `CAPABILITIES` list. Board/family tokens
contain lowercase letters, digits, hyphens or underscores. Capability names
use lowercase letters, digits and hyphens. No shell evaluation is performed.

`modules/system/board-capabilities.ts` is the control plane's capability gate.
A valid record is authoritative, including an empty capability list. Missing or
unreadable records fall back to the unchanged legacy RK3588 / x86
mini-PC classifier. Development/mock mode and the existing explicit device-type
seam keep their previous precedence. This is a local image trust contract, not
hardware attestation or engine capture/encode negotiation.

Network routing, sharing diagnostics and traffic shaping require
`client-internet`; ingest service management requires `network-ingest`; modem
operations require `modem-control`; SIM replay requires `sim-autounlock`;
regulatory writes require `wifi-country`; update paths require `os-updates`;
add-ons, kiosk, Bluetooth, audio, fan and encoder statistics have separate gates.
Pairing/control channels use `device-control`, package revisions and boot
identity diagnostics use `system-control`. Injected gates use capability-specific
names such as `canRouteClients`,
`canUnlockSim`, `canManageModems`, `canManageAddons`, `canManageIngest` and
`canManageBluetooth`; fixtures and mock providers implement those same contracts.
Their production defaults resolve the corresponding image capability. The legacy
detector remains exported for older consumers, but production subsystem defaults no longer call it directly.

`hdmi-rx`, `b-key-modem` and `hw-encoder` describe profile hardware; absence must
never be interpreted as permission to enable it. Board facts do not imply that
an attached peripheral is present or that an encoder is currently healthy.

A new family needs an image profile declaring its installed services explicitly.
The record alone neither qualifies hardware nor adds an OTA channel, boot
adapter, engine driver, sensor mapping or recovery support for that family.

An attempted but malformed/incomplete board record denies capabilities rather than
silently enabling legacy permissions. Older branding-only release files still use
the legacy detector.

Admission and authentication are separate decisions. A production control channel
with no `device-control` grant never dials, and unsigned control tokens are
accepted only in explicit development/mock mode. `os-updates` denial refuses
manual submission, discovery, scheduled work and staging admission before effects;
it never selects the legacy APT transport. The synchronous submission fence reads
the same record/parser as asynchronous capability checks. Branding-only and
unreadable older-image records retain compatibility; whitespace-malformed board
assignments are present records and deny grants. Ingest RPC and service control
both require `network-ingest`, independently of `client-internet`.

Records granting `os-updates` but missing or empty `UPDATE_BOARD`,
`UPDATE_COMPATIBLE` or `KERNEL_ARCH` are unsupported update policies. Kernel
candidate discovery returns before inspecting the booted kernel or APT indexes.
Manual and scheduled checks can therefore publish the calm unsupported-board
state without a kernel identity error; staging and installation remain refused.
Branding-only legacy records retain the existing fallback.

Kernel reconciliation applies the same unsupported-policy verdict after inspecting
any pending stage writer. A running or unidentifiable writer still blocks other
work. Otherwise checks can publish the unsupported-board state without reading
kernel identity or arming activation. The kernel receipt, attempt and overlay
remain intact and unacknowledged, so rollback and confirmation reconciliation
resume when supported policy is restored. New kernel and OS installs stay
unavailable, and automatic slot mirroring is disabled even if its capability is
present. Unsupported metadata never authorizes cleanup or activation.
