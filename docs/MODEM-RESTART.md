# Restart modem

**Restart modem** restarts one cellular modem from software, so a modem that is
registered but carries no data can be brought back without unplugging it. It is
offered only for models whose restart was qualified on a bench board. Every
other model keeps the "unplug it and plug it back in" advice.

## Where it appears

- In a cellular row's **Details**, under Radio health, with the expected downtime.
- In Radio health's **Data path** finding, as the next step ("Restart this
  modem. It's offline for about N s."). The row then doesn't repeat the button.

Pressing it asks first. The confirmation says how long the modem drops off. While
a stream runs, it adds that the stream keeps going on the other connections.
Progress ("Restarting… N s") and the result appear above the modem rows,
because the restarted modem's row goes away and comes back under a new
ModemManager index.

## Qualified models

| Model | Method | Measured downtime | Wait bound |
| --- | --- | --- | --- |
| DW5821e | `mmcli -m N --reset` | 32.5 to 32.8 s, 3 runs | 120 s |
| RM520N-GL | `mmcli -m N --reset` | 51.5 to 53.6 s, 3 runs | 150 s |

Measured on a ROCK 5B+ (kernel 7.2, ModemManager 1.24.2): the DW5821e in the M.2
slot, the RM520N-GL on the USB-C data port.

- **What came back the same:** the USB port, the network interface name, the SIM,
  the carrier configuration and the NetworkManager profile.
- **What changed:** the ModemManager index, every time.
- **Other links:** a second modem kept passing traffic, and a running bonded
  stream neither stopped nor restarted.
- **USB unbind/bind:** brought both models back as well (13 s and 24 s), but it
  doesn't reboot the module, and the reset was never refused. So it isn't used:
  as a fallback it would race stream admission and the device's identity.

The FM350-GL is not qualified. ModemManager answers `Unsupported` to its reset,
and its recorded USB behaviour includes crash and reset loops. The table lives
in `packages/rpc/src/schemas/modem-restart.schema.ts` (`MODEM_RESTART_MODELS`),
and nothing outside it is offered or accepted.

## Guards

- **Qualified models only:** the RPC refuses any other model (`not_qualified`).
- **One at a time:** while any modem restarts, another restart is refused
  (`restart_in_progress`).
- **Cooldown:** 3 minutes per modem after an attempt ends, whatever the result
  (`cooldown`, with the seconds left).
- **Only connection carrying a live stream:** refused (`only_link_live`) unless
  the operator confirms that cost. The UI then asks a second time, saying the
  stream has no connection until the modem is back.
- **What counts as another live link:** a link the sender is using right now: a
  fresh row with a non-zero weight and a non-zero bitrate. It must also be
  positively a different uplink: another modem's interface, Ethernet, Wi-Fi or a
  USB network device. A CLAT alias, an unresolved row and the target itself
  never count, and neither do session bytes alone (a timed-out link keeps them).
  Anything less, including missing link telemetry, asks the second time.
- **Same-modem exclusion:** a restart takes the modem's own lease, so a settings
  change or band lock on that modem can't overlap it (`mutation_in_progress`).
  A whole-subsystem modem transition waits for it too. It never refuses a Stream
  Start. It doesn't begin during journal replay, on a blocked modem, or while a
  stream is being launched or forwarded.
- **The confirmed modem:** the request carries the `stable_key` the operator
  confirmed. If the index now names another modem, it is refused
  (`unknown_modem`).
- **No retry loops:** one attempt per press. A modem that accepted the reset and
  didn't come back gets no second action.
- **One method:** ModemManager's reset. If ModemManager refuses it, the result
  is `failed` and the UI says to replug. A timeout or transport failure may still
  have delivered the reset, so the modem is only observed.

## Finding the modem again

While waiting, the backend re-lists the modems at each poll (every 3 s), so the
row comes back as soon as ModemManager lists the modem. It waits for a modem
with the same `stable_key` (the ID_PATH-derived key
of its USB port) that is listed under a different index, or that was gone and is
back, and connected. The outcome follows the last observation:

- `back_connected`
- `back_not_connected`, with its connection state
- `not_back`, which means unplug it and plug it back in
- `unchanged`: the reset was accepted but the modem never left
- `failed`: ModemManager refused the reset

The client waits up to 170 s for the reply.

## Logs

The backend logs one line when a restart starts and one with its outcome. The
outcome line carries the stable key, model family, method, old and new index,
the connection state (when not connected) and elapsed seconds; the stable key
stays in the local journal only. Every refusal gets one `modem restart refused` warning with its reason.
These fields are closed vocabularies or bounded numbers, so a support download
keeps them. No IMEI, ICCID or SIM data is
logged. Nothing is persisted: a restart changes no setting, so there is nothing
to roll back.

## Mock mode

Under `MOCK_SCENARIO` the real flow runs with the device half replaced. A
"reset" takes the modem out of the mocked ModemManager list for 6 s, then lists
it again under a new index on the same port. The restart's own roster refresh
picks both changes up. The row goes away and a new one
replaces it, as on a board.

## Español

**Reiniciar módem** reinicia un módem celular por software, para recuperar un
módem registrado que no pasa datos sin desconectarlo. Solo aparece en modelos
cuyo reinicio se calificó en banco (DW5821e, RM520N-GL). Los demás modelos
mantienen la indicación de desconectarlo y volver a conectarlo.

- **Dónde aparece:** en los **Detalles** de la fila del módem y como siguiente
  paso del hallazgo **ruta de datos** de Estado de radio.
- **Confirmación:** antes de empezar, dice cuánto tiempo queda sin conexión el
  módem (unos 35 s el DW5821e y unos 55 s el RM520N-GL). Si hay una transmisión,
  aclara que sigue por las otras conexiones si ellas la llevan. El progreso y el resultado se ven
  encima de la lista de módems.
- **Única conexión de la transmisión:** si el módem es la única conexión que
  lleva una transmisión en curso, se pide una segunda confirmación. Esa
  confirmación explica que la transmisión queda sin conexión hasta que el módem
  vuelve.
- **Límites:** un reinicio a la vez y una espera de 3 minutos por módem. Hay un
  único intento por pulsación, sin reintentos automáticos. Si ModemManager
  rechaza el reinicio, el resultado indica desconectarlo y volver a conectarlo.
- **Identificación:** el módem vuelve con otro índice de ModemManager, así que se
  reconoce por el puerto USB (`stable_key`).
- **Registro:** cada reinicio deja una línea al empezar y otra con el resultado,
  incluidas en la descarga de soporte.
