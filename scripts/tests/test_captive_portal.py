import importlib.util
import pathlib
import re
import unittest
import subprocess
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('portal', pathlib.Path(__file__).parents[2] / 'deployment/captive-portal-window.py')
portal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portal)

class WindowTests(unittest.TestCase):
    def config(self, **changes):
        return dict(ap='ap0', ap_ifindex=7, phone='10.42.0.2', mac='02:00:00:00:00:02', wan='wan1', address='198.51.100.1', gateway='198.51.100.2', dns='198.51.100.2', seconds=600, **changes)

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
        self.assertIn('ip daddr @local4 return', rules)
        self.assertIn('udp dport 443 reject with icmpx port-unreachable', rules)
        self.assertIn('priority -140', rules)

    def test_phone_only_protocol_fallback(self):
        rules = portal.rules(self.config())
        self.assertIn('chain input { type filter hook input priority -10;', rules)
        self.assertIn('set station { type ether_addr; flags timeout;', rules)
        self.assertIn('02:00:00:00:00:02 timeout 600s', rules)
        self.assertIn('meta iif 7 meta nfproto ipv6 ether saddr @station', rules)
        self.assertIn('tcp dport { 53, 80, 443, 853 } reject with tcp reset', rules)
        self.assertIn('udp dport { 53, 443, 853 } reject with icmpx port-unreachable', rules)
        self.assertIn('ip saddr . ether saddr @phone tcp dport 853 reject with tcp reset', rules)
        self.assertIn('ip daddr @doh4 tcp dport 443 reject with tcp reset', rules)
        for address in ['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9', '149.112.112.112']:
            self.assertIn(address, rules)

    def test_rejects_unbounded_and_injection(self):
        for field, value in [('seconds', 601), ('seconds', 0), ('wan', 'wan0; reboot'), ('phone', '::1'), ('mac', 'bad'),
                             ('ap_ifindex', 0), ('ap_ifindex', '7'), ('ap_ifindex', True),
                             ('ap_ifindex', 7.0), ('ap_ifindex', 2 ** 31), ('ap_ifindex', -7)]:
            config = self.config()
            config[field] = value
            with self.assertRaises(ValueError):
                portal.rules(config)

    def test_ingress_is_bound_to_the_pinned_interface_lifetime(self):
        rules = portal.rules(self.config())
        # A name follows a same-name replacement: every ingress match is the
        # pinned numeric ifindex, and the AP name never appears in the table.
        self.assertNotIn('iifname', rules)
        self.assertNotIn('"ap0"', rules)
        self.assertNotIn('ap0', rules)
        self.assertIn('meta iif 7 ip saddr . ether saddr @phone', rules)
        self.assertIn('meta iif 7 meta mark 0xcb000100 oifname "wan1" masquerade', rules)
        iifs = re.findall(r'\biif\s+(\S+)', rules)
        self.assertTrue(iifs)
        self.assertEqual(set(iifs), {'7'})
        self.assertEqual(rules.count('meta iif 7'), len(iifs))
        with self.assertRaises(KeyError):
            portal.rules({k: v for k, v in self.config().items() if k != 'ap_ifindex'})


class IngressLifetimeTests(unittest.TestCase):
    def test_replaced_ap_refuses_before_any_mutation(self):
        calls = []
        with patch.object(portal, 'run', side_effect=lambda *a, **k: calls.append(a) or ''), \
                patch.object(portal, 'ifindex', return_value=8):
            with self.assertRaises(ValueError):
                portal.open_window(WindowTests().config())
        self.assertFalse(any(a[:2] in [('nft', '-f'), ('nft', '--check')] or a[:4] == ('ip', '-4', 'route', 'add')
                             for a in calls))

    def test_vanished_ap_refuses(self):
        with patch.object(portal, 'run', return_value=''), \
                patch.object(portal, 'ifindex', side_effect=FileNotFoundError()):
            with self.assertRaises(ValueError):
                portal.open_window(WindowTests().config())

    def test_replacement_during_open_rolls_back(self):
        closed = []
        with patch.object(portal, 'run', return_value=''), patch.object(portal, 'clear_flows'), \
                patch.object(portal, 'local_addresses', return_value=[]), \
                patch.object(portal, 'ifindex', side_effect=[7, 8]), \
                patch.object(portal, 'close_window', side_effect=closed.append):
            with self.assertRaises(ValueError):
                portal.open_window(WindowTests().config())
        self.assertEqual(len(closed), 1)

    def test_unchanged_ap_opens(self):
        with patch.object(portal, 'run', return_value=''), patch.object(portal, 'clear_flows'), \
                patch.object(portal, 'local_addresses', return_value=[]), \
                patch.object(portal, 'ifindex', return_value=7), \
                patch.object(portal, 'close_window') as close:
            portal.open_window(WindowTests().config())
        close.assert_not_called()


