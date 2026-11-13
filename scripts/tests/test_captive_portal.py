import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('portal', pathlib.Path(__file__).parents[2] / 'deployment/captive-portal-window.py')
portal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portal)

class WindowTests(unittest.TestCase):
    def config(self, **changes):
        return dict(ap='ap0', phone='10.42.0.2', mac='02:00:00:00:00:02', wan='wan1', address='198.51.100.1', gateway='198.51.100.2', dns='198.51.100.2', seconds=600, **changes)

    def test_expiry_is_kernel_enforced(self):
        rules = portal.rules(self.config())
        self.assertIn('timeout 600s', rules)
        self.assertIn('ip saddr . ether saddr @phone', rules)
        self.assertIn('ct mark 0xcb000100 drop', rules)
        self.assertNotIn('hook output', rules)
        self.assertNotIn('flush ruleset', rules)

    def test_only_web_and_dns_and_local_control_exempt(self):
        rules = portal.rules(self.config())
        self.assertIn('tcp dport { 80, 443 }', rules)
        self.assertIn('udp dport 53', rules)
        self.assertIn('fib daddr type local', rules)
        self.assertNotIn('udp dport 443', rules)
        self.assertIn('priority -140', rules)

    def test_rejects_unbounded_and_injection(self):
        for field, value in [('seconds', 601), ('seconds', 0), ('wan', 'wan0; reboot'), ('phone', '::1'), ('mac', 'bad')]:
            config = self.config()
            config[field] = value
            with self.assertRaises(ValueError):
                portal.rules(config)

class CleanupTests(unittest.TestCase):
    def test_cleanup_failure_retains_tombstone(self):
        from unittest.mock import patch
        config = WindowTests().config()
        calls = []
        with patch.object(portal, 'run', side_effect=lambda *a, **k: calls.append(a) or ''), patch.object(portal, 'clear_flows', side_effect=ValueError('failure')):
            with self.assertRaises(ValueError):
                portal.close_window(config)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][:2], ('nft', '-f'))

if __name__ == '__main__':
    unittest.main()
