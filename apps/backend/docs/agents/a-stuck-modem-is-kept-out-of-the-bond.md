# A stuck modem is kept out of the bond, not every stream

The modem mutation journal (`mutation-journal*.ts`, `mutation-blocks.ts`) still
records a change that could not be undone (`failed`) or a modem that went
missing mid-change (`device-absent-quarantine`), and `streamingBlockingMutation()`
still reports what the journal says. Stream admission
(`stream-session-production.ts`) asks `globalStreamHold()` instead:

- a change still in flight (`armed`, `executing`: refusal `mutation_in_progress`)
  holds every stream start, as before;
- a failed or quarantined modem (refusal `mutation_blocked`) does not, because
  `isBondCandidate` keeps its interfaces out of the bond by stable key
  (`isHeldOutByModemBlock`): the udev path of where it is plugged in, so a
  re-enumeration under a new name stays out. While any modem is blocked, a USB
  interface whose key cannot be resolved is held out too. Ethernet, Wi-Fi and
  interfaces with an unblocked key are never affected, and a blocked modem's
  CLAT translator TUN leaves with it.

`setMutationBlocks` notifies `onMutationBlocksChange` listeners on any change, and
the interface layer republishes the bond. `held-out-modem-notice.ts` raises one
persistent, non-dismissable notice per failed or quarantined modem
(`notifications.modemHeldOut` with the modem's name, or
`notifications.modemHeldOutUnknown` when no current row has its key) and
retracts it when the block clears.

Tests: `tests/cellular-realistic-box.test.ts` (fixture
`tests/fixtures/realistic-box.ts`), `modules/modems/held-out-modem-notice.test.ts`.
