"""Regression tests for the offline carrier importer."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('converter', Path(__file__).with_name('update.py'))
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)

class CarrierImportTest(unittest.TestCase):
    def test_internet_filter_protocols_and_fallback_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            converter.DATA = root / 'data'
            converter.DATA.mkdir()
            (converter.DATA / 'lineage').mkdir()
            converter.ROOT = root
            converter.OUTPUT = root / 'carriers.json'
            (converter.DATA / 'apns-full-conf.xml').write_text('''<apns>
            <apn mcc="999" mnc="99" apn="ims" type="ims" protocol="IPV6"/>
            <apn mcc="999" mnc="99" apn="old" type="default" network_type_bitmask="4|5|6|7|12"/>
            <apn mcc="999" mnc="99" apn="off" type="default" carrier_enabled="false"/>
            <apn mcc="999" mnc="99" apn="net" type="default" protocol="IPV6" roaming_protocol="IP" mvno_type="gid" mvno_match_data="AB"/>
            <apn mcc="620" mnc="0" apn="bad" type="default"/>
            <apn mcc="999" mnc="99" apn="imsi" type="default" mvno_type="IMSI" mvno_match_data="99999"/>
            <apn mcc="999" mnc="99" apn="spn" type="default" mvno_type="SPN" mvno_match_data="Example"/>
            <apn mcc="999" mnc="99" apn="generic" type="default"/>
            </apns>''')
            (converter.DATA / 'serviceproviders.xml').write_text('''<serviceproviders><provider><name>Example</name><gsm><network-id mcc="999" mnc="99"/><apn value="backup"><usage type="internet"/></apn><apn value="mms"><usage type="mms"/></apn></gsm></provider></serviceproviders>''')
            converter.convert()
            rows = json.loads(converter.OUTPUT.read_text())
            self.assertEqual([r['apn'] for r in rows], ['net', 'spn'])
            self.assertEqual(rows[0]['match'], 'AB')
            self.assertEqual(rows[1]['mvno'], 'spn')
            self.assertEqual(rows[0]['protocol'], 'IPV6')
            self.assertEqual(rows[0]['roamingProtocol'], 'IP')
            original = converter.OUTPUT.read_bytes()
            converter.convert()
            self.assertEqual(converter.OUTPUT.read_bytes(), original)

if __name__ == '__main__':
    unittest.main()
