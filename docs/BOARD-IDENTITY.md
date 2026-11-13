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
