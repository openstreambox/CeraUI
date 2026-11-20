# Changing an Ethernet port role and checking the result

Open **Configure** for the intended wired port. Under **Port role**, choose
**Uplink** or **Shared LAN**, then **Save** to request a change. Selecting an
option alone stages it. An ordinary unchanged Save sends no role request. Do not
switch through the other role just to force a retry.

To reapply a displayed **Shared LAN** choice, choose **Retry** beside its Shared
LAN label. Retry only stages one recovery request. Review **Applies when you
save** and the connection-disruption warning, then choose **Save** to send it.
Choose Retry again to unstage it, or **Cancel** to discard it. Selecting Uplink,
closing/reopening the dialog or changing ports also clears the unsent request.
Each recovery request sent by Save consumes the staged intent even if its result
is unconfirmed; an error, timeout or observation does not automatically rearm or
repeat it. Another ordinary unchanged Save remains an ordinary Save unless you
stage Retry again. Retry is disabled while this port has a save, role operation
or network operation in progress; another port's pending work does not disable
this control.

**Uplink** makes the port eligible for the SRTLA bond. **Shared LAN** removes it
from that bond and requests NetworkManager's shared IPv4 configuration for local
clients. Switching a port that carries stream traffic can remove that bandwidth.
Either change can interrupt management access through that port. Plan for that
interruption before saving; another connection is not a guarantee of recovery.
These are manual choices. A missing DHCP reply does not establish a client-only
link, and there is no Auto direction control in this flow.

## When a change is unconfirmed

**Role change didn't complete** does not prove that nothing changed or that the
previous physical role was kept. A profile may already have been added or
modified, or an activation may have taken effect before its reply was lost.
Failure to confirm a usable profile can also mean an unavailable read, an
unsupported response or a mismatched interface; it does not prove no saved
profile exists.

Review the correct port's reported role and **Address** before deciding whether
to request another change. The displayed role can reflect restored stored
intent; it is not independent proof of the profile's active configuration,
working internet or restored management access. Closing or reopening the dialog
does not cancel an earlier request. A late reply from a closed, replaced or
unmounted dialog cannot start its following configuration write or close the new
view; this does not undo a request already sent to the device. Choosing Uplink
and saving a new change is another request, not a physical rollback of the
earlier one. A failed role request stops the rest of that Save.

## How a new Shared LAN request recovers

When an explicit Shared LAN request needs a new profile, the backend first
stores a unique profile ID (UUID) for that port, then requests creation. After a
lost or uncertain reply it retains that reservation. If no profile is active, a
later explicit request checks the same ID and its Ethernet type and interface
binding. It reuses a valid profile; it may add that same ID only after a
successful read confirms it is absent. An unavailable or mismatched read cannot
authorize another add. It does not adopt arbitrary inactive profiles, allocate
another ID after an uncertain add, delete the uncertain profile or automatically
replay the add.

At boot, recovery can reuse a valid existing owned profile for a stored Shared
LAN choice. It does not create a missing profile. A missing or unreadable
profile can therefore remain unresolved. Restarting or an ordinary unchanged
Save is not a forced repair; Retry followed by Save requests recovery
explicitly, and can still return an unconfirmed result.

The profile ordering and recovery rules have deterministic source/mock coverage.
Native DHCP/DNS/NAT, subnet conflicts, management continuity, two-port behavior
and stream recovery still need qualification. Catalog generation, full builds,
website publication, locale rendering and browser behavior are separate checks;
this guide does not establish them.
