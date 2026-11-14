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

class CarrierImportTest(unittest.TestCase):
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
                   f'<apn {attrs} apn="wap.net" type="default"/>',
                   '<apn mcc="999" mnc="9" apn="invalid" mvno_type="spn" mvno_match_data="Example"/>',
                   '<apn mcc="999" mnc="99" apn="imsi" mvno_type="imsi" mvno_match_data="99999"/>',
                   '<apn mcc="999" mnc="99" apn="generic"/>']
            (base / 'apns-conf.xml').write_text('<apns>'+''.join(xml)+'</apns>')
            (base.parent / 'ZZ.xml').write_text(f'<apns><apn {attrs} apn="local"/></apns>')
            rules = {'excludes': [{'match': {'apn': 'excluded'}}],
                     'overrides': [{'match': {'apn': 'base'}, 'set': {'protocol': 'IPV4V6'}}]}
            # JSON is a YAML subset, accepted by the pinned upstream loader.
            (base.parent / 'merge-apns-conf.yaml').write_text(json.dumps(rules))
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
            module.convert()
            rows = json.loads(module.OUTPUT.read_text())
            self.assertEqual(len(rows), 1)
            for key, value in dict(user='name', password='pass', authtype='3', proxy='192.0.2.1', port='80').items():
                self.assertEqual(rows[0][key], value)
            self.assertEqual(rows[0]['types'], ['default', 'ia', 'dun'])

if __name__ == '__main__':
    unittest.main()
