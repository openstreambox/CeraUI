# Experimental paired companion channel

`companion.*` lets a native companion pair with a box once and then call a
small set of box operations with its own device key, without the CeraUI
password. The first call on it is the companion Wi-Fi import from
[COMPANION-WIFI.md](COMPANION-WIFI.md). The backend flag
`CERAUI_EXPERIMENTAL_COMPANION_CHANNEL=1` enables it; with the flag unset
every route answers `disabled`. Nothing here is reviewed for release.

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
  answer `unavailable`; it never resets itself.

All operations use the runtime's crypto library: HKDF, HMAC-SHA256, Ed25519
and ECDSA P-256 with fixed 64-byte signatures. No new dependencies.

## Protocol

1. `companion.hello {client_nonce}`. The box answers with a nonce, its
   identity key, the generation and access sequence, the channel binding and
   an identity signature over all of it. The binding is
   `tls-spki:<SHA-256 of the TLS key the box serves>`. The companion compares
   it with the key it saw on the same connection and stops on a mismatch, so
   a relay that terminates TLS with its own certificate is caught. While setup
   material is present the reply also carries an HMAC with the setup proof
   key, which lets a companion check a box whose QR has no fingerprint.
2. `companion.claim` (setup ingress only). The companion signs the
   transcript with the claim key and with its new device key. The box
   commits the owner, drops the setup verifier and retires the claim key
   before it answers.
3. `companion.auth {device, signature}` for an enrolled device, over a fresh
   hello. Each hello is good for one attempt within 30 seconds.
4. After `auth`: `devices`, `invite` (a one-time ticket for five minutes),
   `revoke {device}` and `wifiImport` (the input of `wifi.addFromCompanion`).
   `join` enrolls another device with an invite ticket over a fresh hello.

Revoking a device closes its sockets with 4403. The last owner cannot be
revoked. Failed claim, join and auth attempts are budgeted per interface and
peer (IPv6 by /64): five free, then 30 s doubling to 15 minutes, bounded
memory, no global lockout.

## Where it is accepted

| Arrival | Accepted |
| --- | --- |
| Front door on the running hotspot AP | hello, claim, join, auth and calls |
| Front door on another physical link | hello, join, auth and calls |
| TCP on an image without the front door, loopback peer, native client (no Origin, no forwarding headers) | everything, binding `loopback`, for development and SSH forwards |
| Remote-control relay, overlay or tunnel, TCP behind the front door, stale interface evidence | refused |

The front door's interface evidence is rechecked on every call. On images
without the front door, any other reverse proxy that strips forwarding
headers would look like a loopback client; keep the flag off there.

## Stub

```sh
# On the box, once: prints the setup link (keep it private)
bun apps/backend/scripts/companion-provision.ts > /root/setup-link.txt
# On the companion host
bun apps/backend/scripts/companion-channel.ts pair wss://<box>/ws --state ./state < setup-link.txt
bun apps/backend/scripts/companion-channel.ts devices wss://<box>/ws --state ./state
bun apps/backend/scripts/companion-channel.ts wifi wss://<box>/ws --state ./state < network.json
```

`invite`, `join` and `revoke <device-id>` complete the set. The stub's
state directory stands in for a platform key store. It pins the box before
sending a claim, so after a lost reply `devices` shows whether the claim
committed.

## Not in this prototype

The physical reset trigger (the store function exists and is tested),
invites that need an owner's approval, roles other than owner, the
companion's own session on the CeraUI UI, setup material written by a card
writer, and the hotspot join hint in the QR.
