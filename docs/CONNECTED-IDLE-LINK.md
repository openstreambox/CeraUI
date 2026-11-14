# Connected links carrying no stream traffic

During a live stream, the Network page can show a notice inside an enabled,
connected bonded link's card when that link is contributing almost no traffic
while another connected, enabled link carries traffic. It names the same link
and type as the card. Open the notice for the receiver-reachability check.
The stream continues over the other links.

The detector observes existing sender telemetry only. It requires 20 seconds
of samples at no more than 1,024 wire bits/s, allowing small transport keepalives.
A peer must exceed that threshold throughout the window. Where cumulative sent
bytes exist, a counter increase above the same rate also resets the hold.
Counter resets, link identity changes, gaps over five seconds, stale or missing
bitrate, disconnect, bond exclusion and stream stop reset the window. Repeated
observation timestamps cannot advance it. There is no new probe or timer-driven
network operation. Older backends without the observation timestamp show no
notice. Opening Network begins a new observation window.

RTT, NAK and weight remain visible beside the notice. Existing stream-health
link-down counts describe the bond as a whole; existing uplink probe results
indicate Internet health, not reachability of the configured receiver. None of
these readings alone proves why a connected link is quiet. The notice therefore
asks about receiver reachability rather than diagnosing a firewall or VPN.

Deliberate rest must remove a link from bond eligibility, as operator exclusion
already does. A policy that rests an enabled, connected sender row without
changing eligibility needs to supply an explicit suppression before integration.
The detector never interprets zero sender weight alone as deliberate rest: a
receiver-unreachable path may also have zero weight.

## Operator copy

English: “{link} is connected but carries nothing. Check: can this network reach
the receiver?” Details explain that the stream remains live on other links.

Español: «{link} está conectado, pero no transmite nada. Comprueba: ¿esta red
puede llegar al receptor?» Los detalles aclaran que el stream sigue en vivo por
otras conexiones. Comprueba la VPN y la dirección del receptor en esta red.

All ten catalogs carry the notice and details. Publishing the corresponding
English and Spanish user-guide update remains a release coordination step.
