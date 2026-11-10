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

Concurrent AP setup creates a missing AP interface (`iw ... type __ap`) and
accepts only NM disconnected/connected readiness, never unavailable. A reserved
name alone does not authorize replacement: pre-existing managed or unavailable
siblings are preserved and concurrent activation is refused. Ready AP siblings
may be borrowed, but cleanup deletes only interfaces successfully created by
the current backend owner. A restart does not infer deletion ownership from a name.
An associated station pins the AP to its current frequency
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
usar el canal de la estación. Las interfaces preexistentes se conservan; un
nombre reservado no autoriza reemplazarlas. La limpieza solo elimina interfaces
creadas por el propietario actual del backend. Si el dispositivo no puede
comprobar un canal válido o una interfaz lista, rechaza la activación. La conectividad de clientes
aún debe verificarse en el dispositivo.

## Choosing the hotspot radio

The Network card's **Hotspot radio** selector chooses the adapter for setup,
Start, Stop and Forget. The default prefers an active hotspot, then an idle
AP-capable adapter, before considering the station's adapter. Choose a separate
USB adapter to keep the station available.

Discovery uses NetworkManager's Wi-Fi device type and sysfs wireless markers,
including disconnected interfaces with arbitrary names. MAC resolution falls
back from the polling cache to sysfs and NM. The permanent MAC remains the
registry/profile identity across renames and replugs; `radio_identity` reports
it with the current PHY and physical USB/PCI device path. PHY numbers and
interface names are observations, not durable identifiers. A missing physical
path remains unknown.

Hotspot RPC inputs optionally carry `radio_id` (the permanent-MAC identity).
It takes precedence over the legacy numeric `device`; an absent target refuses
rather than choosing another radio. Legacy clients can continue using `device`.
The UI supplies both. Capabilities use the selected PHY's supported interface
modes and valid interface combinations; NM AP capability remains the fallback
when the kernel read cannot be interpreted. No interface-name prefix proves
wireless or AP support. Capability claims do not prove that a driver transmits
beacons: activation-without-beacons health detection remains a follow-up.

## Elegir la radio del punto de acceso

En Red, **Radio del punto de acceso** permite elegir el adaptador para configurar,
activar, apagar y olvidar. Se prefiere un punto de acceso activo y después una
radio disponible que no tenga conexión de estación. Puedes elegir un adaptador
USB para conservar la conexión de la estación. La identidad permanente mantiene
el destino aunque cambie el nombre de la interfaz o se vuelva a conectar el
adaptador. Si falta la radio elegida, la operación se rechaza. Que una radio
admita el modo AP no confirma que el controlador transmita balizas.
