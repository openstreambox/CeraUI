# Manual network modes and passive trial history

A network may deliver better upload on LTE than on 5G in some radio conditions.
The modem detail offers Automatic, LTE only, and the existing 5G preferences.
This release contains no automatic mode switching of any kind.

## What each option writes

- **Automatic (modem decides)** writes every mode family the modem lists, with
  no preference (`allowed` = the whole catalog, `preferred: none`). It is not
  "go back to the previous setting". An unranked set narrower than the catalog
  (for example 5G+4G on a modem that also lists 3G) is not called Automatic; it
  shows with no option marked as in use.
- **LTE only** writes `allowed: 4g`. On a modem that lists only 4G and 5G, "5G
  off" would write the same pair, so it is not offered there.
- A readback is judged by its `(allowed, preferred)` pair against the pair that
  was written, compared as mode sets (mmcli prints `4g, 5g` where CeraUI writes
  `5g|4g`), never by the option name it reads as.

SA/NSA selection remains unavailable. A choice uses the existing ModemManager
mutation, capability gate, identity lease, pre-state journal and readback, and
is refused while streaming.

## One mode write at a time

All radio-mode writes share one slot across modems: this choice, the network
type in modem settings, and crash-journal restores. The choice and the settings
save take the slot before anything is journaled or written, so a busy slot is
an honest "another modem is changing its mode" (`mutation_in_progress`, or
`device_busy` for the settings save) and nothing changes. A restore waits for
the slot rather than failing, because a refused restore would leave the modem
blocked.

## The confirmation

Every change, including "use it again", opens a confirmation that names the
modem and the mode and says the modem drops its connection for some seconds
while it re-registers. Reconnecting can take a while.

## The saved choice

The saved choice is an intent; "In use" always shows the modem's live read.

- **Keyed by the modem, not the USB port.** The key is an HMAC-SHA256 of the
  modem's equipment identifier (IMEI) under the device-local key below. The IMEI
  itself is never stored or sent. Swapping two modems between ports keeps each
  modem's own choice. A modem that reports no equipment identifier gets no saved
  choice.
- **Reconciled on every read.** When the live pair is not the saved choice's
  pair (after a modem reset, a change made elsewhere, or a swap), the detail says
  so plainly and offers to apply the choice again, through the same confirmation.
  Nothing re-applies a saved choice by itself, at start-up or later.
- **The network type in modem settings updates it**, so the two controls cannot
  disagree. A pair no option names clears the saved choice.
- **Automatic is saved but does not lock.** Only a non-Automatic choice keeps the
  evaluator away from the modem.
- **A save that fails after the modem changed** reports success with
  `saved: false`, and the detail says "The modem switched to …, but this device
  could not save the choice." The journal is already retired, so nothing is
  blocked. An unreadable history file is replaced by the next explicit choice.

## History

One private file per modem tag, bounded three ways:

- the evaluator stores a record only when its verdict, target or reasons change,
  so an unchanged "would not try" costs no write;
- each source keeps its own newest 50 records within 30 days, so evaluator
  records never evict the streamer's own changes;
- the status wire carries only the newest 10, with every local tag removed.

The evaluator has no mode writer. Unknown radio conditions, protection state,
headroom or budget evidence mean it would not try. Current integration lacks the
radio bucket and acknowledged delivered-upload measurement, so records state
those values as unavailable. Wire bitrate includes retransmits and is not
substituted for delivered upload. No throughput winner is inferred from signal
strength.

## The device-local key

32 random bytes, generated once on first use, stored as `local-key` (mode 0600)
in the mode-choice directory (`/data/ceralive/mode-choice`, mode 0700). It keys
the modem identity tags and the radio-condition tags (`conditionTags`), so a tag
means nothing on another device and two devices' records cannot be linked.

- Never sent on the wire, never logged, never part of a support export. The
  support log download collects journal lines and a carrier summary from live
  state; it reads no file in this directory.
- Fail closed: a key file with the wrong size or permissions, or a directory
  readable by others, is refused and **not** replaced, because replacing it
  would orphan every saved choice. Nothing is saved until it is fixed; deleting
  the directory while the backend is stopped resets the store. Restart the backend
  after an administrator repairs or removes the key directory.
- Raw cell and subscriber identities never enter history, the UI or the wire.

Memory trusts an exact continuously held bucket for 30 minutes, uses a result
only as a hint for seven days, and discards it after 30 days or an invalidating
change. Radio buckets are not yet read at runtime, so no condition tag is stored
today.

Before any automatic mode writes: qualify measured link-out time, headroom,
revert, protected moments, budgets, moving conditions and real-use log-only
behavior.

## First device run

- Verify the advertised RM520 catalog and exact allowed/preferred readback for
  Automatic, LTE only and 5G preferred; restore the exact initial pair.
- Confirm one modem changes at a time, including two simultaneous clients and a
  modem-settings save on another modem.
- Measure registration and verified data recovery during a live bond. Check the
  confirmation, journal failure/restart recovery and the saved choice after a
  restart, a modem reset and a port swap.
- Check the history says unavailable for missing inputs, stays at one evaluator
  record over hours of polling, and never writes a mode from an evaluator tick.
  Verify no sensitive identity or key material reaches the UI, records or logs.
- Compare sender reporting with receiver-delivered upload before connecting a
  delivered-upload reader. Exercise privacy, BRB, countdown and hold with fixtures
  until each input has an authoritative runtime source.

## Uso

En los detalles del módem, Automático permite todos los tipos de red del módem
sin preferencia; Solo LTE permite únicamente LTE. Cada cambio pide confirmación,
nombra el módem y el modo, y avisa que la conexión se corta unos segundos. La
elección se guarda para ese módem (no para el puerto USB); si el módem informa
otro ajuste, el detalle lo dice y ofrece volver a aplicarla. Nada se vuelve a
aplicar solo. El historial indica cuándo faltan mediciones. No hay cambios
automáticos de modo.
