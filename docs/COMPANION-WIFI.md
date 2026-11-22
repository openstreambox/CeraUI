# Experimental Wi-Fi import

`wifi.addFromCompanion` saves one infrastructure connection to NetworkManager.
It returns a profile UUID after NetworkManager acknowledges the save. The
profile has autoconnect disabled. Select it on a station adapter in CeraUI
when ready to join. Existing controls handle connecting and forgetting.

The backend flag `CERAUI_EXPERIMENTAL_COMPANION_WIFI=1` enables the RPC. It
requires a signed-in native WebSocket on the backend's TCP loopback listener.
Run the stub on the box or reach that listener with an SSH local forward.

On images with the device-bound front door (the `/run/ceralive-button-ingress`
directory exists), the RPC always returns `local_only`. The front door
forwards every client to the TCP listener from 127.0.0.1, so a loopback peer
says nothing about where the client is. Import on those images needs its own
root-only listener, which this prototype does not add. Any other reverse
proxy or TCP forwarder on the box has the same effect and is not detected, so
keep the listener off them while the flag is on.

The stub takes a single JSON object on stdin from the companion's private
credential source, with a CeraUI session token and either a structured network
or the text decoded from a QR. These examples use synthetic values.

```json
{"token":"sample-session","network":{"ssid":"Studio","security":"wpa-psk","password":"sample-only"}}
```

```json
{"token":"sample-session","qr":"WIFI:T:WPA;S:Studio;P:sample-only;;"}
```

Run `bun apps/backend/scripts/companion-wifi-import.ts ws://127.0.0.1:8080/ws`
with that stdin. Before sending anything, the stub shows the SSID, security
and destination URL and asks for confirmation. Invisible characters in the
SSID (zero-width, bidirectional, soft hyphen, byte order mark, non-ASCII
spaces) are spelled out as `\u{XXXX}` with a warning, so a lookalike name
does not read the same as the real one. Feed real credentials through a
private pipe.

Native clients use the existing `auth.login` token login and submit the same
object with the token removed and `"consent": true` added. Security values are
`open`, `wpa-psk` and `sae` (QR types `nopass`, `WPA` and `SAE`).
Structured input accepts an optional boolean `hidden` and QR input accepts
`H:true` or `H:false`. The scanner supplies decoded text. Enterprise, WEP,
OWE, non-text SSIDs and non-ASCII passphrases are outside this prototype.

Results are `saved` with a UUID, `already_saved`, `disabled`, `local_only`,
`invalid` or `save_failed` in the `status` field. If the reply is lost, check
saved networks before retrying. WPA3-SAE profiles are stored with PMF
required, as CeraUI's own SAE joins are.

CeraUI lists one saved profile per SSID. When several station profiles share
an SSID, one of them (a profile bound to the adapter first) is the one a join
uses, and Forget on that row deletes all of them. An import therefore never
adds a second profile: if NetworkManager already has a station profile for
the SSID, from CeraUI, an earlier import or any other tool, the reply is
`already_saved` and nothing is written. To replace the password, Forget the
network in CeraUI, which removes every profile for that SSID, then share it
again. Hotspot profiles with the same name are not affected and are not
counted. After a save the backend refreshes only station rows and never
touches hotspot profiles.

NetworkManager stores the credentials in its system profile and receives them
over D-Bus. The RPC trace omits this route's input. Log redaction removes any
decoded Wi-Fi QR text from every log record, whatever route or frame carried
it, and malformed or unrecognised frames are logged by size and top-level
keys only.

When the connected venue asks for sign-in, use the existing [Wi-Fi sign-in
window](CAPTIVE-PORTAL.md) from a phone attached to the box's Wi-Fi.
