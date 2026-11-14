# Candidate lookup and future host integration

The lookup is evidence, not an activation decision. It returns all eligible rows
and an explicit ambiguity flag. Source ordering is reproducible, never precedence.
Credential, proxy, usage and protocol differences remain visible to the caller.

The future nm-auto-apn input boundary must read Sim.OperatorIdentifier,
Sim.Gid1 (ModemManager byte array, hex-encoded without separators), and
Sim.OperatorName. Serving operator observations are insufficient during roaming.
Missing evidence means no match; IMSI/ICCID criteria are unsupported.

Auto intent with a reseller APN needs a third applied-state form alongside NM
auto and user manual. Record the candidate and source revision without changing
desired auto intent. Reconciliation must compare this resolved state rather than
comparing the explicit APN against "auto"; SIM changes invalidate it. Activation
receipts must use intent, not only gsm.auto-config, when classifying APN failures,
unsupported status and autoApnUnavailable. Define bounded retry/fallback to NM
and ambiguous-candidate handling before wiring this into a controller.

The existing auto path drops/clears credentials. A resolved-auto write instead
needs to atomically apply APN plus translated Android authentication and public
carrier credentials, clearing previous credentials when absent. Returning to
NM auto must clear them; manual intent must restore user credentials. Proxy,
MTU and IP-family policy require explicit host support. Redact reseller evidence
and secrets in receipts. No observation, mutation, integration or activation is
implemented here.

The README records source quality limitations and reproduction. Lineage base
rows (with excludes/overrides) precede country supplements, matching upstream
build order; projected connection duplicates retain first provenance. New match
defects fail loudly except the documented exact C Spire CR correction.
