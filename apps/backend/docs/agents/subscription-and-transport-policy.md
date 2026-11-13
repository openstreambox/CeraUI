# Subscription and transport policy

The pure modules are a policy foundation. The stored bearer-family owner below
is their first runtime consumer; other planned runtime effects remain separate. In particular, an
`internal-call` quirk describes an adapter requirement; it does not start an
RNDIS owner. No Python service is a production dependency.

`subscription-policy.ts` accepts only subscription home PLMN, serving PLMN,
SPN and GID1. A present home PLMN always wins, including when it is unknown to
this policy. Missing home evidence permits an explicit serving fallback.
Reseller rules precede direct-carrier rules. Verizon recognition returns
`not-qualified`; a caller must not apply its suggested settings automatically.
Policy eligibility does not establish hardware or carrier qualification.

Hardware model, exact firmware and composition are inputs only to
`transport-policy.ts`. Unknown firmware has no admitted adapter. Serial ports
are resolved by USB device, interface and generation; tty numbering has no
identity authority. QMAP parsing requires one rule-zero readback. The EPS
policy permits one attempt followed by verification or a blocked state. Its
future effect owner must durably save the baseline and consumed attempt before
any setter, including a setter that fails, keyed to the modem+SIM pair.

`subscription-profile.ts` plans device+SIM-bound NM fields. It preserves manual,
unknown and unqualified policies. A profile belonging to another device or SIM
cannot be reused merely because its operator matches. IPv6 is source-only,
without a main default or automatic DNS. This planner does not implement NM
reconciliation, profile ownership discovery or lifecycle mutation admission.
The planner's `automatic` flag is retained owner/operator intent, not simply an
NM `gsm.auto-config` readback: applying an explicit policy sets that NM property
to `no` and must not silently turn automatic policy into manual intent.

`path-health-policy.ts` uses monotonic milliseconds and one state per
modem+SIM+bearer generation. USB absence withdraws readiness immediately and
gets a 75-second availability grace; return gets 15 seconds to settle. Neither
charges a carrier failure. Failed traffic withdraws readiness; two failures
request reconnect with 60/120/240/480/900-second capped backoff. Success schedules
five-minute probes. Probe reservations consume a worst-case byte budget before
work starts, and transport changes preserve the remaining budget. The effect
owner must bound each probe, bind its socket to both source and device, prevent
overlapping probes, and deliver each result once. Old generations are ignored.

The colocated replay tests are synthetic policy scenarios. They cover SIM
movement, old-result rejection, foreign attach settings, family decisions,
independent path health, RNDIS grant parsing and USB return. They do not exercise
real NM, D-Bus, AT serial I/O, translation, kernel routing or the production
cellular owner. Complete runtime ownership and the disconnected real-NM acceptance gate remain
required before claiming automatic connectivity.

## Stored automatic bearer-family owner

`automatic-bearer-family.ts` is the first runtime consumer. The modem poll calls
it outside the reconcile lock, before retained ready activation. It only admits
existing automatic profiles, recognized subscriptions and exact NM-owned
transport tuples. It changes IP-family fields, with source-only IPv6 and no
reconnect; APN application and first-activation preparation remain separate.

The owner reads NM's device+SIM binding, journals the complete previous IP fields
with the existing modem-config lifecycle lease, rechecks intent and physical
pair before dispatch, then verifies readback. Failed writes try their inverse;
failed inverse verification retains the durable mutation block. The rollback
handler is imported with the poll owner before boot recovery. Its versioned
pre-state deliberately contains no USB-descriptor baseline that could falsely
compare equal while the NM fields still differ. Recovery resolves the live
physical key, device and SIM independently of the not-yet-hydrated modem roster.
Legacy journal shapes are refused by this handler. No active bearer is reset.

Operator guidance is in [automatic cellular families](../../../../docs/CELLULAR-AUTOMATION.md).
The disconnected IPv6/NAT64 kernel test covers the restored utility layer; it is
not the complete real-NM, CLAT or lifecycle acceptance gate.
