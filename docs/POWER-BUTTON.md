# Optional local power-button confirmation

The backend speaks version 1 of the image's root-only
`/run/ceralive-button/control.sock` protocol. It sends `CONFIRM 60\n` and
waits for `READY\n` before displaying a double-press prompt. Only
`CONFIRMED\n` authorizes the selected action. Busy, missing, closed, malformed
or unresponsive sockets never authorize anything.

The sign-in screen offers connect-a-new-device and an Advanced → Connected
devices disclosure for local recovery. Settings offers Disconnect all devices
under the same heading. This uses the current browser credential store, not
cloud account pairing: connection issues a remembered browser token; disconnect
revokes all remembered and temporary browser tokens and deauthenticates/closes
existing UI sockets. Settings, recordings and saved passwords are untouched.
The existing password sign-in remains available, including on older images.

Requests belong to their originating WebSocket and a server-issued ID. Polling
keeps a five-second UI lease alive. Cancel, transport close, navigation or loss
of polling closes the held socket. Results are consumed once. A late admission
after cancellation is closed. The service's sixty-second timeout remains an
independent bound.

Admission requires an IPv4 peer on a directly attached Ethernet or Wi-Fi
interface captured at HTTP upgrade. Forwarded headers, loopback proxies, VPN
interfaces and relay sender IDs cannot grant presence. IPv6-only clients retain
the existing sign-in path for now. Disconnect-all additionally requires confirmed
idle engine/lifecycle evidence, including recording-only sessions; unknown,
starting, stopping or reconciling states refuse it. Admission is checked again
after confirmation and after token-store settlement, immediately before effects.

Stream status transitions publish `LIVE 1\n` / `LIVE 0\n`. A serialized
ten-second refresh republishes current state after a button-service restart.
Missing service or failed acknowledgement does not block stream start/stop.
The flag is advisory and never changes the required shutdown hold duration.

English is the base copy; new untranslated catalog entries carry the English
fallback while preserving locale key parity. No copy promises a visible LED
countdown or that a board remains powered. Input delivery, physical timings,
LED ownership and external power supervisors require separate device validation.

The full card-secret/new-code handover, named-device inventory, first-visitor
window and card reset writer are separate work. This change does not implement
them or claim their availability.

Host tests use a temporary Unix socket, synthetic transport contexts and fake
confirmation events. They do not read evdev or issue power commands.
