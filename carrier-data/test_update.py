"""Offline converter contracts and snapshot regeneration."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import io
import tarfile
import hashlib

ROOT = Path(__file__).resolve().parent

def load():
    spec = importlib.util.spec_from_file_location('converter', ROOT / 'update.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def seal(source):
    (source / 'SHA256SUMS').write_text(''.join(
        f'{hashlib.sha256(p.read_bytes()).hexdigest()}  sources/{p.relative_to(source)}\n'
        for p in sorted(source.rglob('*')) if p.is_file() and p.name != 'SHA256SUMS' and '__pycache__' not in p.parts))

class CarrierImportTest(unittest.TestCase):
    def test_real_empty_types_and_wap_data(self):
        module = load()
        with tempfile.TemporaryDirectory() as tmp:
            module.OUTPUT = Path(tmp) / 'out.json'
            module.convert()
            rows = json.loads(module.OUTPUT.read_text())
        for plmn, kind, match, apn in [
            ('23415', 'gid', 'B3', 'btmobile.bt.com'),
            ('23415', 'spn', "SAINSBURY'S", 'payg.mobilebysainsburys.co.uk'),
            ('26201', 'spn', 'DEBITEL', 'internet.telekom'),
            ('26207', 'spn', 'ALICE', 'internet.partner1'),
            ('23410', 'spn', 'JUMP', 'mobiledata'),
            ('20404', 'spn', 'JUMP', 'mobiledata'),
            ('310260', 'gid', 'DEFF', 'wap.tracfone')]:
            with self.subTest(plmn=plmn, match=match):
                found = [r for r in rows if r['plmn'] == plmn and r['mvno'] == kind
                         and r['match'].upper() == match.upper() and r['apn'] == apn]
                self.assertTrue(found)
                self.assertTrue({'default', '*'} & set(found[0]['types']))
        self.assertFalse(any('wap' in (r['name'] + r['apn']).lower() and r.get('proxy') for r in rows))
        # Check every real WAP-named default profile, including the 21 without
        # an HTTP proxy that the old name-only filter silently discarded.
        wap = [a for a, _ in module.merged_rows()
               if a.get('mvno_type') in {'gid', 'spn'} and a.get('mvno_match_data')
               and a.get('apn') and a.get('carrier_enabled') != 'false'
               and 'default' in a.get('type', '').split(',')
               and 'wap' in (a.get('carrier', '') + a['apn']).lower()]
        self.assertEqual(len(wap), 27)
        self.assertEqual(sum(not a.get('proxy') for a in wap), 21)
        for a in wap:
            found = any(r['plmn'] == a['mcc'] + a['mnc'] and r['apn'] == a['apn']
                        and r['match'] == a['mvno_match_data'] for r in rows)
            self.assertEqual(found, not bool(a.get('proxy')), a)


    def test_manifest_checked_before_import(self):
        for name in ['make-apns.py', 'merge-apns-conf.yaml', 'upstream/apns-conf.xml']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                module = load()
                module.DATA = Path(tmp) / 'sources'
                shutil.copytree(ROOT / 'sources', module.DATA)
                target = module.DATA / 'lineage' / name
                target.write_bytes(target.read_bytes() + b'\n# changed')
                with patch.object(module.importlib.util, 'spec_from_file_location', side_effect=AssertionError('executed unverified code')):
                    with self.assertRaisesRegex(ValueError, 'Hash mismatch'):
                        module.merged_rows()

    def test_strict_rules(self):
        for rules, error in [
            ('excludes: []\nexcludes: []\noverrides: []\n', 'Duplicate rule key'),
            ('excludes: &rules []\noverrides: *rules\n', 'anchors'),
            ('excludes: []\noverrides: [{match: {apn: ctnet}, set: {type: [default, supl]}}]\n', None)]:
            with self.subTest(rules=rules), tempfile.TemporaryDirectory() as tmp:
                module = load()
                module.DATA = Path(tmp) / 'sources'
                shutil.copytree(ROOT / 'sources', module.DATA)
                (module.DATA / 'lineage/merge-apns-conf.yaml').write_text(rules)
                # A single real row makes the list-valued override unambiguous.
                (module.DATA / 'lineage/upstream/apns-conf.xml').write_text(
                    '<apns><apn apn="ctnet" type="default"/></apns>')
                seal(module.DATA)
                if error:
                    with self.assertRaisesRegex(Exception, error):
                        module.merged_rows()
                else:
                    self.assertEqual(module.merged_rows()[0][0]['type'], 'default,supl')

    def test_snapshot_integrity(self):
        rows = json.loads((ROOT / 'carriers.json').read_text())
        self.assertEqual(len(rows), len({json.dumps(r, sort_keys=True) for r in rows}))
        for row in rows:
            self.assertRegex(row['plmn'], r'^\d{5,6}$')
            self.assertIn(row['mvno'], ('gid', 'spn'))
            self.assertTrue(row['match'])
            self.assertEqual(row['match'], row['match'].strip())
            self.assertFalse(any(ord(c) < 32 for c in row['match']))
            if row['mvno'] == 'gid':
                self.assertRegex(row['match'], r'^[0-9A-Fa-f]+$')
            self.assertTrue({'default', '*'} & set(row['types']))
            self.assertEqual(row['usage'], 'data')
    def test_regeneration(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'module'
            shutil.copytree(ROOT, target)
            subprocess.run([sys.executable, '-I', str(target / 'update.py')], check=True)
            for path in ('carriers.json', 'sources/SHA256SUMS'):
                self.assertEqual((ROOT / path).read_bytes(), (target / path).read_bytes())
    def test_external_output_never_rewrites_manifest(self):
        before = (ROOT / 'sources/SHA256SUMS').read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run([sys.executable, '-I', str(ROOT / 'update.py'), '--output', str(Path(tmp) / 'alt.json')], check=True)
        self.assertEqual(before, (ROOT / 'sources/SHA256SUMS').read_bytes())
    def test_invalid_match_fails_loudly(self):
        module = load()
        for kind, value in [('gid', 'XYZ'), ('gid', 'DE FF'), ('spn', 'C Spire\r'), ('spn', ' Leading')]:
            with self.subTest(kind=kind, value=value), self.assertRaises(ValueError):
                module.validate_match(kind, value)
    def test_fetch_member_filter_and_stale_removal(self):
        module = load()
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w:gz') as tar:
            for name in ['root/GB.xml', 'root/upstream/apns-conf.xml',
                         'root/merge-apns-conf.yaml', 'root/make-apns.py',
                         'root/LICENSES/Apache-2.0.txt', 'root/../../escape.xml',
                         'root/nested/ignored.xml']:
                item = tarfile.TarInfo(name)
                item.size = 2
                tar.addfile(item, io.BytesIO(b'ok'))
        payload = archive.getvalue()
        with tempfile.TemporaryDirectory() as tmp:
            module.DATA = Path(tmp)
            lineage = module.DATA / 'lineage'
            lineage.mkdir()
            (lineage / 'stale.xml').write_text('old')
            (module.DATA / 'sources.json').write_text(json.dumps({'downloads': {
                'lineage.tar.gz': {'url': 'https://example.invalid/archive',
                                   'sha256': hashlib.sha256(payload).hexdigest()}}}))
            with patch.object(module.urllib.request, 'urlopen', return_value=io.BytesIO(payload)):
                module.fetch()
            self.assertEqual(sorted(str(p.relative_to(lineage)) for p in lineage.rglob('*') if p.is_file()),
                             ['GB.xml', 'LICENSES/Apache-2.0.txt', 'make-apns.py',
                              'merge-apns-conf.yaml', 'upstream/apns-conf.xml'])
            self.assertFalse((module.DATA / 'escape.xml').exists())

    def test_alternate_source_dir_preserves_manifest(self):
        before = (ROOT / 'sources/SHA256SUMS').read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'sources'
            shutil.copytree(ROOT / 'sources', source)
            copied_manifest = (source / 'SHA256SUMS').read_bytes()
            subprocess.run([sys.executable, '-I', str(ROOT / 'update.py'),
                            '--source-dir', str(source), '--output', str(Path(tmp) / 'out.json')], check=True)
            self.assertEqual(copied_manifest, (source / 'SHA256SUMS').read_bytes())
            self.assertEqual((ROOT / 'carriers.json').read_bytes(), (Path(tmp) / 'out.json').read_bytes())
        self.assertEqual(before, (ROOT / 'sources/SHA256SUMS').read_bytes())

    def test_filters_rules_and_base_before_local(self):
        module = load()
        with tempfile.TemporaryDirectory() as tmp:
            module.ROOT = Path(tmp)
            module.DATA = Path(tmp) / 'sources'
            module.OUTPUT = Path(tmp) / 'carriers.json'
            base = module.DATA / 'lineage/upstream'
            base.mkdir(parents=True)
            shutil.copyfile(ROOT / 'sources/lineage/make-apns.py', base.parent / 'make-apns.py')
            attrs = 'mcc="999" mnc="99" mvno_type="gid" mvno_match_data="AB"'
            xml = [f'<apn {attrs} apn="base" protocol="IP"/>',
                   f'<apn {attrs} apn="excluded"/>',
                   f'<apn {attrs} apn="off" carrier_enabled="false"/>',
                   f'<apn {attrs} apn="cdma" network_type_bitmask="4|5|6|7|12"/>',
                   f'<apn {attrs} apn="mms" type="mms"/>',
                   f'<apn {attrs} apn="wap.net" type="default" proxy="192.0.2.1"/>',
                   '<apn mcc="999" mnc="9" apn="invalid" mvno_type="spn" mvno_match_data="Example"/>',
                   '<apn mcc="999" mnc="99" apn="imsi" mvno_type="imsi" mvno_match_data="99999"/>',
                   '<apn mcc="999" mnc="99" apn="generic"/>']
            (base / 'apns-conf.xml').write_text('<apns>'+''.join(xml)+'</apns>')
            (base.parent / 'ZZ.xml').write_text(f'<apns><apn {attrs} apn="local"/></apns>')
            rules = {'excludes': [{'match': {'apn': 'excluded'}}],
                     'overrides': [{'match': {'apn': 'base'}, 'set': {'protocol': 'IPV4V6'}}]}
            # JSON is a YAML subset, accepted by the pinned upstream loader.
            (base.parent / 'merge-apns-conf.yaml').write_text(json.dumps(rules))
            seal(module.DATA)
            module.convert()
            rows = json.loads(module.OUTPUT.read_text())
            self.assertEqual([r['apn'] for r in rows], ['base', 'local'])
            self.assertEqual(rows[0]['protocol'], 'IPV4V6')
            self.assertEqual([r['origin'] for r in rows], ['lineage-upstream', 'lineage-local'])

    def test_usage_auth_dedupe_and_order(self):
        module = load()
        with tempfile.TemporaryDirectory() as tmp:
            module.ROOT = Path(tmp)
            module.DATA = Path(tmp) / 'sources'
            module.OUTPUT = Path(tmp) / 'carriers.json'
            base = module.DATA / 'lineage/upstream'
            base.mkdir(parents=True)
            row = '<apn mcc="999" mnc="99" apn="net" type="default, ia, dun" mvno_type="gid" mvno_match_data="AB" user="name" password="pass" authtype="3" proxy="192.0.2.1" port="80"/>'
            shutil.copyfile(ROOT / 'sources/lineage/make-apns.py', base.parent / 'make-apns.py')
            (base / 'apns-conf.xml').write_text('<apns>'+row+row+'</apns>')
            (module.DATA / 'lineage/merge-apns-conf.yaml').write_text('excludes: []\noverrides: []\n')
            seal(module.DATA)
            module.convert()
            rows = json.loads(module.OUTPUT.read_text())
            self.assertEqual(len(rows), 1)
            for key, value in dict(user='name', password='pass', authtype='3', proxy='192.0.2.1', port='80').items():
                self.assertEqual(rows[0][key], value)
            self.assertEqual(rows[0]['types'], ['default', 'ia', 'dun'])

if __name__ == '__main__':
    unittest.main()
