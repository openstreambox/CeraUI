# Hotspot setup and removal

Configure accepts the network name, password, security and offered band/channel
while the hotspot is off. It creates or updates one inactive NetworkManager AP
profile, with shared IPv4 and autoconnect disabled. Save does not start the AP.
Start activates the prepared profile. Stop deactivates it and retains setup.
Forget is available while off and removes the owned profile and saved identity.
Stop before forgetting an active hotspot. A failed operation can be retried.

Profiles carry an exact per-adapter ownership marker. Neither a matching name
nor a previously adopted UUID authorizes deletion. Enumeration and read errors
fail closed; an ambiguous pair of owned profiles requires operator repair.
The marker also recovers setup if the backend exits after NM creation but before
saving the credential backstop. Failed durable saves roll back the new profile
or restore the prior settings. Failed removal retains durable identity for retry.
Prepared identities without an NM profile can also be forgotten.

Concurrent AP setup replaces the reserved managed sibling with an AP interface
(`iw ... type __ap`) and accepts only NM disconnected/connected readiness,
never unavailable. An associated station pins the AP to its current frequency
only when that frequency belongs to the kernel-derived legal AP set. Unknown
association/channel evidence refuses activation. The station is not disconnected
or reconfigured. An unassociated station leaves channel choice to the saved AP
settings. NM remains the owner of activation and shared-mode addressing.

Host fake-NM tests prove ordering, refusal, ownership and recovery, not driver
support. Qualification still needs an on-device inactive create/delete baseline
comparison, AP readiness under the actual NM/supplicant/driver versions,
associated-station same-channel activation, client DHCP/DNS/HTTPS, Stop and
Forget, and before/after route, resolver, firewall and management comparisons.
No hardware qualification or deployment is implied by the host tests.

## Configuración y eliminación del punto de acceso

Configura el nombre, la contraseña, la seguridad y la banda o el canal con el
punto de acceso apagado. Guardar prepara un perfil inactivo; Activar lo inicia.
Apagar conserva la configuración. Olvidar elimina el perfil propio y la identidad
guardada; primero apaga un punto de acceso activo. Si una operación falla,
puedes volver a intentarla. Los perfiles ajenos se conservan.

Cuando la radio comparte una conexión Wi-Fi y un punto de acceso, ambos deben
usar el canal de la estación. Si el dispositivo no puede comprobar un canal
válido o una interfaz lista, rechaza la activación. La conectividad de clientes
aún debe verificarse en el dispositivo.
