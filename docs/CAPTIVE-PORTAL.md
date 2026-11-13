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
or another phone's connections. After an abrupt backend death the expired guard
may remain until reboot; a new window refuses rather than taking it over.

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
