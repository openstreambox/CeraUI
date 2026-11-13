<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## FIELD ORDER IS LOAD-BEARING, AND THE FIXTURES ARE FROZEN BYTES

`telemetry-roundtrip.test.ts` asserts
`JSON.stringify(telemetrySchema.parse(bytes)) === bytes` for the producer-ordered
fixtures. That works only because `connectionTelemetrySchema` and
`telemetrySchema` declare their keys in the Rust producer's own emission order.
Reordering either object literal breaks byte parity — that alarm is the point:
fix the order, never downgrade the assertion to `toEqual`.

The suite exists because a Zod object strips undeclared keys *silently and
successfully*. A reader that has never heard of `iface`/`link_id` parses a mapped
snapshot with no error and hands the consumer a document with both twin modems'
identities deleted. "Does it parse?" cannot see that; re-serializing and
comparing bytes can. The falsifiability control
(`a stripped identity field falsifies the byte-parity assertion`) deletes exactly
what a stripping parser would and REQUIRES the comparison to fail — without it,
byte parity would also pass for a reader that strips fields the producer never
emitted.

`tests/fixtures/*.json` are Rust-producer output, single-line and newline-free
(the ADR-001 atomic-publish shape). Biome would pretty-print them, which breaks
the byte comparison, so they are excluded twice over: `!tests/fixtures` in this
package's `biome.json` and `!packages/srtla-send/tests/fixtures` in the root
config. **Never run `biome check --write` over them**, and never regenerate
`telemetry-legacy-producer.json` — it is the frozen pre-ADR-003 document that
forms the old-shape half of the compatibility proof.

`telemetry-required-binding-refused.json` is copied byte-for-byte from the
sender's required-binding serializer fixture. Its additive disposition is
`required_binding_refused`, with an empty connection pool and degraded status.
It participates in the same byte-parity loop; existing fixture bytes and field
order remain frozen. This state never means a legacy source-only link is running.


`telemetry-pending-apply.json` is copied byte-for-byte from producer commit
`043c0caad7d5509f0d828d6a4f0726d21ef89451`, blob
`c846e0ab1d936938816aa804a73272089434c0d9`. Its empty connection projection
is not teardown acknowledgement: `pending_apply` remains until socket and
reader teardown has joined. Applied telemetry and connection state are published
together. The consumer preserves these frozen bytes and refuses a pending
withdrawal receipt even when its timestamp and empty connections are fresh.
