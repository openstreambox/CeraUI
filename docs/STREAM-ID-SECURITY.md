# Stream ID handling

SRT Stream IDs may be bearer publish keys. Treat all IDs as secrets, including
ordinary relay labels: no opt-out or stored-value reveal is needed to use them.
Existing saved values keep working without migration. The engine receives the
same value. Config writes use owner-only permissions (0600); values must remain
recoverable on disk for the engine. This is access control, not disk encryption.
Previously created files gain these permissions on the next save.

`streaming.setConfig` and `streaming.start` accept `srt_streamid` and
`relay_streamid_override`: omission retains, a nonempty string replaces, and
`""` clears. Config pulls, pushes, and applied replies omit these values and
report `srt_streamid_configured` / `relay_streamid_override_configured` instead.
There is no hash or suffix hint: low-entropy IDs should not have an offline
verification oracle, and no hint is needed for retain/replace/clear.
Clients must not round-trip a blank displayed field when retaining a saved ID.
Older clients must upgrade together with the backend. Managed account/catalog
credentials have their existing authenticated contract; these write-only fields
cover the manually configured ID and relay override.

The field starts empty and masked. Show/hide reveals only newly typed text.
Leaving an untouched field retains the saved value; Clear schedules an explicit
clear on Save. Cancelling leaves the saved value intact. The same behavior applies
to secret keys and non-secret IDs. Logs and debug traces scrub ID fields and
retained whole tokens in text/errors (including URL-encoded and JSON-escaped forms); downloaded journals scrub whole lines
containing labelled IDs, including older records. Already copied logs or backups
cannot be recalled. Rotate any publish key that was previously disclosed.

**The Stream ID travels in clear on the wire, even with SRT encryption on.**
This change protects local access, the UI and logs; it does not protect the ID
in transit or enable SRT payload encryption. Use a trusted network or a separate
secure transport when the Stream ID must remain confidential in transit.

## Uso (es-419)

El ID de transmisión puede ser una clave de publicación. El campo queda vacío y
oculto: Mostrar solo revela lo que acabas de escribir. Déjalo sin cambios para
conservar el valor guardado, escribe un valor nuevo para reemplazarlo o usa
Borrar y Guardar para eliminarlo. Cancelar conserva el valor anterior. Los
valores guardados siguen funcionando sin migración, incluso los ID que no son
secretos. La API devuelve solo si hay un valor configurado, nunca el valor.

El ID viaja sin cifrar por la red incluso con el cifrado SRT activado. Esta
protección limita el acceso local y la exposición en la interfaz y los registros;
no cifra el disco ni protege el ID durante el transporte. Los archivos de
configuración se guardan con permisos 0600 en la próxima escritura. Si una clave
se expuso antes en registros o copias, cámbiala; no se pueden retirar las copias.
