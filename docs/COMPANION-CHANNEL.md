# Experimental paired companion channel

`companion.*` lets a native companion pair with a box once and then call a
small set of box operations with its own device key, without the CeraUI
password. The first call on it is the companion Wi-Fi import from
[COMPANION-WIFI.md](COMPANION-WIFI.md). The backend flag
`CERAUI_EXPERIMENTAL_COMPANION_CHANNEL=1` enables it; with the flag unset
every route answers `disabled` and no state is created. Nothing here is
reviewed for release.

## Keys

- **Box identity key.** P-256, made on first use in
  `/data/ceralive/companion/identity.key` (0600, directory 0700;
  `CERAUI_COMPANION_STATE_DIR` overrides the directory). Companions pin the
  SHA-256 of its public key. It is separate from the TLS key, which the
  image replaces when the hostname changes.
- **Device keys.** P-256, one per companion, generated and kept by the
  companion. The box stores public keys only.
- **Claim key.** Ed25519, derived with HKDF-SHA256 from a 128-bit setup
  secret and the setup ID. The box stores only its public key, plus a setup
  proof key derived from the same secret, until the first claim.
- **State.** `state.json` beside the identity key: ownership generation,
  access sequence, the unused setup verifier, retired claim keys and the
  device roster. Written atomically. A malformed file makes the channel
  answer `unavailable`; it never resets itself. The box keeps the newest
  1,024 retired claim keys; a code older than that would no longer be known
  as used.

All operations use the runtime's crypto library: HKDF, HMAC-SHA256, Ed25519
and ECDSA P-256 with fixed 64-byte signatures. No new dependencies.

## Protocol

1. `companion.hello {client_nonce}`. The box answers with a nonce, its
   identity key, the generation and access sequence, the channel binding and
   an identity signature over all of it. While setup material is present the
   reply also carries an HMAC with the setup proof key, which lets a companion
   check a box whose QR has no fingerprint. Hellos are rate-limited to 20 per
   10 seconds per interface and peer.
2. `companion.claim` (setup ingress only). The companion signs the
   transcript with the claim key and with its new device key. The box
   commits the owner, drops the setup verifier and retires the claim key
   before it answers. A successful claim also signs in the socket that sent
   it.
3. `companion.auth {device, signature}` for an enrolled device, over a fresh
   hello. Each hello is good for one attempt within 30 seconds.
4. After `auth` or a claim: `devices`, `invite` (a one-time ticket for five
   minutes), `allow {device}`, `revoke {device}` and `wifiImport` (the input
   of `wifi.addFromCompanion`).
5. `companion.join` (setup ingress only) enrolls another device with an
   invite ticket over a fresh hello. The new device waits: it gets no session
   and `auth` answers `pending` until an owner calls `allow`. Both the joiner
   and the owner's device list show the same six-digit code, derived from the
   join transcript, so the owner can tell their device from one that used a
   photographed invite. An owner can turn a waiting device away with
   `revoke`.

Claim, auth, allow and revoke replies carry the new `access_seq` and
`generation`. A companion raises its stored floor from them after every
write, so a box restored to an older copy is caught even right after a
change. Revoking a device closes its sockets with 4403. The last allowed owner
cannot be revoked. Failed claim, join and auth attempts are budgeted per
interface and peer (IPv6 by /64): after five in a row, 30 s doubling to 15
minutes, bounded memory, no global lockout.

## The binding, and what companions must check

The binding is `tls-spki:<SHA-256 of the TLS key the box serves>`. Behind the
front door the box reads it from its certificate file, so the box cannot tell
a relay from a phone; the protection is the companion's check. Every
companion must:

- compute its binding from the live connection: the key the server presented
  in the TLS handshake that carries these calls, never a second connection;
- stop when the hello's binding differs, before it sends a claim, a join or
  any credential;
- accept a `loopback` binding only for a `ws:` URL on a loopback host.

The stub does this in `observedBinding` (`modules/companion/client.ts`).
Binding to the TLS exporter would let the box check too; it needs the front
door to pass the exporter along.

## Where it is accepted

| Arrival | Accepted |
| --- | --- |
| Front door on the interface running the box's hotspot profile | hello, claim, join, auth and calls |
| Front door on another physical link | hello, auth and calls |
| Development runtime only: TCP on an image without the front door, loopback peer, native client (no Origin, no forwarding headers) | everything, binding `loopback` |
| Production runtime without the front door, remote-control relay, overlay or tunnel, TCP behind the front door, stale interface evidence | refused |

The front door's interface evidence is rechecked on every call. The setup
ingress is the interface whose active connection is the hotspot profile; any
other AP-mode connection does not count. The Wi-Fi state reader loads on first
use with the flag on. The development path is the one exception to front-door
evidence: it exists for local testing and SSH forwards on a development
runtime and is off in production builds and launches.

## Stub

```sh
# On the box, once: writes the setup link to a new 0600 file
bun apps/backend/scripts/companion-provision.ts --out /root/setup-link.txt
# On the companion host
bun apps/backend/scripts/companion-channel.ts pair wss://<box>/ws --state ./state < setup-link.txt
bun apps/backend/scripts/companion-channel.ts devices wss://<box>/ws --state ./state
bun apps/backend/scripts/companion-channel.ts wifi wss://<box>/ws --state ./state < network.json
```

Without `--out` the link goes to stdout; redirect it under `umask 077`.
`invite`, `join` (on the box's hotspot), `allow <device-id>` and
`revoke <device-id>` complete the set. The stub's state directory stands in
for a platform key store. It pins the box before sending a claim, so after a
lost reply `devices` shows whether the claim committed.

## Reset

`physicalReset` (`modules/companion/reset.ts`) locks legacy first-password
setup, then clears the owner password and every remembered or temporary
session (`clearLegacyCredentialsForReset`), then the companion roster, and
installs fresh setup material. If the lock fails, nothing is cleared.

## Not in this prototype

The physical reset trigger and the production legacy-setup lock, roles other
than owner, the companion's own session on the CeraUI UI, setup material
written by a card writer, and the hotspot join hint in the QR.
