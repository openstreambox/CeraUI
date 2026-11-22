# Experimental Wi-Fi import

`wifi.addFromCompanion` saves one infrastructure connection to NetworkManager.
It returns a profile UUID after NetworkManager acknowledges the save. The
profile has autoconnect disabled. Select it on a station adapter in CeraUI
when ready to join. Existing controls handle connecting and forgetting.

The backend flag `CERAUI_EXPERIMENTAL_COMPANION_WIFI=1` enables the RPC. It
requires a signed-in native WebSocket on the backend's TCP loopback listener.
Run the stub on the box or reach that listener with an SSH local forward.
Keep the listener off reverse proxies for this experiment. A TCP proxy on
the same host can make its traffic look like loopback.

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
with that stdin. The stub displays the SSID and security and asks before
sending anything. Feed real credentials through a private pipe.

Native clients use the existing `auth.login` token login and submit the same
object with the token removed and `"consent": true` added. Security values are
`open`, `wpa-psk` and `sae` (QR types `nopass`, `WPA` and `SAE`).
Structured input accepts an optional boolean `hidden` and QR input accepts
`H:true` or `H:false`. The scanner supplies decoded text. Enterprise, WEP,
OWE, non-text SSIDs and non-ASCII passphrases are outside this prototype.

Results are `saved` with a UUID, `disabled`, `local_only`, `invalid` or
`save_failed` in the `status` field. If the reply is lost, check saved
networks before retrying. A second import with the same SSID cannot update
the earlier import. Existing profiles with different UUIDs stay in place.
NetworkManager stores the credentials in its system profile. The RPC trace
omits the input and NetworkManager receives it over D-Bus.

When the connected venue asks for sign-in, use the existing [Wi-Fi sign-in
window](CAPTIVE-PORTAL.md) from a phone attached to the box's Wi-Fi.
