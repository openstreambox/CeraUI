# Status screen snapshot

The device image paints a plain status page on a monitor plugged into the
box, meant to be photographed and sent to support when the box has no network
(image-building-pipeline `docs/status-screen.md`). The page reads the box's
own facts itself; what only CeraUI knows reaches it through one file, written
by `apps/backend/src/modules/system/status-screen-snapshot.ts`.

## File

`/run/ceralive/status-screen/snapshot.json`, mode 0644, replaced atomically
(temporary file and rename) in a directory owned by the backend's user and not
writable by group or others. A symlinked or shared directory, or a symlink in
place of the file, is refused rather than written through. A leftover file
with other permissions ends up 0644. At most 16 KiB.

It is rewritten when its content changes (checked every 2 s), at least every
30 s of monotonic time, and at once when the wall clock steps by more than
5 s, so a clock correction never leaves an expiry outside the page's window.
`expires` is 90 s ahead, so the page shows "the application has not reported"
within 90 s of the backend stopping. Not written under mocks.

```json
{"schema":2,"expires":1800000090,"ceraui":"2026.11.21",
 "uplinks":[{"kind":"ethernet","state":"down"},{"kind":"cellular","state":"up"}],
 "modems":[{"sim":"present"},{"sim":"locked"}],
 "ready":{"ready":false,"code":"no_uplink_passes"},
 "last_error":{"code":"start_timeout","at":1800000000}}
```

| Field | Source |
|---|---|
| `ceraui` | The numeric release part of `/opt/ceralive/version` (two to four dotted ASCII numbers); any suffix is dropped |
| `uplinks` | Uplink health records, sorted by interface name: `kind` and `state` only, at most 8 |
| `modems` | The published modem rows, by modem id, router-mode dongles skipped: `sim` is `locked` when the SIM asks for its PIN or PUK, else `present` or `absent` as the modem reported it, else `unknown`; at most 8 |
| `ready` | The stream-ready flag from its last 2 s tick (`docs/STREAM-READINESS.md`): `ready` and the reason code when the page has wording for it, else `other`. Left out when the last answer is older than 10 s, measured on monotonic time from the start of its evaluation, so a clock step or an evaluation that keeps failing never keeps an old answer on the page |
| `last_error` | The failure class of the last failed start (one of the start taxonomy's classes), cleared by a start that succeeds; in memory only |

`url` is not written: the page picks the box's own address for the QR code.

## What can never appear

The file carries enum values, checked tokens and numbers only. Each field is
rebuilt from an enum or a token check, never copied as an object, so there is
no field for free text: no interface or device names, operator names, Wi-Fi
names or passwords, destinations, stream keys or IDs, IMEI, ICCID or phone
numbers, failure messages or logs. Codes are members of fixed sets (the ready
codes the page knows, `STATUS_SCREEN_READY_CODES`, and the start failure
classes); a token-shaped value outside them is never passed on. The page maps
codes to its own fixed wording and never prints a code.

`apps/backend/src/tests/status-screen-snapshot.test.ts` plants such values in
every text slot of the inputs, and token-shaped secrets in the code fields,
and checks that none reaches the file, that
every key is on the allowlist and every string is an enum value or a checked
token.
