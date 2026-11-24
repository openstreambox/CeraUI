#!/usr/bin/env python3
"""Bounded IPv4 web/DNS forwarding with phone-only protocol fallback. Owns only its private table and rule."""
import ipaddress
import os
import json
import re
import subprocess
import sys
import signal

TABLE = 'ceralive_portal'
MARK = '0xcb000100'
ROUTE_TABLE = '16413'
PRIORITY = '90'
COMMAND_ENV = {**os.environ, 'LC_ALL': 'C.UTF-8'}


def run(*args, data=None, check=True):
    return subprocess.run(args, input=data, text=True, capture_output=True,
                          timeout=5, check=check, env=COMMAND_ENV).stdout


def validate(c):
    for key in ('ap', 'wan'):
        if not re.fullmatch(r'[a-zA-Z0-9_.][a-zA-Z0-9_.-]{0,14}', c[key]):
            raise ValueError('invalid interface')
    if c['ap'] == c['wan']:
        raise ValueError('separate AP required')
    for key in ('phone', 'address', 'gateway', 'dns'):
        ipaddress.IPv4Address(c[key])
    if not re.fullmatch(r'(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}', c['mac']):
        raise ValueError('invalid station')
    if not isinstance(c['seconds'], int) or not 1 <= c['seconds'] <= 600:
        raise ValueError('invalid duration')


def rules(c):
    validate(c)
    ap, wan, phone, mac, dns, seconds = (c[k] for k in ('ap', 'wan', 'phone', 'mac', 'dns', 'seconds'))
    # After sharing's mangle hook: override ONLY the selected web/DNS packets.
    # A separate timed set gates replies too; expired conntracks are dropped,
    # never restored onto a healthy link with the hotel's old NAT identity.
    match = f'iifname "{ap}" ip saddr . ether saddr @phone'
    v6 = f'iifname "{ap}" meta nfproto ipv6 ether saddr @station'
    return f'''table inet {TABLE} {{
 set station {{ type ether_addr; flags timeout; elements = {{ {mac} timeout {seconds}s }}; }}
 set doh4 {{ type ipv4_addr; elements = {{ 1.1.1.1, 1.0.0.1, 8.8.8.8, 8.8.4.4, 9.9.9.9, 149.112.112.112 }}; }}
 set phone {{ type ipv4_addr . ether_addr; flags timeout; elements = {{ {phone} . {mac} timeout {seconds}s }}; }}
 set reply {{ type ipv4_addr; flags timeout; elements = {{ {phone} timeout {seconds}s }}; }}
 chain selected {{ meta mark set {MARK}; ct mark set {MARK}; return; }}
 chain pre {{ type filter hook prerouting priority -140; policy accept;
  {match} udp dport 53 jump selected
  {match} tcp dport 53 jump selected
  ct direction reply return
  fib daddr type local return
  {match} tcp dport {{ 80, 443 }} jump selected
  ct mark {MARK} meta mark != {MARK} drop
 }}
 chain dns {{ type nat hook prerouting priority -110; policy accept;
  meta mark {MARK} udp dport 53 dnat ip to {dns}
  meta mark {MARK} tcp dport 53 dnat ip to {dns}
 }}
 chain input {{ type filter hook input priority -10; policy accept;
  {v6} tcp dport {{ 53, 853 }} reject with tcp reset
  {v6} udp dport {{ 53, 853 }} reject with icmpx port-unreachable
 }}
 chain forward {{ type filter hook forward priority -10; policy accept;
  {v6} tcp dport {{ 53, 80, 443, 853 }} reject with tcp reset
  {v6} udp dport {{ 53, 443, 853 }} reject with icmpx port-unreachable
  {match} udp dport 443 reject with icmpx port-unreachable
  {match} tcp dport 853 reject with tcp reset
  {match} udp dport 853 reject with icmpx port-unreachable
  {match} ip daddr @doh4 tcp dport 443 reject with tcp reset
  ct mark {MARK} ip daddr @reply accept
  ct mark {MARK} meta mark {MARK} oifname "{wan}" accept
  ct mark {MARK} drop
 }}
 chain nat {{ type nat hook postrouting priority 90; policy accept;
  iifname "{ap}" meta mark {MARK} oifname "{wan}" masquerade
 }}
}}\n'''


def clear_flows(c):
    # Exact source and ports; UDP streaming and every other phone survive.
    for proto, ports in [('tcp', [80, 443, 53]), ('udp', [53])]:
        for port in ports:
            result = subprocess.run(['conntrack', '-D', '-f', 'ipv4', '-s', c['phone'],
                                     '-p', proto, '--dport', str(port), '--src-nat'],
                                    text=True, capture_output=True, timeout=5, env=COMMAND_ENV)
            if result.returncode and '0 flow entries have been deleted' not in result.stderr:
                raise ValueError('connection cleanup unavailable')


