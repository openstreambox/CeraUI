#!/usr/bin/env python3
"""Bounded IPv4 web/DNS forwarding. Owns only its private table and rule."""
import ipaddress
import json
import re
import subprocess
import sys

TABLE = 'ceralive_portal'
MARK = '0xcb000100'
ROUTE_TABLE = '16413'
PRIORITY = '90'


def run(*args, data=None, check=True):
    return subprocess.run(args, input=data, text=True, capture_output=True,
                          timeout=5, check=check).stdout


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
    return f'''table inet {TABLE} {{
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
 chain forward {{ type filter hook forward priority -10; policy accept;
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
                                    text=True, capture_output=True, timeout=5)
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
    added_route = added_rule = False
    try:
        run('ip', '-4', 'route', 'add', 'table', ROUTE_TABLE, 'default',
            'via', c['gateway'], 'dev', c['wan'], 'onlink')
        added_route = True
        run('ip', '-4', 'rule', 'add', 'priority', PRIORITY, 'iif', c['ap'],
            'from', c['phone'], 'fwmark', MARK, 'lookup', ROUTE_TABLE)
        added_rule = True
        clear_flows(c)
        run('nft', '-f', '-', data=rules(c))
    except Exception:
        if added_rule:
            run('ip', '-4', 'rule', 'del', 'priority', PRIORITY, 'iif', c['ap'],
                'from', c['phone'], 'fwmark', MARK, 'lookup', ROUTE_TABLE)
        if added_route:
            run('ip', '-4', 'route', 'del', 'table', ROUTE_TABLE, 'default',
                'via', c['gateway'], 'dev', c['wan'])
        raise


def close_window(c):
    validate(c)
    # Keep the tombstone until the exact conntracks are gone.
    run('nft', '-f', '-', data=f'flush set inet {TABLE} phone\nflush set inet {TABLE} reply\n')
    clear_flows(c)
    run('ip', '-4', 'rule', 'del', 'priority', PRIORITY, 'iif', c['ap'],
        'from', c['phone'], 'fwmark', MARK, 'lookup', ROUTE_TABLE)
    run('ip', '-4', 'route', 'del', 'table', ROUTE_TABLE, 'default',
        'via', c['gateway'], 'dev', c['wan'])
    run('nft', 'delete', 'table', 'inet', TABLE)


if __name__ == '__main__':
    try:
        config = json.loads(sys.stdin.read(4097))
        {'open': open_window, 'close': close_window}[sys.argv[1]](config)
        print('{}')
    except Exception:
        print('window unavailable', file=sys.stderr)
        sys.exit(1)
