import importlib.util
import pathlib
import unittest
import subprocess
from unittest.mock import patch

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
        self.assertIn('udp dport 443 reject with icmpx port-unreachable', rules)
        self.assertIn('priority -140', rules)

    def test_phone_only_protocol_fallback(self):
        rules = portal.rules(self.config())
        self.assertIn('chain input { type filter hook input priority -10;', rules)
        self.assertIn('set station { type ether_addr; flags timeout;', rules)
        self.assertIn('02:00:00:00:00:02 timeout 600s', rules)
        self.assertIn('iifname "ap0" meta nfproto ipv6 ether saddr @station', rules)
        self.assertIn('tcp dport { 53, 80, 443, 853 } reject with tcp reset', rules)
        self.assertIn('udp dport { 53, 443, 853 } reject with icmpx port-unreachable', rules)
        self.assertIn('ip saddr . ether saddr @phone tcp dport 853 reject with tcp reset', rules)
        self.assertIn('ip daddr @doh4 tcp dport 443 reject with tcp reset', rules)
        for address in ['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9', '149.112.112.112']:
            self.assertIn(address, rules)

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
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][:2], ('nft', '-f'))


class RecoveryTests(unittest.TestCase):
    def test_missing_route_and_repeated_close_converge(self):
        calls = []
        def run(*a, **kw):
            calls.append(a)
            if a[:4] == ('ip', '-4', 'route', 'del') or a[:4] == ('ip', '-4', 'rule', 'del') or a[:3] == ('nft', 'delete', 'table'):
                raise subprocess.CalledProcessError(2, a, stderr='No such file or directory')
            return ''
        with patch.object(portal, 'run', side_effect=run), patch.object(portal, 'clear_flows'):
            portal.close_window(WindowTests().config())
            portal.close_window(WindowTests().config())
        self.assertTrue(any(a[:3] == ('nft', 'delete', 'table') for a in calls))

    def test_sweep_accepts_detached_ingress_flag(self):
        import json
        rule = dict(priority=90, table=16413, fwmark=portal.MARK, iif='ap0', src='10.42.0.2', iif_detached=None)
        calls = []
        def run(*a, **kw):
            calls.append(a)
            return json.dumps([rule]) if a == ('ip', '-j', '-4', 'rule', 'show') else ''
        with patch.object(portal, 'run', side_effect=run), patch.object(portal.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')):
            portal.sweep({})
        self.assertIn(('ip', '-4', 'route', 'flush', 'table', '16413'), calls)

    def test_sweep_refuses_foreign_rules_before_mutation(self):
        import json
        rule = dict(priority=90, table=16413, fwmark='0xca000100', iif='ap0', src='10.42.0.2')
        calls = []
        def run(*a, **kw):
            calls.append(a)
            return json.dumps([rule])
        with patch.object(portal, 'run', side_effect=run):
            with self.assertRaises(ValueError):
                portal.sweep({})
        self.assertEqual(calls, [('ip', '-j', '-4', 'rule', 'show')])

    def test_sweep_rejects_lookalikes_with_extra_selectors(self):
        import json
        base = dict(priority=90, table=16413, fwmark=portal.MARK, iif='ap0', src='10.42.0.2')
        for changes in [dict(src='10.42.0.0/24'), dict(dst='192.0.2.0/24'), dict(ipproto='tcp')]:
            calls = []
            def run(*a, **kw):
                calls.append(a)
                return json.dumps([{**base, **changes}])
            with patch.object(portal, 'run', side_effect=run):
                with self.assertRaises(ValueError):
                    portal.sweep({})
            self.assertEqual(len(calls), 1)

    def test_vanished_device_is_closed_only_when_private_routes_are_absent(self):
        def run(*a, **kw):
            if a[:4] == ('ip', '-4', 'route', 'del'):
                raise subprocess.CalledProcessError(2, a, stderr='Cannot find device "wan1"')
            return ''
        with patch.object(portal, 'run', side_effect=run), patch.object(portal, 'clear_flows'):
            portal.close_window(WindowTests().config())

    def test_real_cleanup_errors_are_not_silenced(self):
        def run(*a, **kw):
            if a[:4] == ('ip', '-4', 'rule', 'del'):
                raise subprocess.CalledProcessError(2, a, stderr='Operation not permitted')
            return ''
        with patch.object(portal, 'run', side_effect=run), patch.object(portal, 'clear_flows'):
            with self.assertRaises(subprocess.CalledProcessError):
                portal.close_window(WindowTests().config())

if __name__ == '__main__':
    unittest.main()