def open_window(c):
    validate(c)
    if run('nft', 'list', 'table', 'inet', TABLE, check=False):
        raise ValueError('window cleanup required')
    if run('ip', '-4', 'route', 'show', 'table', ROUTE_TABLE, check=False):
        raise ValueError('route table occupied')
    if any(line.startswith(PRIORITY + ':') for line in run('ip', '-4', 'rule', 'show').splitlines()):
        raise ValueError('rule priority occupied')
    run('nft', '--check', '-f', '-', data=rules(c))
    try:
        # Publish ownership before the first route write. Even a hard stop between
        # route and rule installation then leaves enough evidence for startup.
        run('nft', '-f', '-', data=f'table inet {TABLE} {{ set phone {{ type ipv4_addr . ether_addr; flags timeout; }}; set reply {{ type ipv4_addr; flags timeout; }}; }}\n')
        run('ip', '-4', 'route', 'add', 'table', ROUTE_TABLE, 'default',
            'via', c['gateway'], 'dev', c['wan'], 'onlink')
        run('ip', '-4', 'rule', 'add', 'priority', PRIORITY, 'iif', c['ap'],
            'from', c['phone'], 'fwmark', MARK, 'lookup', ROUTE_TABLE)
        clear_flows(c)
        run('nft', '-f', '-', data=f'delete table inet {TABLE}\n' + rules(c))
    except BaseException:
        close_window(c)
        raise


def absent_ok(*args, **kwargs):
    """Only a kernel 'already absent' result is success; permission/I/O errors retry."""
    try:
        return run(*args, **kwargs)
    except subprocess.CalledProcessError as error:
        if (args[:4] == ('ip', '-4', 'route', 'del') and
                'Cannot find device' in (error.stderr or '') and
                not absent_ok('ip', '-4', 'route', 'show', 'table', ROUTE_TABLE)):
            return ''
        if not any(text in (error.stderr or '') for text in
                   ('No such file or directory', 'No such process', 'does not exist')):
            raise
        return ''


def close_window(c):
    validate(c)
    # Keep the tombstone until the exact conntracks are gone.
    absent_ok('nft', '-f', '-', data=f'flush set inet {TABLE} phone\nflush set inet {TABLE} reply\n')
    absent_ok('nft', 'flush', 'set', 'inet', TABLE, 'station')
    clear_flows(c)
    absent_ok('ip', '-4', 'rule', 'del', 'priority', PRIORITY, 'iif', c['ap'],
              'from', c['phone'], 'fwmark', MARK, 'lookup', ROUTE_TABLE)
    absent_ok('ip', '-4', 'route', 'del', 'table', ROUTE_TABLE, 'default',
              'via', c['gateway'], 'dev', c['wan'])
    absent_ok('nft', 'delete', 'table', 'inet', TABLE)


def sweep(_config):
    """Recover only our reserved mark/table; never remove a foreign rule."""
    rules_now = json.loads(run('ip', '-j', '-4', 'rule', 'show'))
    owned = []
    for rule in rules_now:
        if str(rule.get('table')) != ROUTE_TABLE:
            continue
        if (rule.get('priority') != int(PRIORITY) or
                int(str(rule.get('fwmark', '0')), 0) != int(MARK, 0) or
                rule.get('fwmask', '0xffffffff') not in ('0xffffffff', 4294967295) or
                not rule.get('iif') or rule.get('src') == 'all'):
            raise ValueError('foreign route owner')
        if (ipaddress.IPv4Network(rule['src'], strict=False).prefixlen != 32 or
                set(rule) - {'priority', 'src', 'fwmark', 'fwmask', 'iif', 'iif_detached', 'table', 'protocol'}):
            raise ValueError('foreign rule selectors')
        if not re.fullmatch(r'[a-zA-Z0-9_.][a-zA-Z0-9_.-]{0,14}', rule['iif']):
            raise ValueError('invalid ingress')
        owned.append(rule)
    table = absent_ok('nft', 'list', 'table', 'inet', TABLE)
    routes = run('ip', '-4', 'route', 'show', 'table', ROUTE_TABLE, check=False)
    if routes and not (owned or table):
        raise ValueError('route table occupied')
    if table:
        run('nft', '-f', '-', data=f'flush set inet {TABLE} phone\nflush set inet {TABLE} reply\n')
    absent_ok('nft', 'flush', 'set', 'inet', TABLE, 'station')
    # Mark-scoped retirement works even after sets expire or an interface vanished.
    result = subprocess.run(['conntrack', '-D', '-f', 'ipv4', '--mark', MARK],
                            text=True, capture_output=True, timeout=5, env=COMMAND_ENV)
    if result.returncode and '0 flow entries have been deleted' not in result.stderr:
        raise ValueError('connection cleanup unavailable')
    for rule in owned:
        absent_ok('ip', '-4', 'rule', 'del', 'priority', PRIORITY, 'iif', rule['iif'],
                  'from', rule['src'], 'fwmark', MARK, 'lookup', ROUTE_TABLE)
    if owned or table:
        run('ip', '-4', 'route', 'flush', 'table', ROUTE_TABLE)
    absent_ok('nft', 'delete', 'table', 'inet', TABLE)


def interrupted(_signum, _frame):
    # Raising runs open's rollback. Ignore a second TERM during that rollback.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    # InterruptedError is swallowed as EINTR by subprocess.wait on some Python versions.
    raise RuntimeError('window interrupted')


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    try:
        config = json.loads(sys.stdin.read(4097))
        {'open': open_window, 'close': close_window, 'sweep': sweep}[sys.argv[1]](config)
        print('{}')
    except Exception:
        print('window unavailable', file=sys.stderr)
        sys.exit(1)
