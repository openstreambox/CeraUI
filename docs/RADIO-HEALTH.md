# Passive radio health

The cellular row's Details disclosure contains a read-only Radio health panel.
Registration, serving layer and band, per-source RSRP/RSRQ/SNR/SINR, LTE transmit
power, neighbouring modem bands and payload activity, and USB events are separate
facts. Missing readings say **Unavailable**. Zero payload bytes never claims
radio silence. Values keep source, technology, units and capture time. QENG LTE
SINR is raw; QMI SNR is dB. They remain different measurements.

An administrator can suspend only this sampler by creating
`/run/ceralive/radio-health-disabled`, and resume it by removing the file. The
next retained poll clears/restarts the cache without changing modem or stream
state. This is a measurement seam, with no modem action exposed in the UI.

The retained modem status poll owns sampling. Ready activations run before diagnostics,
and diagnostic I/O holds no modem update lock. A refresh already in flight makes
the next refresh skip immediately; success or failure releases that guard.
There is no additional timer or
network probe. The RPC `modems.getRadioHealth` returns the cached snapshot; it
cannot trigger a query. The ordinary modem broadcast carries the latest sample only; the dedicated RPC returns the full bounded timeline.
History stays in bounded process memory (120 samples per modem); no subscriber
identifiers or raw command output enters it. USB reads are bounded to 512 journal
records per interval and 128 modem events. Unreadable journal or unresolved USB
port is unavailable, rather than zero events.

Only the listed RM520N-GL firmware family ending A08M4G gets fixed QMI NAS reads
through the existing modem facade and QMI proxy. The fixed QENG serving read
goes through the read-only AT lease on the RM520's second AT port, which
`ceralive-modem-support` releases from ModemManager ([FREE-AT-PORT.md](FREE-AT-PORT.md)):
stock ModemManager refuses `mmcli --command` outside debug mode. The lease opens
that port only when it is released in udev, ModemManager does not own it and no
other process holds it, and writes only `AT+QENG="servingcell"`. Otherwise the record carries a `servingCell`
field that says **Unavailable** with its fixed reason (for example
`not available: not-released`), and the port is looked at again after ten
minutes, preserving the original refusal timestamp; a failed query says `no reading` with its reason. The application never
enables debug mode, inhibits ModemManager or opens a port ModemManager owns.
The DW5821e and FM350 use only the observations ModemManager already exposes.
This build does not enable extended signal reporting. No modem receives a setup,
scan, mode change, reset or write from this readout. Unlisted firmware receives
vendor-neutral observations only. Availability and control-port cost still need
qualification on the target hardware before deployment.

Findings are informational, never admission or recovery commands:

- A refusal identifies **SIM or account** only for an explicit subscriber or account rejection on the observed home network. Congestion, network failures and unidentified causes remain Unknown.
- **Data path** requires registration, attached packet service and at least two fresh failed path probes already owned by the host. No new traffic is generated.
- **Possible disturbance** requires independent radio evidence of an idle neighbour becoming active, a healthy baseline and a subsequent USB event or comparable quality drop. Payload counter increases cannot establish this contrast. The deployed sampler has no independent radio-idle source, so it does not emit this finding. Synthetic evidence tests cover the positive and negative cases; correlation still cannot establish a cause.

The panel uses words and symbols alongside calm suggested actions. It contains
no modem action controls. Restart is a suggestion with its expected interruption,
not an executable action. The recent timeline is for inspection after streaming.

Host tests cover subscriber refusals, synthetic path failures, USB resets during payload activity, independent radio contrasts, journal decoding and parser units. The replay fixture is entirely synthetic, with both matching events and negative controls.

Hardware qualification is not included.

## Español

El panel **Estado de radio** está en los detalles de cada módem y es de solo
lectura. Muestra el registro, la tecnología y banda activas, las mediciones con
fuente, unidad y hora, la actividad de los otros módems y los eventos USB.
Una medición ausente dice **No disponible**; si el segundo puerto AT del RM520
no está liberado de ModemManager, la celda de servicio (QENG) dice **No
disponible** con su motivo, sin modo de depuración ni inhibición del módem.
Cero datos enviados no significa
silencio de radio. El SINR bruto de QENG no se convierte en SNR en dB.

El panel no inicia escaneos, pruebas de red, cambios ni reinicios. Solo usa el
ciclo de lectura existente. Una denegación de una red ajena no se presenta como
un problema de la SIM. Dos pruebas existentes fallidas, con registro y servicio
de datos concedido, pueden indicar un problema de la ruta de datos. La actividad de datos y un evento USB no bastan para indicar interferencia. Sin una observación independiente de silencio de radio seguida de transmisión, el diagnóstico permanece desconocido.

Las acciones son sugerencias, sin botones que actúen sobre el módem. Las pruebas
en el equipo real aún **NO SE HAN EJECUTADO**.

## Loading another replay

Run `bun apps/backend/src/tests/fixtures/radio-health-replay.ts <fixture.json>`.
The loader validates `durationMs`, `events` (`at`, `kind`), `transmitWindows`
(`start`, `end`, `source`) and `quietWindows` (`start`, `end`). All times are
relative milliseconds. Source is `payload-counter` or
`reviewed-control-activity`; the latter must be independently reviewed, never
created from the victim's reset timestamps. Output distinguishes control-only
coincidences. Strip identity, location and absolute timestamps before sharing a
fixture. An event outside the chosen window is rejected rather than silently
included in a different denominator.
