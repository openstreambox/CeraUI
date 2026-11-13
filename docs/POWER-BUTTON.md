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

Admission requires an IPv4 peer and trusted arrival-interface evidence for a
directly attached Ethernet or Wi-Fi link captured at HTTP upgrade. All Forwarded,
X-Forwarded-* and Via headers are refused, including empty values. The interface
must match the on-link interface; VPN arrival and unknown arrival are refused.
Bun's ordinary TCP listener exposes no trusted incoming interface and always
uses password sign-in for button requests. A protected Unix RPC endpoint now
accepts trusted image-helper evidence and revalidates the local interface address
before every button action. The matching helper remains a separate image
follow-up; older images still use password sign-in. See [ingress design and image
contract](BUTTON-INGRESS.md) for the options, privilege boundary, address-change
rules and proxy limitations. Relay sender IDs cannot grant presence. IPv6-only
clients retain the existing sign-in path. Disconnect-all additionally requires confirmed
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

Disconnect deauthenticates and closes transports before attempting durable token
revocation. The store records in-memory denial before writing; a failed save is
retried up to three attempts with 100 ms between attempts. Failure retains the
in-memory intent for subsequent store operations, logs the partial outcome and
returns `persistence-failed`, never confirmed success. The UI has explicit copy
that saved credentials may work after restart, but its socket may already have
closed before the result arrives. Server logs remain the diagnostic in that
case. Retry after restoring storage; a failed save is not durable revocation.
The image's additive `FAILED INPUT` reply is treated as unavailable and never
as physical confirmation.
