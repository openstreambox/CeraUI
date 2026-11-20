# Subscription and transport policy

These modules are a policy foundation. They are not wired into the cellular
composition root and do not change device behavior. In particular, an
`internal-call` quirk describes an adapter requirement; it does not start an
RNDIS owner. No Python service is a production dependency.

`subscription-policy.ts` accepts only subscription home PLMN, serving PLMN,
SPN, GID1 and the registration state. A present home PLMN always wins,
including when it is unknown to this policy. Missing home evidence permits a
serving fallback only while the modem reports a home registration (`home`,
`home-sms-only`, `home-csfb-not-preferred`); a roaming or unregistered SIM is
`unknown`, so its profile is preserved. Reseller rules precede direct-carrier
rules. The table chooses the APN only. The bearer family comes from
`bearer-ip-family.ts` (`subscriptionBearerFamily`), the resolver the running
profile reconciliation already uses, so a planned profile can never disagree
with `convergeBearerIpFamily`. Verizon recognition returns
`not-qualified`; a caller must not apply its suggested settings automatically.
Policy eligibility does not establish hardware or carrier qualification.

Hardware model, exact firmware and composition are inputs only to
`transport-policy.ts`. Unknown firmware has no admitted adapter. Serial ports
are resolved by USB device, interface and generation; tty numbering has no
identity authority. A listed model with an unlisted firmware build has no
adapter. QMAP parsing requires one rule-zero readback. The EPS policy compares
APNs case-insensitively and families exactly, and permits one attempt followed
by verification or a blocked state. Its
future effect owner must durably save the baseline and consumed attempt before
any setter, including a setter that fails, keyed to the modem+SIM pair.

`subscription-profile.ts` plans device+SIM-bound NM fields. It preserves manual,
unknown and unqualified policies. A profile belonging to another device or SIM
cannot be reused merely because its operator matches. Its IP fields are
exactly `bearerIpFamilyFields(family)`: IPv4-only stays the historical request,
and an IPv6 request is source-only, without a main default route. Whether a
cellular profile should also ignore automatic IPv6 DNS is left to the DNS
routing layer; this planner does not change it. This planner does not implement NM
reconciliation, profile ownership discovery or lifecycle mutation admission.
The planner's `automatic` flag is retained owner/operator intent, not simply an
NM `gsm.auto-config` readback: applying an explicit policy sets that NM property
to `no` and must not silently turn automatic policy into manual intent.

`path-health-policy.ts` uses monotonic milliseconds and one state per
modem+SIM path; a new USB or bearer generation resets readiness in place. USB absence withdraws readiness immediately and
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
cellular owner. Runtime wiring and a disconnected network-namespace gate remain
required before claiming automatic connectivity.
