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
  `#claim=<code>` appended. Select **Set up box**. The browser generates a
  credential and remembers a normal CeraUI session for that origin.
- Companion stub: run `bun scripts/claim-local-owner.ts wss://<box>/ws <new-key-file>`
  and enter the code when prompted. The file is created mode `0600` before the
  request. Its contents work as the password for the normal login flow after
  claim. Keep the file private and outside source control.
- For browser-only testing, keep the original session or set a known password
  in settings before discarding browser data. The lab browser uses a
  revocable remembered session, with the generated password kept in memory
  during setup. Loss of the session requires local recovery.

A successful claim commits the credential hash and removes the digest in one
config replacement. A fresh test run needs empty auth state and a newly
generated code. Factory provisioning, trusted setup ingress and physical
recovery are release integration work.

## Configuración local del propietario

Abre la dirección HTTPS de confianza del equipo o escanea su código QR.
Selecciona **Configurar equipo**. El navegador crea una credencial y conserva
una sesión en ese navegador. Guarda el acceso antes de borrar los datos del
navegador. Para iniciar una nueva instalación de prueba, genera otro código.
