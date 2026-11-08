# Administración de eSIM

La administración experimental de eUICC de consumo está disponible en Red → configuración del módem → Avanzado → Perfiles eSIM. Primero activa el módulo eSIM en Ajustes. El host necesita el asistente, una asignación de módem y tarjeta revisada y la compilación fijada de lpac.

## Obtener un perfil

Pide al proveedor la instalación en la eUICC del equipo. Conserva el código QR, la cadena completa `LPA:1` o la dirección SM-DP+ y el identificador de activación por separado. Algunos proveedores también entregan un código de confirmación o ePIN. Las credenciales de la cuenta permiten obtener esos datos. El PIN y el PUK de la SIM se ingresan en la pantalla de desbloqueo de SIM.

Telekom ofrece un código de instalación manual en su app y un QR en su portal. Vodafone documenta el envío de QR y ePIN por correo para CallYa y los datos de activación en MeinVodafone. Airalo ofrece instalación por QR y manual, además de instalación directa en dispositivos compatibles. Consulta con el proveedor la compatibilidad con la eUICC de destino y las reglas para obtener otro código. [Telekom](https://www.telekom.de/hilfe/mobilfunk/sim/esim-aktivieren) · [Vodafone](https://www.vodafone.de/hilfe/alles-zur-esim.html) · [Airalo](https://developers.partners.airalo.com/get-installation-instructions-11883029e0)

## Usar la pantalla del módem

1. Detén la transmisión, desconecta la sesión de datos de este módem y mantén otra conexión a internet disponible.
2. Abre Administrar eSIM, acepta la desconexión temporal y selecciona Leer perfiles. La lectura también requiere acceso exclusivo a la tarjeta.
3. Elige una foto o captura del QR, pega el código LPA completo o ingresa los campos manuales. Ingresa el código de confirmación si lo recibiste. Confirma la advertencia de descarga.
4. La descarga se verifica mediante una nueva lectura. El perfil queda desactivado hasta que selecciones Activar y confirmes la reconexión.
5. Revisa el APN, la itinerancia, el registro y la conexión de datos en los controles existentes del módem.
6. Desactiva un perfil antes de eliminarlo. La eliminación es permanente, puede requerir otro código para reinstalarlo y mantiene vigente el contrato con el proveedor.

Los códigos pueden ser de un solo uso. La vigencia del plan puede comenzar al instalarlo o al usar la red por primera vez, según el proveedor. El QR se decodifica localmente en el navegador. Los códigos se ocultan y se borran al enviarlos o cerrar la sección. Si se desconoce el resultado, inspecciona la tarjeta antes de repetir una descarga.

## Integración del host y recuperación

La primera compilación admite transportes AT y AT/CSIM seleccionados explícitamente por un administrador. Cada combinación de firmware, adaptador y eUICC necesita pruebas. El transporte AT de lpac tiene límites de tiempo documentados. La descarga usa otra conexión a internet mientras los comandos de tarjeta pasan por el módem seleccionado. [Límites de AT](https://github.com/estkme-group/lpac/blob/a43e46aef6f8b5b1d144bf3b3fc5999d8fcefacc/docs/backends/at.md)

Consulta el procedimiento técnico, las rutas de instalación y el formato privado de asignación en `docs/ESIM.md`. El asistente verifica la identidad física, la tarjeta y el estado reciente de los perfiles. Restaura la configuración del puerto serie y libera la inhibición antes de responder. Las escrituras se ejecutan una sola vez.

Cada operación usa el bloqueo compartido de transmisión/módem y un registro durable. Una interrupción o un resultado incierto mantiene el bloqueo de recuperación. La coincidencia de descriptores USB no verifica una restauración de eUICC. Inspecciona los perfiles antes de aceptar explícitamente una base nueva. Las descargas y eliminaciones carecen de restauración automática.

Los artefactos de desarrollo incluyen el asistente y su receta para revisión. La instalación física, las pruebas prolongadas, las imágenes firmadas y las actualizaciones OTA requieren validación adicional. Las instrucciones en inglés y es-419 se publicarán en el sitio de documentación durante la versión coordinada de esta función.
