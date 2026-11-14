# SRT output encryption: consumer preparation

The published `@ceralive/cerastream` 2026.9.11 binding has no passphrase or
key-length fields in `start.srt`. The inspected engine package 2026.9.8 also
has an eight-field SRT config, with no discoverable passphrase/environment
option. No supported URI, stream-ID or pipeline workaround was established.
This consumer change does not enable encrypted output and must remain a draft
until the producer lands.

The config input and persistence schema reserve `srt_passphrase` (10–79 UTF-8
bytes, preserving spaces) and `srt_pbkeylen` (16/24/32 bytes; default 16).
Passphrases are excluded from config, Start and setConfig replies, and scrubbed
by nested log redaction. Empty explicitly clears a retained value; omission
preserves it. Nonempty writes and key-length writes are refused before config
mutation. Start refuses retained encryption configuration before engine IPC.
The encryption passphrase is never passed in a host, URI, stream ID, environment or command line.

The stream-settings component includes a hidden password field, visibility
control, validation and key-length selector in all ten shipped locales.
The production admission gate is closed. It is a compile-time producer-contract
gate, not an invented engine capability. An affirmative wire capability cannot
be consumed until its producer exports and publishes its schema.

Before enabling:

1. Publish engine and binding support for secret-safe Start/config plus an
   affirmative capability; old, cached, unavailable and absent support stay closed.
2. Replace the closed gate with live producer evidence at RPC and Start, wire the
   published Start fields, and complete accepted-write persistence atomically.
3. Keep plaintext recoverable credentials in a restricted device file (0600),
   exclude them from all diagnostic/config exports, and return only a separate
   configured flag. The current config loader does not encrypt files at rest;
   hashing is unsuitable for an SRT credential that must be recovered at Start.
4. Prove correct/wrong/absent passphrase and all key lengths with a real encrypted
   receiver, directly and through SRTLA. Never fall back to unencrypted output.
5. Coordinate English and Spanish user documentation in the enabling release.

SRTLA proxies carry encrypted SRT packets; they need no passphrase and should
never receive one. The existing relay validation secret is a separate validation
input, not persisted SRT output encryption.

SRT option semantics: [SRTO_PASSPHRASE and SRTO_PBKEYLEN](https://github.com/Haivision/srt/blob/master/docs/API/API-socket-options.md).

## Existing access-control alternative

A receiver can validate a keyed Stream ID using the caller's existing
stream-ID field without an engine encryption change. This is bearer-key
publisher admission, not media encryption. SRTLA preserves the inner SRT
handshake and packets. Stream ID remains clear handshake metadata even with
ordinary SRT payload encryption; never use the encryption passphrase as the ID.

A listener must implement actual key validation. Merely adding a URI path or
setting streamid on a listener does not create an access-control policy.
Encryption support remains useful for receivers requiring a passphrase and
for private capture workflows.

Stream IDs are write-only secrets as described in [Stream ID handling](STREAM-ID-SECURITY.md).
Both protections apply together at config events, remote relays and diagnostic
boundaries. Retained passphrases are scrubbed by value, including encoded forms,
and Error messages and stacks pass through the same scrub before log storage.
