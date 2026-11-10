# Saving modem connection settings and checking the result

This guide covers connection settings such as APN and roaming in the modem configuration dialog.

**Save** sends a settings write. Confirmation requires matching reported connection settings. **Settings not saved** reports a refusal; read its reason before deciding what to do next.

**Settings not confirmed** means the interface has not confirmed which settings the modem stored. It can appear after a timeout or an interrupted or unknown response. A timeout or a stopped spinner does not cancel the earlier write, prove that it failed, or prove that its effects have disappeared.

Use **Check again** to compare the saved attempt with the latest modem settings observation already received by the interface. This sends no settings write and requests no fresh device poll. If it says “The modem still has not reported these settings back.”, the outcome remains unconfirmed. A later matching observation can resolve the warning when you check again.

If you choose **Save** again, you send another write. Late replies from the earlier attempt cannot overwrite the retry's draft or settle its interface outcome. The current save still needs matching reported settings for confirmation. The earlier write's device effects remain unknown; the interface guard does not undo them or guarantee which values the device will eventually retain.

Once the pending state has ended, closing and reopening the dialog seeds the form from the latest reported settings. This can replace unsaved edits. A late reply from the previous save cannot overwrite the reopened draft. Reopening does not cancel or confirm the earlier write.

These rules have component-level ordering coverage. Real-browser outage recovery and carrier connectivity require separate qualification.
