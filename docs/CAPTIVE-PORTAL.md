# Bounded Wi-Fi sign-in (experimental)

The Links view offers a ten-minute IPv4 web and DNS window to an authenticated
phone associated with the box's AP. Select the connected venue Wi-Fi, open the
hotel's page, and accept its terms yourself in your browser. Use **Check sign-in**
or **Cancel sign-in** to close the window early. Remote helpers cannot open it.

The backend derives the source address from the WebSocket peer, resolves its
neighbor MAC and confirms association on the AP. It captures the existing radio
session identity twice before opening and checks for changes during the window.
No credentials, cookies, page contents or terms acceptance are collected.

`captive-portal-window.py` is shipped beside the application in `/opt/ceralive`.
It needs Python 3, nftables, iproute2 and conntrack, and runs with the backend's
existing root privilege. No image routing changes or global default-route changes
are needed. Existing IPv4 forwarding must already be enabled by AP sharing.
Foreign rule priority 90 or route table 16413 causes refusal. Only
`inet ceralive_portal`, that priority's exact source/iif/mark rule and that private
table are owned. Sharing and physical source-routing tables remain separate.

A kernel timed set binds the selected source IP and MAC to the AP. Only TCP
80/443 and TCP/UDP 53 match; DNS is sent to the selected Wi-Fi's resolver. Local
web control stays local. QUIC, IPv6, VPNs and encrypted DNS are outside this
window. Disable VPN, Private Relay or Private DNS temporarily if the page fails,
and restore it afterwards. The temporary path never changes a station MAC,
automates acceptance, or copies another device's MAC.

Expiry is enforced in nftables even if the backend dies. Portal-marked stale
connections are dropped after expiry; exact phone/port conntracks are retired on
open and close. The cleanup deliberately never flushes streaming UDP connections
or another phone's connections. Startup and each new opening reconcile leftover
live or expired state: flush the timed sets, retire only portal-marked conntracks,
then remove the exact owned policy rules, private routes and nft table. Foreign
policy rules cause refusal. Missing rules/routes/tables are already closed;
permission and I/O errors remain retryable failures. A reconnect that removes
the venue route therefore cannot wedge later sign-ins.

An inert ownership table is installed before route writes, so a hard stop
between route and rule installation is also recoverable. Enabling the timed
window atomically replaces that inert table.

The helper handles SIGTERM by rolling back; its backend deadline exceeds the
bounded command sequence. An open failure triggers another close. If that close
also fails, the owner and conservative expiry remain visible as closing, and
cleanup retries automatically. Venue health is released after successful cleanup
or at the forwarding deadline, even if kernel cleanup remains unavailable.
The interpreter capability accepts only isolated execution of this helper and
its three named actions; arbitrary Python commands are refused.

After closure the backend checks exact empty HTTP 204 and validated HTTPS 204
through the selected device. A positive result says only that Wi-Fi reaches the
web. The normal uplink health gate still owns admission. Opening requires a
current captive-portal reading; only that interface’s health probe is held captive
until closure, including an in-flight result. Other uplinks probe normally.
No bond weights, SRTLA or Moblink processes are changed. Radio-bound DNS integrity
and receiver-specific UDP qualification remain separate follow-up checks.

Generate a ruleset with `bun scripts/tests/captive-portal-rules.ts` and pass its
file path as the fixture’s first argument. The fixture installs the production
sharing rules alongside the window, including protection for unanswered portal
conntracks.

Host proof: `scripts/tests/captive-portal-netns.py`, under a private PID and network
namespace with root network capabilities, builds a fake phone, hotel portal and
healthy receiver over veth. It verifies phone-only web/DNS steering, two fake UDP
relay ports (640/640 packets across two source-bound uplinks), persistent local
control, local UDP egress, an unselected client, unchanged main routes,
kernel expiry and cleanup. It is not a real-radio qualification.

## Español (Latinoamérica)

En Enlaces, elige el Wi-Fi del hotel y abre su página desde un teléfono conectado
al Wi-Fi de la caja. La caja necesita su propio inicio de sesión. Acepta las
condiciones tú mismo en la página del hotel. La ventana dura como máximo diez
minutos; puedes cerrarla antes. El chat del teléfono puede pausarse mientras
inicias sesión. Los enlaces que llevan la transmisión no cambian.

Después de cerrar la ventana, la caja comprueba el acceso web por ese Wi-Fi.
Las comprobaciones normales deciden cuándo puede ayudar con la transmisión.
Si la página no abre, desactiva temporalmente la VPN, Private Relay o DNS privado
y vuelve a activarlos al terminar. Esta función experimental requiere pruebas
en el dispositivo antes de publicarse para uso normal.


## Recovery and messages

A changed Wi-Fi session closes the window at the next identity check. Checks
start every ten seconds. Sign-in errors distinguish a disconnected Wi-Fi, a changed session,
unconfirmed identity, an already-open window, cleanup in progress, a Wi-Fi that
does not need sign-in and a phone outside the AP. Unknown failures use a calm
retry message. Closing reports the latest forwarding expiry and reassures the
user that the stream is unaffected. Check and Cancel both close before checking
web access.

### Recuperación y mensajes

Al iniciar el servicio y antes de abrir otra ventana, el equipo retira las reglas
anteriores, incluso si aún no vencieron. Si el Wi-Fi cambia, la ventana se cierra
en la siguiente comprobación de identidad. Las comprobaciones se inician cada diez segundos.
Los mensajes distinguen una red desconectada, una red que cambió, una identidad
sin confirmar, otra ventana abierta, un cierre en curso, una red que no necesita
inicio de sesión y un teléfono fuera del Wi-Fi del equipo. El cierre muestra
la hora límite del acceso web. Tu transmisión no se ve afectada.
Comprobar y cancelar cierran la ventana antes de comprobar el acceso web.

Remaining qualification: DHCP lease cross-checking of the neighbor MAC, strict
reverse-path filtering on target images, coordinated mark-layout changes, and
event-driven closure faster than the periodic identity check. REACHABLE/STALE
neighbor state and current station association are required, but are not a DHCP
identity proof. No radio or venue qualification is implied by the namespace tests.
