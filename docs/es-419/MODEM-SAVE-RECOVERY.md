# Guardar y revisar los ajustes de conexión del módem

Esta guía cubre los ajustes de conexión, como el APN y la itinerancia, en el diálogo de configuración del módem.

**Guardar** envía una escritura de ajustes. La confirmación requiere que los ajustes de conexión informados coincidan. **Ajustes no guardados** indica un rechazo; lee el motivo antes de decidir qué hacer.

**Ajustes sin confirmar** significa que la interfaz no ha confirmado qué ajustes guardó el módem. Puede aparecer tras un vencimiento del plazo o una respuesta interrumpida o incierta. Un vencimiento del plazo o el fin del indicador de espera no cancela la escritura anterior, no demuestra que haya fallado ni que sus efectos hayan desaparecido.

Usa **Comprobar de nuevo** para comparar el intento de guardado con la última observación de ajustes del módem que la interfaz ya recibió. Esto no envía una escritura ni solicita una consulta nueva al dispositivo. Si aparece “El módem sigue sin informar estos ajustes.”, el resultado continúa sin confirmar. Una observación posterior que coincida puede resolver el aviso cuando vuelvas a comprobar.

Si eliges **Guardar** otra vez, envías otra escritura. Las respuestas tardías del intento anterior no pueden sobrescribir el borrador del nuevo intento ni resolver su resultado en la interfaz. El guardado actual todavía necesita ajustes informados que coincidan para confirmarse. Los efectos de la escritura anterior en el dispositivo siguen siendo desconocidos; la protección de la interfaz no los revierte ni garantiza qué valores conservará el dispositivo al final.

Cuando termine el estado pendiente, cerrar y volver a abrir el diálogo carga el formulario con los últimos ajustes informados. Esto puede reemplazar cambios sin guardar. Una respuesta tardía del guardado anterior no puede sobrescribir el borrador reabierto. Volver a abrir el diálogo no cancela ni confirma la escritura anterior.

Estas reglas tienen cobertura de orden de eventos a nivel de componente. La recuperación ante caídas en un navegador real y la conexión con el operador requieren validación por separado.