# Every word the helper's ruleset may use. Core nf_tables words need nothing
# beyond NF_TABLES/NF_TABLES_INET; module words need the listed kernel symbols.
# A word in neither list fails the test, so a new expression has to be
# classified here (and checked against the image kernel) before it ships.
CORE_WORDS = {
    'table', 'inet', 'set', 'type', 'flags', 'timeout', 'interval', 'elements',
    'ipv4_addr', 'ether_addr', 'chain', 'hook', 'priority', 'policy', 'filter',
    'nat', 'prerouting', 'input', 'forward', 'postrouting', 'accept', 'drop',
    'return', 'jump', 'meta', 'mark', 'nfproto', 'ipv4', 'ipv6', 'iif', 'iifname',
    'oifname', 'ip', 'saddr', 'daddr', 'ether', 'tcp', 'udp', 'dport', 'sport',
}
MODULE_WORDS = {
    'fib': {'NFT_FIB_INET', 'NFT_FIB_IPV4', 'NFT_FIB_IPV6'},
    'local': {'NFT_FIB_INET', 'NFT_FIB_IPV4', 'NFT_FIB_IPV6'},  # fib ... type local
    'ct': {'NFT_CT', 'NF_CONNTRACK_MARK'},
    'direction': {'NFT_CT'},
    'masquerade': {'NFT_MASQ'},
    'dnat': {'NFT_NAT'},
    'snat': {'NFT_NAT'},
    'to': {'NFT_NAT'},
    'redirect': {'NFT_REDIR'},
    'reject': {'NFT_REJECT', 'NFT_REJECT_INET'},
    'with': {'NFT_REJECT'},
    'icmpx': {'NFT_REJECT_INET'},
    'port-unreachable': {'NFT_REJECT_INET'},
    'reset': {'NFT_REJECT'},
    'limit': {'NFT_LIMIT'},
    'numgen': {'NFT_NUMGEN'},
    'quota': {'NFT_QUOTA'},
    'log': {'NFT_LOG'},
    'queue': {'NFT_QUEUE'},
    'jhash': {'NFT_HASH'},
    'symhash': {'NFT_HASH'},
    'socket': {'NFT_SOCKET'},
    'tproxy': {'NFT_TPROXY'},
    'osf': {'NFT_OSF'},
    'synproxy': {'NFT_SYNPROXY'},
    'count': {'NFT_CONNLIMIT'},
    'flow': {'NFT_FLOW_OFFLOAD'},
    'dup': {'NFT_DUP_IPV4'},
    'fwd': {'NFT_FWD_NETDEV'},
    'ipsec': {'NFT_XFRM'},
}
# What CeraLive images guarantee for nftables consumers (the image's required
# kernel symbol list). The sign-in helper must stay inside it.
IMAGE_NFT_SYMBOLS = {'NFT_CT', 'NF_CONNTRACK_MARK', 'NFT_NAT', 'NFT_MASQ',
                     'NFT_REJECT', 'NFT_REJECT_INET'}


def ruleset_words(ruleset):
    import re
    text = re.sub(r'"[^"]*"', ' ', ruleset)
    names = set(re.findall(r'\b(?:table inet|set|chain)\s+([A-Za-z0-9_]+)', text))
    names |= set(re.findall(r'@([A-Za-z0-9_]+)', text))
    text = re.sub(r'@[A-Za-z0-9_]+', ' ', text)
    text = re.sub(r'\b0x[0-9a-fA-F]+\b', ' ', text)
    text = re.sub(r'\b(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b', ' ', text)
    text = re.sub(r'\b\d+(?:\.\d+){3}(?:/\d+)?\b', ' ', text)
    text = re.sub(r'-?\b\d+[smhd]?\b', ' ', text)
    return set(re.findall(r'[A-Za-z][A-Za-z0-9_-]*', text)) - names


