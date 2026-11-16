# Wi-Fi sign-in proxy (prototype)

A hotel or venue Wi-Fi often shows a sign-in page first, and it lets in each
device on its own. Signing in on a phone lets the phone in, not the box. The
sign-in traffic has to leave through the box's own Wi-Fi radio, but the page
has to appear on a screen someone holds.

This prototype is a small explicit proxy on the box. A client app (or a browser
set up to use it) shows the venue's page itself, and every connection it makes
leaves only through the venue radio. Nothing else on the phone or the box
moves. It is not wired into the backend or packaged yet.

## What it does

- **Protocols:** plain HTTP in absolute form (`GET http://…`, for portal
  redirects), HTTP `CONNECT` and SOCKS5 with username/password (RFC 1928,
  RFC 1929). All three share one port. `CONNECT` and SOCKS5 carry bytes
  unchanged, so HTTPS stays end to end: the proxy never sees TLS keys,
  form fields or card numbers in HTTPS pages.
- **One way out:** upstream connections go through `portalegress`
  (this module): `SO_BINDTODEVICE` on the venue interface, the venue address as
  source, names resolved only on the venue's resolver over that interface, box
  addresses and the venue subnet's network/broadcast refused, a short list of
  TCP ports (80, 443, 8080, 8443 by default).
- **Grant:** the backend writes a grant file (mode 0600) after checking the
  caller's session and role. It holds the session id, the role, a deadline at
  most 10 minutes away, the SHA-256 of a one-device token, and the venue radio
  binding. Only the Owner and Tech roles start a proxy. Deleting or changing the
  file revokes the grant within about 250 ms.
- **One device:** the first device that presents the token owns it. The grant
  can also name that device's address up front (`client`), taken from the
  caller's authenticated session.
- **Ends cleanly:** at the deadline, on revocation, or after 20 bad tokens the
  proxy closes every connection, including open tunnels, and exits.
- **Logs:** event kind, client address, destination host and port, result
  code and byte counts. No paths, queries, user info, headers, cookies, bodies
  or tokens.

## Run

```sh
go build -o captive-signin-proxy ./cmd/captive-signin-proxy
captive-signin-proxy -listen 10.42.0.1:8413 -grant /run/<private>/signin-proxy.json
```

The client sets the proxy to the listen address, with any user name and the
token as password (`Proxy-Authorization: Basic`, or SOCKS5 user/password).

## Tests

- `go test ./signinproxy/`: protocol handling, auth, one-device pinning, port
  list, refusals, expiry and revocation with a fake upstream, log redaction.
- `scripts/tests/captive-signin-proxy-netns.py <binary>` (root, inside
  `unshare --net --pid --fork --mount-proc`): a fake venue uplink with a
  captive portal (302, login page, login POST, then open internet) and a
  separate default uplink carrying a continuous UDP flow. It checks that the
  proxy reaches the portal and the internet only via the venue link, that the
  UDP flow and routes never change, that it refuses other roles, other devices,
  expired and revoked grants, that HTTPS through `CONNECT` and SOCKS5 verifies
  the origin certificate and pinned key, and that logs hold no secrets.

## Not done yet

- No backend wiring: grant issuance, the token hand-off to the client, the UI
  and the role mapping (the product's Owner/Tech vs. the control channel's
  `owner`/`copilot`/`viewer`).
- IPv4 only, like `portalegress`. No IPv6 venue path.
- Each upstream stream lives at most five minutes and idles out after 30 s
  without data (`portalegress` limits); browsers reconnect.
- No packaging, no real radio, phone or venue has been tried.
