#!/usr/bin/env python3
"""Convert pinned APN sources offline; --fetch restores the pinned downloads."""
import argparse
import base64
import hashlib
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

def convert():
    rows = []
    # Local carrier definitions precede AOSP's generic definitions.
    for source in [*sorted((DATA / 'lineage').glob('*.xml')), DATA / 'apns-full-conf.xml']:
        for apn in ET.parse(source).getroot().iter('apn'):
            a = apn.attrib
            if not a.get('apn') or not ({'default', '*'} & set(a.get('type', 'default').split(','))):
                continue
            if a.get('carrier_enabled') == 'false':
                continue
            if not re.fullmatch(r'\d{3}', a.get('mcc', '')) or not re.fullmatch(r'\d{2,3}', a.get('mnc', '')):
                continue
            mask = set(a.get('network_type_bitmask', '').split('|'))
            if mask and mask <= {'4', '5', '6', '7', '12'}:
                continue  # CDMA/EVDO-only profiles cannot serve LTE/5G modems.
            if a.get('mvno_type', '').lower() not in {'gid', 'spn'} or not a.get('mvno_match_data'):
                continue
            rows.append({k: v for k, v in {
                'plmn': a['mcc'] + a['mnc'], 'apn': a['apn'],
                'name': a.get('carrier', ''), 'mvno': a['mvno_type'].lower() if a.get('mvno_type') else None,
                'match': a.get('mvno_match_data'), 'protocol': a.get('protocol', 'IP'),
                'roamingProtocol': a.get('roaming_protocol', 'IP'),
                'source': 'android', 'origin': 'lineage' if source.parent.name == 'lineage' else 'aosp',
            }.items() if v is not None})
    encoded = json.dumps(rows, ensure_ascii=False, separators=(',', ':')) + '\n'
    OUTPUT.write_text(encoded)
    hashes = {str(p.relative_to(ROOT)) if p.is_relative_to(ROOT) else str(p.relative_to(DATA)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted(DATA.rglob('*')) if p.is_file() and p.name != 'SHA256SUMS'}
    output_name = str(OUTPUT.relative_to(ROOT)) if OUTPUT.is_relative_to(ROOT) else OUTPUT.name
    hashes[output_name] = hashlib.sha256(encoded.encode()).hexdigest()
    (DATA / 'SHA256SUMS').write_text(''.join(f'{h}  {p}\n' for p, h in hashes.items()))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fetch', action='store_true')
    parser.add_argument('--source-dir', type=Path, default=DATA)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    DATA, OUTPUT = args.source_dir.resolve(), args.output.resolve()
    if args.fetch:
        for name, entry in json.loads((DATA / 'sources.json').read_text())['downloads'].items():
            data = urllib.request.urlopen(entry['url']).read()
            if name == 'apns-full-conf.xml':
                data = base64.b64decode(data)
            if hashlib.sha256(data).hexdigest() != entry['sha256']:
                raise SystemExit(f'Hash mismatch: {name}')
            if name == 'lineage.tar.gz':
                with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                    for member in archive.getmembers():
                        rel = Path(*Path(member.name).parts[1:])
                        if member.isfile() and ((len(rel.parts) == 1 and rel.suffix == '.xml') or str(rel) == 'LICENSES/Apache-2.0.txt'):
                            target = DATA / 'lineage' / rel
                            target.parent.mkdir(parents=True, exist_ok=True)
                            target.write_bytes(archive.extractfile(member).read())
            else:
                (DATA / name).write_bytes(data)
    convert()
