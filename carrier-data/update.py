#!/usr/bin/env python3
"""Convert pinned LineageOS APNs offline; --fetch restores pinned downloads."""
import argparse
import hashlib
import importlib.util
import io
import json
import re
from pathlib import Path
import tarfile
import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'sources'
OUTPUT = ROOT / 'carriers.json'


def validate_match(kind, value):
    if not value or value != value.strip() or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value):
        raise ValueError(f'Invalid {kind} match: {value!r}')
    if kind == 'gid' and not re.fullmatch(r'[0-9A-Fa-f]+', value):
        raise ValueError(f'Invalid GID hex: {value!r}')


def verify_sources():
    expected = {}
    for line in (DATA / 'SHA256SUMS').read_text().splitlines():
        digest, name = line.split('  ', 1)
        if name.startswith('sources/'):
            rel = name.removeprefix('sources/')
            if rel in expected or Path(rel).is_absolute() or '..' in Path(rel).parts:
                raise ValueError(f'Invalid manifest path: {name}')
            expected[rel] = digest
    actual = {str(p.relative_to(DATA)) for p in DATA.rglob('*')
              if p.is_file() and p.name != 'SHA256SUMS' and '__pycache__' not in p.parts}
    if actual != set(expected):
        raise ValueError('Hash mismatch: source manifest file set')
    verified = {}
    for rel, digest in expected.items():
        content = (DATA / rel).read_bytes()
        if hashlib.sha256(content).hexdigest() != digest:
            raise ValueError(f'Hash mismatch: {rel}')
        verified[rel] = content
    return verified


def merged_rows():
    # Verify every input before executing the merger; compile verified bytes so
    # an unverified bytecode cache cannot replace the checked source.
    verified = verify_sources()
    spec = importlib.util.spec_from_file_location('lineage_merge', DATA / 'lineage/make-apns.py')
    merger = importlib.util.module_from_spec(spec)
    exec(compile(verified['lineage/make-apns.py'], str(spec.origin), 'exec'), merger.__dict__)
    base = [a.attrib for a in ET.fromstring(verified['lineage/upstream/apns-conf.xml']).iter('apn')]
    local = [a.attrib for path in sorted((DATA / 'lineage').glob('*.xml'))
             for a in ET.fromstring(verified[str(path.relative_to(DATA))]).iter('apn')]
    # The snapshot has no schema input. Use the source attributes as the known
    # vocabulary, retaining upstream's strict rule validation and type lists.
    known_attributes = {key for row in base + local for key in row}
    config = merger.load_config(DATA / 'lineage/merge-apns-conf.yaml', known_attributes)
    base = merger.apply_rules(merger.deduplicate(base), config)
    return [(a, 'lineage-upstream') for a in base] + [(a, 'lineage-local') for a in local]


def convert():
    rows, seen = [], set()
    for a, origin in merged_rows():
        types = [t.strip() for t in (a.get('type') or '*').split(',') if t.strip()]
        if not a.get('apn') or not ({'default', '*'} & set(types)):
            continue
        # A WAP name alone is not evidence of a legacy gateway.
        if a.get('proxy') and re.search(r'wap', a.get('carrier', '') + ' ' + a['apn'], re.I):
            continue
        if a.get('carrier_enabled') == 'false':
            continue
        if not re.fullmatch(r'\d{3}', a.get('mcc', '')) or not re.fullmatch(r'\d{2,3}', a.get('mnc', '')):
            continue
        mask = set(a.get('network_type_bitmask', '').split('|'))
        if mask and mask <= {'4', '5', '6', '7', '12'}:
            continue
        kind, value = a.get('mvno_type', '').lower(), a.get('mvno_match_data', '')
        if kind not in {'gid', 'spn'} or not value:
            continue
        # One documented source defect: XML numeric CR in C Spire's SPN.
        # Do not silently normalize new defects on future source bumps.
        if kind == 'spn' and value == 'C Spire\r':
            value = 'C Spire'
        validate_match(kind, value)
        row = dict(plmn=a['mcc'] + a['mnc'], apn=a['apn'], name=a.get('carrier', ''),
                   mvno=kind, match=value, protocol=a.get('protocol', 'IP'),
                   roamingProtocol=a.get('roaming_protocol', 'IP'), source='android',
                   origin=origin, types=types, usage='data')
        for src, dest in [('user', 'user'), ('password', 'password'), ('authtype', 'authtype'),
                          ('proxy', 'proxy'), ('port', 'port'), ('carrier_id', 'carrierId'),
                          ('mtusize', 'mtu')]:
            if src in a:
                row[dest] = a[src]
        # Origin/name are provenance, not connection settings or identity.
        identity = json.dumps({k: v for k, v in row.items() if k not in {'origin', 'name'}}, sort_keys=True)
        if identity not in seen:
            rows.append(row)
            seen.add(identity)
    encoded = json.dumps(rows, ensure_ascii=False, separators=(',', ':')) + '\n'
    OUTPUT.write_text(encoded)
    # Alternate destinations must never change the checked-in integrity manifest.
    if DATA == ROOT / 'sources' and OUTPUT == ROOT / 'carriers.json':
        hashes = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in sorted(DATA.rglob('*'))
                  if p.is_file() and p.name != 'SHA256SUMS' and '__pycache__' not in p.parts}
        hashes['carriers.json'] = hashlib.sha256(encoded.encode()).hexdigest()
        (DATA / 'SHA256SUMS').write_text(''.join(f'{h}  {p}\n' for p, h in hashes.items()))


def fetch():
    entry = json.loads((DATA / 'sources.json').read_text())['downloads']['lineage.tar.gz']
    data = urllib.request.urlopen(entry['url']).read()
    if hashlib.sha256(data).hexdigest() != entry['sha256']:
        raise ValueError('Hash mismatch: lineage.tar.gz')
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        files = {}
        for member in archive.getmembers():
            rel = Path(*Path(member.name).parts[1:])
            if member.isfile() and ((len(rel.parts) == 1 and rel.suffix == '.xml') or
                                    str(rel) in {'upstream/apns-conf.xml', 'merge-apns-conf.yaml',
                                                 'make-apns.py', 'LICENSES/Apache-2.0.txt'}):
                files[rel] = archive.extractfile(member).read()
        for old in (DATA / 'lineage').rglob('*'):
            if old.is_file() and old.relative_to(DATA / 'lineage') not in files:
                old.unlink()
        for rel, content in files.items():
            target = DATA / 'lineage' / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fetch', action='store_true')
    parser.add_argument('--source-dir', type=Path, default=DATA)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    DATA, OUTPUT = args.source_dir.resolve(), args.output.resolve()
    if args.fetch:
        fetch()
    convert()
