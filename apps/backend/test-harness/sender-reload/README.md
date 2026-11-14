# Sender address adoption

After a mobile network ends its data session and the link gets a new address,
the sender may keep using the old one. After every reload the backend checks
the running sender. Without adoption after about ten seconds it signals once
more. If a source that is no longer published is still bound after that, what
happens depends on the other links:

- **Another link carried traffic in the last ten seconds.** The stream is
  going out on it. The device shows a calm notice that the link is not
  contributing, says the other links are carrying the stream, and offers a
  one-tap "Restart connection" that states its cost (a few seconds of the BRB
  screen). Nothing restarts without the tap.
- **No other link carried anything for ten seconds** (or there is no other
  link). The stream is already down, so a restart costs nothing extra. The
  device restarts the session once on its own and says so afterwards:
  "Restarted the connection to use the new address." It never claims the
  stream stayed live. A repeat within five minutes gets the offer instead.
- **Can't tell** (no fresh telemetry, or the stuck link's interface is
  unknown): the offer, without any claim about the other links.

The sender is never replaced on its own. A new sender process registers a new
relay group, and the engine's SRT session cannot follow it: the namespace
control below shows the session stalling and the caller giving up after the
SRT peer-idle timeout. Every restart, tapped or automatic, is a full session
restart through the supervised Stop then Start.

An unknown or unreadable observation (no `/proc`, hidepid, a vanished sender,
a loopback-only bond) is "can't tell": no second signal, no notice, no
restart. Observation failures are logged at most once a minute.

The standalone 4.1.0 sender does not publish an applied generation or source
address in its stats document. Its `bind_map_status: active` is not an adoption
receipt. On Linux the backend therefore reads UDP socket inodes owned by the
supervised PID and compares their bound source addresses with the publication.
A bound address that is no longer published means a changed link kept its old
source. A published address that is not bound yet does not count as stale.
This proves address adoption, not receiver registration or delivery, and cannot
independently prove a mapping-only interface move with identical addresses.

"Carrying" is read from the sender's own per-link telemetry: a fresh row with
throughput above zero or a moving sent-bytes counter.

After confirmed engine Stop, the sender remains alive for 250 ms to forward the
engine's real SRT shutdown. A peer rejection with reason 1000 is ambiguous: only
an identical destination and stream ID that succeeded recently is eligible for
retry, and only after confirmed idle cleanup. Retries relaunch the whole session,
use 1/2/4/8 second delays, at most five attempts and a 45-second total budget;
Stop cancels the existing start supervisor's wait. Changed credentials and first
starts receive no such exception. No shutdown packet is fabricated.

## Namespace proof

`netns.ts` builds two veth uplinks into a peer namespace with the BELABOX
receiver and an ffmpeg SRT listener, and sends a real SRT session from an
ffmpeg caller (standing in for the engine) through the real sender. Only
synthetic addresses are used. The production adoption check, `/proc` reader,
carry tracker, offer and restart paths run unmodified.

Run it as root inside a PID/mount/network namespace, for example:

```sh
sudo unshare --pid --net --mount --fork --mount-proc env \
  CERALIVE_NETNS_ISOLATED=1 SRTLA_SEND_BIN=/usr/bin/srtla_send \
  SRTLA_REC_BIN=/path/to/srtla_rec FFMPEG_BIN=/usr/bin/ffmpeg \
  PROOF_OUTPUT=/tmp/sender-reload bun test-harness/sender-reload/netns.ts
```

Pass one scenario name to run only that one: `withheld-hup`, `offer` (which
also runs the tap), `single-link` or `control`.

## Operator guide (English)

If a link keeps an old address after its network changes, the device first
retries quietly. If the link still uses the old address and your other links
are carrying the stream, a notice says the link isn't contributing and offers
**Restart connection**. Restarting shows your BRB screen to viewers for a few
seconds; nothing restarts unless you tap it. If no other link is carrying the
stream, the stream is already down, so the device restarts the connection
itself and tells you afterwards.

## Guía del operador (es-419)

Si un enlace conserva una dirección antigua después de que cambia su red, el
equipo primero lo reintenta sin avisar. Si el enlace sigue usando la dirección
antigua y tus otros enlaces están transmitiendo el stream, un aviso indica que
ese enlace no está aportando y ofrece **Reiniciar conexión**. Al reiniciar, tus
espectadores ven tu pantalla BRB unos segundos; nada se reinicia si no lo
tocas. Si ningún otro enlace está transmitiendo, el stream ya está caído, así
que el equipo reinicia la conexión por su cuenta y te avisa después.
