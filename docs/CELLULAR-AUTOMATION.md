# Automatic cellular profile families

## English

For an existing automatic profile on an admitted modem/firmware transport,
recognized subscription evidence permits a stored IPv4v6 request. The cellular
poll owner applies it under the modem lifecycle lease and a durable inverse
journal. It verifies the settings after the write. Manual profiles, unknown
subscriptions, unqualified carriers and unknown transport firmware are preserved.
The profile must match both device and SIM; an operator-only match is insufficient.

This changes stored settings for the next activation. It does not disconnect an
active bearer or initiate another call. IPv6 contributes no main default route
or automatic DNS. A failed write is restored and verified; an inverse that cannot
be verified leaves the existing mutation block in place. Recovery checks the
current physical identity and SIM before touching the saved profile.

This is a partial implementation. It does not establish automatic APN selection,
initial-activation preparation, QMAP/raw-IP/EPS handling, an RNDIS owner, CLAT,
traffic health or carrier/hardware qualification. Existing or synthetic test
results do not establish those capabilities. Verizon remains unqualified.

## Español (Latinoamérica)

Un perfil automático existente puede solicitar IPv4v6 cuando la suscripción se
reconoce y el transporte del módem y su firmware están admitidos. El proceso
celular actualiza los ajustes guardados con exclusión de mutaciones y un registro
persistente para restaurarlos. Después verifica los valores escritos. Conserva
los perfiles manuales, las suscripciones desconocidas, los operadores sin
calificar y el firmware no admitido. El perfil debe coincidir con el dispositivo
y con la SIM; coincidir solo con el operador no basta.

El cambio se aplica en la siguiente activación. No desconecta una conexión activa
ni inicia otra llamada de datos. IPv6 no agrega una ruta predeterminada ni DNS
automático al sistema. Si una escritura falla, se restauran y verifican los
ajustes anteriores. Si la restauración no se puede verificar, el dispositivo
permanece bloqueado para nuevas mutaciones. La recuperación comprueba la identidad
física y la SIM antes de cambiar el perfil guardado.

La implementación es parcial. Todavía no incluye selección automática de APN,
preparación de la primera activación, QMAP/raw-IP/EPS, control de RNDIS, CLAT ni
comprobaciones del tráfico. Tampoco acredita compatibilidad real con un operador
o hardware. Verizon sigue sin calificar.
