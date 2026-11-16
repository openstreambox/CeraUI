<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## HOTSPOT QR SURFACE — ONE QR, AND IT IS ESCAPED [EXISTS]

`HotspotDialog` renders exactly ONE QR: the WiFi-join code carrying the live
hotspot credentials (`generateWifiQr`, gated on `isActive`). **Do not add a second
one.**

The connect-your-phone section (#67 Phase-0) that used to sit beneath it — a
device-access QR encoding `http://<gatewayIp>/` so a joined phone could open
CeraUI — is REMOVED by explicit product decision after live board QA: two QR codes
in one dialog read as noise, and the operator has to join the hotspot before the
second one is reachable anyway. The removal took its whole stack with it, all of
which had exactly one consumer: `ConnectPhoneSection.svelte` + its test, the
`connect-phone.visual.spec.ts` e2e, the `wifi.hotspotInfo` RPC (procedure, router
registration, `client.ts` binding, `HotspotInfoOutput`/`HotspotInfo` schema,
`modules/wifi/wifi-hotspot-info.ts`, and its backend test), and the five
`network.hotspot.connectPhone*` / `deviceAccessQrLabel` / `navigateManuallyNote` /
`hotspotOffPrompt` i18n keys across all 10 locales.

`generateDeviceAccessQr` is deliberately UNTOUCHED — it is a shared helper with
three other live consumers (`NetworkIngestSection`, `SourceSection`,
`CloudRemoteDialog`) and nothing to do with the hotspot.

**`generateWifiQr` escapes the four WIFI-QR reserved characters.** The payload is
`WIFI:T:<enc>;S:<ssid>;P:<password>;;`, and the de-facto standard ZXing (and every
phone camera that follows it) parses `\`, `;`, `,` and `:` as field structure — so
a hotspot name or password containing one of them must carry a backslash before it
or the scanner reads a field boundary mid-credential and joins the wrong network,
or none at all. Nothing validates the hotspot name/password against those
characters, so this is reachable by any operator who picks one. `escapeWifiQrField`
does it in ONE pass over a character class, and that is load-bearing: escaping the
four in sequence would re-escape the backslashes the earlier steps just inserted.
Coverage: `NetworkHelper.test.ts` asserts the EXACT payload string handed to the QR
encoder — including a plain-alphanumeric regression guard proving today's board
credentials are byte-unchanged.

**The QR is hidden until asked for (D16 S step).** Both Wi-Fi join surfaces, the
hotspot dialog and the phone Home's join step, render it through
`$main/network/WifiCode.svelte`: an empty same-size frame plus **Show code**
(`aria-expanded`/`aria-controls`), the off-camera line while shown, and a self-hide
after `WIFI_CODE_SHOW_MS` (2 min), on window blur or a hidden page, on a password
change and on a join. Screens that should carry no QR (`showPhoneQr` false: phone
widths, the kiosk) pass `qr={false}` and get the join line and New Wi-Fi password
only. The card is still the ONE hotspot QR.

**Join notice, no new notification type.** `$lib/stores/hotspot-joins.svelte.ts`
diffs the `hotspot.clients.stations` roster each wifi snapshot carries
(`$main/network/hotspot-joins.ts`: first reading is a baseline, an address counts
once per page) and calls the existing `svelte-sonner` toast, unless a `WifiCode`
card is mounted, which shows "A new device joined · just now · Not mine?" in place.
The backend makes it prompt and honest: `wifi-hotspot-station-events.ts` runs
`iw event` (spawn site `wifi.iwStationEvents`) only while a hotspot is up and turns
nl80211 `new station`/`del station` lines on an AP interface into roster reads (now,
+1 s, +3 s), and `parseIwStationDump` skips `authorized: no` stations, so a phone
with a wrong password is never counted as joined.

**New Wi-Fi password** (`$main/network/hotspot-new-password.ts`) re-sends the live
name, channel and security with a fresh `generateHotspotPassword()` through
`wifi.hotspotConfigure` under the Save key; NetworkManager restarts the profile, so
every client drops. The card asks first and names that cost, plus
`live.phone.powerOffCost` when `mayCarryStream` says a stream may be going through
the box. In the hotspot dialog a completed renewal also replaces the editable
password, so a later Save cannot restore the revoked one. The dialog keeps a
reactive renewal record bound to its form binding (radio, link, dialog session),
the config key and the op attempt (`getOperationAttempt`), and writes the field
only when the dispatch ack and the `hotspot.config` confirmation of that attempt
have both arrived, in either order. Close, rebind, failure, timeout or a replaced
attempt drops the record.

