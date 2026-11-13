# Heat adjustments during a stream

A warm device asks for airflow. Sustained SoC heat can reduce the live bitrate
ceiling to 75%, then 50% of your chosen maximum. The floor is 2 Mbit/s,
but a ceiling never increases your chosen bitrate. Adaptive bitrate still works
below that ceiling. Open the bag or find shade.

**Keep quality** removes this ceiling until the stream ends. Heat warnings stay
visible. It cannot override kernel thermal protection or independent power
protection. The saved bitrate stays unchanged. Stopping the stream or restarting
the backend clears this session policy. A short loss of the engine's control
connection does not: the ceiling, Keep quality and the history carry on with
the same stream.

Some sources cannot lower their bitrate (passthrough or a fixed-rate source).
The panel then says so instead of claiming a cap. It shows the maximum the
engine reports it applied.

The live panel includes a bounded session history of confirmed ceiling changes.
An unavailable SoC reading pauses automatic changes and recovery; it does not
mean the device is cool. Missing modem readings block recovery while SoC heat
can still raise the stage. A reading outside −20…125 °C, or a thermal zone that
reads exactly 0, counts as unavailable; the supervisor parser uses the same
range. One unreadable sample pauses the cool-down timer without restarting it;
more than 5 s without a readable sample restarts it. A failed engine change is
reported without claiming it was applied; it is retried after 5 s, doubling up
to 60 s, and logged once rather than every second. Any confirmed send of the
session ceiling, including one that follows your own bitrate change, clears
that warning and the backoff.

The 1 s sensor loop never waits on the engine or the modems. At most one heat
change is in flight and it always sends the latest ceiling. Modem temperature
reads run in the background, one per modem at a time. A stream that survived a
backend restart is adopted first; the reset to your maximum follows as a
best-effort call. If the engine rejects it, it is retried with the same backoff
even while the temperature is unavailable, because it only repeats your own
maximum. Keep quality switched on while another change is in flight is applied
as soon as that change answers, also while the temperature is unavailable.

## Implementation boundary

HEAT_SETTINGS in heat-ladder.ts owns proposed ordering, cap percentages,
floor, trigger temperatures, filter/dwell, hysteresis, minimum hold, reverse undo,
flap stop and override duration. Spare-link policy has a memory-only actuator
with fail-closed capacity admission.
Resolution remains a future offer.
The critical ceiling remains until the hot step can be undone, restoring the
operator maximum in one step rather than gradually raising quality.

The existing real SoC reader feeds the pure reducer. A missing reading clears
the previous sensor value. Supervisor OSB1 parsing remains fixture-tested.
Pack and bank thresholds await transport admission. Modem thresholds use QTEMP.
Physical thermal savings and streamer-visible encoder behavior still need
hardware measurement.

The supervisor parser accepts appended sequence, boot/reset, alive-pin, hottest
probe, shutdown-counter and firmware fields. Unknown future keys are ignored.
When present, the final CRC-16/CCITT-FALSE field must match the exact UTF-8 bytes
before it. Legacy lines without CRC remain readable; a future transport must
require a verified checksum before trusting newly connected hardware. No such
transport is installed by this change.

## Modem temperature and spare links

RM520N-GL temperature is sampled with read-only AT+QTEMP through the bounded
mmcli command runner every ten seconds. Known sensors contribute their hottest
valid reading. ERROR, missing completion, unknown sensors and malformed readings
supply no modem trigger. Proposed modem levels are 65/70/75 °C in HEAT_SETTINGS.

A separate memory-only bond exclusion supports one spare modem. Admission needs
two other healthy links, each with at least 30% known spare capacity. This branch
has no capacity source, so admission stays closed and the panel says capacity
is unknown. Keep quality and stream/session cleanup remove the exclusion. Saved
bond preferences are independent. On cooling, the link returns before the ceiling
is removed at the next reverse step.

The OSB1 fixture parser also exposes pack calibration, start reason and the full
16-bit protection-gap mask. Every nonzero mask, including future bits, reports
reduced protection. Datasheet calibration (including pack flag 10) is explicit.
The fixture/source seam expires its display after five seconds and supplies no
supervisor temperatures to the reducer until a transport owns freshness/epoch.
