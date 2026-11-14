# Standalone Android MVNO APN evidence

NetworkManager already picks APNs using mobile-broadband-provider-info. This
prototype supplies a narrow extra lookup for virtual operators (MVNOs): a matching
Android GID1 or service-provider-name (SPN) row, or no result. It never chooses a
generic host APN. There are no CeraUI imports, runtime downloads or side effects,
and no application integration is included.

```ts
import { matchMvnoApn } from './index.ts';
const correction = matchMvnoApn({ homePlmn: '310260', gid1: '2AC9' });
// A matching Android row, or undefined: leave NetworkManager lookup unchanged.
```

GID1 follows Android's case-insensitive prefix rule. SPN is a case-insensitive
full-name match, not a fuzzy brand match. Missing identifiers never match.
Only GID/SPN criteria are eligible; generic, IMSI-only and ICCID-only entries are
not selected. Matching rows retain source order, with LineageOS additions before
AOSP. Remaining ambiguity is reported through deterministic source order rather
than inferred from hardware or the currently serving network. No qualification
or certification is inferred.

The data preserves source protocol fields for provenance; this module makes no
IPv4/IPv6 policy decision. A host must keep its own desired-connection policy and
profile writer. This is suitable as a candidate lookup inside modem-stack's
`nm-auto-apn`, before its existing NM lookup, if the maintainer chooses that
integration. Mutation admission, manual intent, credential transitions,
activation receipts and fallback remain the host's responsibility.

## Source and reproduction

`sources/sources.json` pins LineageOS country XML and the AOSP Android 14
maintenance snapshot, which retains explicit MCC/MNC matching. Carrier-ID-only
entries in newer Android data need a separate identity database and are outside
this prototype. The converter filters disabled, non-internet, invalid-PLMN,
CDMA/EVDO-only and non-GID/SPN rows. Original XML and Apache-2.0 notices are
retained in `sources/`; the derived JSON filters and combines those sources.
The licence is `sources/lineage/LICENSES/Apache-2.0.txt`.

From this directory:

```sh
python3 update.py          # reproduce offline
python3 update.py --fetch  # restore pinned downloads, checking hashes first
sha256sum --check sources/SHA256SUMS
bun test --parallel=1 --max-concurrency=1
python3 -m unittest discover -p test_update.py
```

The module has no runtime dependencies. Tests use Bun's built-in runner and
Python's standard library. Copy this directory elsewhere to test it independently.
The converter accepts `--source-dir` and `--output`. An update requires reviewed
source commits and hashes in sources.json, regeneration, diff review and tests.
The system's MBPI fallback is not copied or reimplemented here.