def required_symbols(ruleset):
    words = ruleset_words(ruleset)
    unknown = words - CORE_WORDS - set(MODULE_WORDS)
    if unknown:
        raise AssertionError(f'unclassified nft words: {sorted(unknown)}')
    needed = set()
    for word in words & set(MODULE_WORDS):
        needed |= MODULE_WORDS[word]
    return needed


class KernelFeatureTests(unittest.TestCase):
    def ruleset(self):
        return portal.rules(WindowTests().config(), ['10.42.0.1', '198.51.100.1'])

    def test_ruleset_needs_only_what_images_guarantee(self):
        needed = required_symbols(self.ruleset())
        self.assertEqual(needed - IMAGE_NFT_SYMBOLS, set())
        self.assertIn('NFT_CT', needed)
        self.assertIn('NFT_MASQ', needed)

    def test_a_fib_rule_would_be_caught(self):
        # The image kernel has no nft fib; the earlier rule failed to load there.
        self.assertTrue(required_symbols('fib daddr type local return') - IMAGE_NFT_SYMBOLS)

    def test_an_unclassified_expression_fails(self):
        with self.assertRaises(AssertionError):
            required_symbols(self.ruleset() + ' meta cpu 1 counter accept')

    def test_hex_marks_addresses_and_names_are_not_words(self):
        self.assertEqual(ruleset_words('table inet t { set s1 { elements = { 0xcb000100, 10.0.0.0/8, aa:bb:cc:dd:ee:ff } } }'),
                         {'table', 'inet', 'set', 'elements'})

    def test_ruleset_against_a_real_kernel_config(self):
        import os
        path = os.environ.get('CERALIVE_KERNEL_CONFIG')
        if not path:
            self.skipTest('set CERALIVE_KERNEL_CONFIG to a resolved kernel .config')
        enabled = set()
        for line in pathlib.Path(path).read_text().splitlines():
            if line.startswith('CONFIG_') and line.rstrip().endswith(('=y', '=m')):
                enabled.add(line.split('=', 1)[0][len('CONFIG_'):])
        self.assertEqual(required_symbols(self.ruleset()) - enabled, set())


class LocalExemptionTests(unittest.TestCase):
    def test_box_addresses_are_exempt_and_loopback_is_one_range(self):
        listing = json_dump([
            {'ifname': 'lo', 'addr_info': [{'family': 'inet', 'local': '127.0.0.1'}]},
            {'ifname': 'ap0', 'addr_info': [{'family': 'inet', 'local': '10.42.0.1'}]},
            {'ifname': 'wan1', 'addr_info': [{'family': 'inet', 'local': '198.51.100.1'},
                                             {'family': 'inet6', 'local': 'fe80::1'}]},
        ])
        with patch.object(portal, 'run', return_value=listing):
            local = portal.local_addresses()
        self.assertEqual([str(a) for a in local], ['10.42.0.1', '198.51.100.1'])
        rules = portal.rules(WindowTests().config(), local)
        self.assertIn('set local4 { type ipv4_addr; flags interval; elements = { 127.0.0.0/8, 10.42.0.1, 198.51.100.1 }; }', rules)
        # The exemption comes before web traffic is selected.
        self.assertLess(rules.index('ip daddr @local4 return'), rules.index('tcp dport { 80, 443 } jump selected'))

    def test_open_checks_and_loads_the_ruleset_with_current_addresses(self):
        config = WindowTests().config()
        loaded = []
        def run(*args, data=None, check=True):
            if args[:3] == ('ip', '-j', '-4'):
                return json_dump([{'ifname': 'ap0', 'addr_info': [{'family': 'inet', 'local': '10.42.0.1'}]}])
            if data and 'table inet ceralive_portal {' in data and 'chain pre' in data:
                loaded.append(data)
            return ''
        with patch.object(portal, 'run', side_effect=run), patch.object(portal, 'clear_flows'), \
                patch.object(portal, 'ifindex', return_value=config['ap_ifindex']):
            portal.open_window(config)
        self.assertEqual(len(loaded), 2)
        for data in loaded:
            self.assertIn('elements = { 127.0.0.0/8, 10.42.0.1 }', data)
            self.assertNotIn('fib', data)


def json_dump(value):
    import json
    return json.dumps(value)


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
