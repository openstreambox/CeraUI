# Wi-Fi connections when changing adapters

If the selected Wi-Fi adapter changes while the network selector is open, its password draft and local connection indication are cleared. Select the network on the current adapter and enter its password again before choosing **Connect**. A confirmation or inline refusal belonging to another adapter does not establish the result for the current selection.

**Disconnect**, **Forget** and **Scan** also belong to the selected adapter. Changing adapters clears their local waiting indicators; an operation already sent on the previous adapter may still finish. Another adapter's connection or saved-network state cannot confirm the action you are waiting for.

Choose **Scan** to request a scan or join one already pending for the selected adapter. It completes when that adapter reports a later scan result, including an empty result. A scan on another adapter does not complete it.

A connection request already sent on the previous adapter may still complete. Changing the selection or closing the selector does not cancel that request or undo its effects. The selector does not send another connection request automatically; choose **Connect** explicitly when you intend to make another attempt.

A failed attempt to join a new network does not automatically delete saved networks when it is unclear which profiles belong to that attempt. New or partly changed profiles may remain; a failure does not undo earlier effects or prove that nothing happened. Choose **Connect** explicitly if you want the selector to send another request. **Forget** remains a separate deliberate action.
