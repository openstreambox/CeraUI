# Stream readiness

One answer to "can this device go live right now?", with the reason when it
cannot. The backend computes it; the Live bar, the support log and any local
status display read the same value.

## Wire

`stream_readiness` is pushed to authenticated clients on connect and whenever
the answer changes (re-evaluated every 2 s; the timestamp alone never causes a
push). Schema: `packages/rpc/src/schemas/stream-readiness.schema.ts`.

```json
{"ready":false,"live":false,"reason":{"check":"uplinks","code":"no_uplink_passes"},
 "checks":[{"id":"lock","state":"ok"},{"id":"source","state":"ok"},
           {"id":"receiver","state":"unknown","code":"receiver_untested"},
           {"id":"uplinks","state":"blocked","code":"no_uplink_passes"}],
 "uplinks":{"usable":0,"total":2},"at":1795250000000}
```

Only a `blocked` check makes `ready` false. `unknown` is reported and never
blocks. `reason` is the first blocked check in the order below, else the first
unknown one, else absent. The message is local only; the remote status
projection does not carry it (`docs/remote-status-inventory.json`).

## Checks

| Check | Before going live | While live |
|---|---|---|
| `lock` | Start's refusals in Start's order: recovery replay (`recovery_pending`), the modem journal's global stream hold (its refusal code), a session Start would call busy (`START_IN_PROGRESS`, from the orchestrator's read-only `startView`; a session Start would first reconcile is `unknown` / `session_reconciling`), the lifecycle interlock through `previewStreamingAdmission`, which the acquiring path shares (forwarding, per-device modem leases, a modem transition, another start), then the update admission (`update_in_progress`; a `downloading` phase whose admission needs a fresh probe is `unknown` / `update_state_unconfirmed`). | `ok` |
| `source` | `config.source` resolved with `resolveSourceRouting` exactly as Start resolves it, then the offered-set, network-ingest gateway and audio-codec/transport gates, with Start's own codes. `no_source` when nothing is configured. | `ok` |
| `receiver` | The saved destination resolved with `resolveStreamEndpoint` and the relay catalog, as Start does: nothing set is `receiver_not_set`, a throw (unknown relay id, missing stream ID, bad port) is `receiver_invalid`; both block. Evidence for that resolved host and port, kept 30 min per endpoint (at most 16): a `relay.validate` that reached it is `ok`; refused by the peer on every address blocks (`receiver_refused`); a timeout, a failure on this box (socket setup, or a send error other than `ECONNREFUSED`, marked `local` by the probe), an exhausted budget or a failed name lookup is `unknown`. | `ok` when a sender link carries stream data, else `unknown`. The saved destination is not judged: it may already be the next one. Nothing is recorded. |
| `uplinks` | Start's own bond-entry collectors pick the interfaces, so identity settlement, duplicate-IP mapping and the bond toggle apply as at launch: the same-subnet list for a receiver address Start treats as local (`isLocalIp`), any of which will do; otherwise the bond list, each qualified by a fresh health record (`up`, or `degraded` only by passive congestion). `no_uplink` with no candidate, `no_uplink_passes` when every candidate fails a fresh check, `unknown` / `uplink_unchecked` when a candidate has no fresh record. |

## Not covered

- Onboard HDMI signal presence: Start reads it at launch (an async sysfs read).
- The sender-ownership census (a `/proc` scan Start runs at admission).
- The receiver's own per-link view; carrying is the sender's view.
- The flag calls Start's own functions every 2 s while idle (the bond-entry
  collectors, the session liveness view). On some paths they read sysfs or the
  OTA marker file and may log once; a cached view would avoid that.
- A hostname receiver is judged by the bond list. When Start's DNS falls back
  to a cached private address it takes the local list instead, which the flag
  does not predict.

## Consumers

- Live bar (idle): when the client-side `deriveGoLiveReadiness` does not block
  and the device says not ready, the bar shows the device's line as a warning.
  Start stays governed by the client verdict and the backend's own refusals.
- Support log download: one `Stream readiness` JSON line after the carrier
  summary, codes and counts only.
