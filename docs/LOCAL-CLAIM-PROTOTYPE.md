# Local owner setup prototype

Run against a single backend with isolated test state. Set
`CERALIVE_LOCAL_CLAIM=1` on that backend and seed its private runtime
`config.json` before boot with `local_claim_digest`. Use the lowercase SHA-256
hex digest of the UTF-8 form of a random 32-character lowercase hex code
(16 random bytes). Keep the raw code on the separate setup card. An existing
`password_hash` takes precedence. A protected fresh box without a valid digest
withholds setup.

Use loopback in a lab or provide authenticated TLS on an isolated setup
network. Keep the plaintext WebSocket backend unreachable by other hosts.
This prototype uses a bearer setup code and relies on trusted transport.

- Browser: open the box or scan a QR containing its trusted HTTPS URL with
  `#claim=<code>` appended. The page removes the code from the address bar as
  it loads, on every box. Select **Set up box**. The browser generates a
  credential and remembers a normal CeraUI session for that origin. A browser
  that refuses site storage is not offered setup.
- Companion stub: run `bun scripts/claim-local-owner.ts wss://<box>/ws <new-key-file>`
  and enter the code when prompted. The file is created mode `0600` before the
  request. Its contents work as the password for the normal login flow after
  claim. If the box does not confirm, run it again with the same file: it
  reuses the saved key. Keep the file private and outside source control.
- For browser-only testing, keep the original session or set a known password
  in settings before discarding browser data. Loss of the session requires
  local recovery.

A successful claim commits the credential hash and removes the digest in one
config replacement. Any later write of an owner password also removes a digest
left on disk. A malformed digest only withholds setup; the rest of the config
loads as usual. A fresh test run needs empty auth state and a newly generated
code.

## Unconfirmed setup

The code is spent once the box commits, so a lost reply must not cost the new
owner their only credential.

- The page keeps the generated credential in memory until it signs in or the
  page closes. It retries sign-in when the connection returns and on
  **Try again**. Entering the code again reuses the same credential, so
  whichever request the box committed, the page can sign in.
- When a config write fails, the box reads the file back before answering. A
  fault after the new file landed still counts as a completed setup. If the
  file is unreadable, the box answers with an error and reloads it in the
  background without a restart.
- Other pages still showing setup are disconnected when setup completes and
  reconnect to the normal sign-in view.
- If the browser accepts the sign-in but refuses to store it, the session lasts
  for this visit only and the page says so.

## Before release activation

The prototype is for lab use. Each item below must hold before the flag can be
enabled on a shipped image:

1. The box enforces the trusted setup ingress itself (interface, address
   family, uplink, overlay and remote control), not browser code.
2. A PAKE or a pinned channel replaces the bearer code, so neither the code nor
   the new credential crosses the wire as a reusable value.
3. Each owner device gets its own key, instead of one shared bcrypt password.
4. The box limits failed setup attempts per ingress.
5. An ownership generation kept outside interchangeable images rejects rollback
   and stale snapshots.
6. A physical reset clears config credentials, `auth_tokens.json` and invites,
   and provisions a fresh verifier, never one restored from boot media.

## Configuración local del propietario

Abre la dirección HTTPS de confianza del equipo o escanea su código QR. La
página quita el código de la barra de direcciones al cargar. Selecciona
**Configurar equipo**. El navegador crea una credencial y conserva una sesión
en ese navegador. Si el navegador no permite guardar datos del sitio, no se
ofrece la configuración.

Si el equipo no confirma la configuración, mantén la página abierta. La página
conserva la credencial hasta iniciar sesión o cerrarse, y vuelve a intentarlo
al recuperar la conexión o con **Intentar de nuevo**. Volver a introducir el
código usa la misma credencial.

Guarda el acceso antes de borrar los datos del navegador. Para iniciar una
nueva instalación de prueba, genera otro código. Este prototipo es solo para
laboratorio: antes de activarlo en una imagen publicada, el equipo debe
controlar por sí mismo la red de configuración, sustituir el código por un
canal autenticado, usar una clave por dispositivo, limitar los intentos,
rechazar instantáneas antiguas y ofrecer un restablecimiento físico completo.
