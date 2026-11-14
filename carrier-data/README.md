# Standalone Android MVNO APN evidence

NetworkManager already picks APNs using mobile-broadband-provider-info. This
standalone module supplies additional virtual-operator (MVNO) candidates from
Android GID1 and service-provider-name (SPN) rules. It does not apply an APN.
There are no CeraUI imports, runtime downloads or effects.

```ts
import { matchMvnoApn } from './index.ts';
const result = matchMvnoApn({ homePlmn: '310260', gid1: '2AC9' });
// { candidates: [...], ambiguous: boolean }
// Empty means no correction. Multiple candidates require host policy.
```

Every matching row is returned in source order, including matches from both
GID1 and SPN. No row wins by being first. `ambiguous` is true whenever more than
one row matches, even with the same APN. Returned rows and type arrays are
copies. GID1 uses a case-insensitive hex prefix; SPN uses a full case-insensitive
name match (input whitespace trimmed). PLMN width is significant.

Candidates preserve Android `types`, `usage: "data"`, protocol/roaming protocol,
`user`, `password`, `authtype`, `proxy`, `port`, `carrierId` and `mtu` when
present. Missing and explicitly empty credentials remain distinguishable.
Authentication values are Android strings (-1 unspecified, 0 none, 1 PAP,
2 CHAP, 3 PAP-or-CHAP), not NetworkManager flags. The host must translate them
and decide whether it supports a candidate's proxy. Source credentials are
public carrier defaults, never subscriber secrets.

## Integration boundary (not implemented)

The host needs **SIM** `OperatorIdentifier` as `homePlmn`, **SIM** `Gid1` as
hex-encoded bytes (e.g. [222,255] becomes `DEFF`, no spaces or `0x`), and
**SIM** `OperatorName` as SPN. modem-stack currently reads the serving
`Modem3gpp.OperatorCode/OperatorName`; these are wrong inputs while roaming.
Its SIM ICCID read does not supply this evidence. Decide GID1/SPN redaction
before logging or exposing observations.

A reseller resolution under auto intent needs an explicit applied state:
auto intent resolved to a particular candidate and source revision, although NM
has an explicit APN and `gsm.auto-config no`. Otherwise reconcile compares that
APN with literal `auto` and continually reports drift or rewrites it.
Receipts must preserve auto intent rather than derive it from NM's auto-config
bit: define how APN failure maps to unsupported/failed, the unavailable advisory,
and bounded fallback to NM's lookup. Ambiguous or unsupported candidates must
defer to host policy; the module never picks the first.

Applying a candidate must atomically replace APN and its translated credentials,
clearing stale credentials when absent. Returning to NM auto-config must clear
APN and credentials together; returning to manual intent must restore the user's
explicit values. Existing `profileFromPolicy` drops credentials under auto and
`toAutoArgs` clears them, so neither can apply credential-bearing reseller rows
unchanged. Mutation admission, SIM-change invalidation, protocol/MTU/proxy policy,
activation and fallback remain host work. See [design note](DESIGN.md).

## Sources and reproduction

The snapshot uses LineageOS's own `upstream/apns-conf.xml`, build-time excludes
and overrides, then sorted country supplements, at the commit in
`sources/sources.json`. The pinned upstream merger supplies rule semantics.
The old AOSP 14 sample is no longer the runtime base. The derived snapshot has
929 distinct data candidates. Generic, unsupported identity, disabled,
invalid-PLMN, CDMA/EVDO-only and MMS-only rows are excluded. Legacy WAP profiles
are excluded conservatively when the carrier label or APN contains "wap";
Android's default type alone cannot distinguish these. This heuristic may
exclude a usable mixed profile. Other data proxies are preserved.

Data quality remains imperfect: the pinned C Spire SPN contains a trailing
numeric CR, corrected by one exact, documented exception; other whitespace,
control characters or invalid GID hex fail generation. Some PLMN expansions
look questionable (e.g. iusacell on 20601). No connectivity certification is
implied. Exact connection duplicates collapse with first provenance retained;
different identities, authentication, types or protocols remain separate.

There is **no US Mobile entry** in these pinned sources. The previous invented
fixture is replaced by real rows. `fixtures/android14-regressions.json` retains
projected AOSP 14 rows to test the historical DEFF tfdata/ereseller collision
and Coriolis WAP/WEB filtering; it is not runtime data. The current Lineage base
has only ereseller for 310410/DEFF and does not supply the former Coriolis WEB row.

From this directory, install the converter-only dependency in your preferred
environment (`requirements-update.txt`), then:

```sh
python3 -I update.py
python3 -I update.py --fetch
sha256sum --check sources/SHA256SUMS
bun test --parallel=1 --max-concurrency=1
python3 -I -m unittest discover -p test_update.py
```

Conversion is offline except explicit `--fetch`, which verifies the pinned
archive hash. A changed GitHub archive encoding will fail closed and needs
review even if XML content is unchanged. Fetch replaces only managed source
files and removes stale files. Alternate `--output` or `--source-dir` runs
never rewrite the checked-in manifest. Source bumps need reviewed pins,
regeneration, diff review and tests. MBPI is not copied or reimplemented.
Code is GPL-3.0-only; data and upstream merger are Apache-2.0, with original
notices retained and a module-level licence and modification notice.
