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
| `lock` | The refusals Start applies before launching: an update phase that refuses streams (`update_in_progress`), recovery replay (`recovery_pending`), the modem journal's global stream hold (its refusal code), the lifecycle interlock held by a modem transition (`MODEM_TRANSITION_ACTIVE`) or by another start (`START_IN_PROGRESS`). | `ok` |
| `source` | `config.source` resolved with `resolveSourceRouting` exactly as Start resolves it, then the offered-set, network-ingest gateway and audio-codec/transport gates, with Start's own codes. `no_source` when nothing is configured. | `ok` |
| `receiver` | `receiver_not_set` blocks. Evidence for the configured destination, kept 30 min: a `relay.validate` that reached it (`ok`), was refused (`receiver_refused`) or did not resolve (`receiver_unresolved`). A silent UDP port is no evidence. Without evidence: `unknown` / `receiver_untested`. | `ok` once a link carries stream data (the sender sends stream data only after the receiver's handshake); that is also kept as evidence. |
| `uplinks` | At least one uplink health record is `up`, or `degraded` by passive congestion only. `no_uplink` when there are no records, `no_uplink_passes` when none passes. | `linkCarryingState` per uplink: `ok` when one carries, blocked `no_link_carrying` when every link positively carries nothing, else `unknown` / `carrying_unknown`. |

## Not covered

- Onboard HDMI signal presence: Start reads it at launch (an async sysfs read).
- The sender-ownership census (a `/proc` scan Start runs at admission).
- The receiver's own per-link view; carrying is the sender's view.

## Consumers

- Live bar (idle): when the client-side `deriveGoLiveReadiness` does not block
  and the device says not ready, the bar shows the device's line as a warning.
  Start stays governed by the client verdict and the backend's own refusals.
- Support log download: one `Stream readiness` JSON line after the carrier
  summary, codes and counts only.
