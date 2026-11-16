# Turning on a hotspot and cancelling preparation

In the hotspot dialog, **Enable Hotspot** opens a confirmation showing the
network name and password. Keep those details before continuing. Turning the
radio into a hotspot may disconnect the Wi-Fi link you use to reach the box;
the confirmation describes that risk for the selected radio mode.

You can keep the suggested details, edit them or choose **New random password**.
Changing either field clears the acknowledgement. Review the current pair,
acknowledge it, then choose **Turn on hotspot**. If the details cannot be read,
activation stays unavailable; **Try again** retries preparation.

Preparation can store the chosen name and password before requesting the
hotspot start. **Cancel** remains available while that preparation is waiting.
Cancelling dismisses the confirmation and prevents its later reply from
requesting a new hotspot start. A reply arriving after the confirmation view
has been removed also cannot start it.

Cancel does not undo credentials already stored, cancel the earlier device
request or prove that nothing changed. A failed or lost preparation reply can
leave the stored details uncertain. Reopen the confirmation and review the
details the device reports before deciding whether to activate again. An
explicit new attempt can send another preparation request.

Once a hotspot start has already been requested, dismissing a view does not
stop it. Check the reported hotspot state. When it is active, the hotspot
dialog's **Turn Off** action requests a separate stop; it is not a rollback
of credential preparation.

These interface boundaries have component-test coverage. Browser outages,
device state and restoration of a dropped Wi-Fi link need separate qualification.
