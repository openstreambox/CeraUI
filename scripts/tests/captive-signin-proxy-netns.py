#!/usr/bin/env python3
"""Sign-in proxy prototype in disposable network namespaces.

Root only, inside a private network (and PID) namespace; no host network I/O.

    sudo -n unshare --net --pid --fork --mount-proc \\
        python3 -I scripts/tests/captive-signin-proxy-netns.py <proxy-binary>

The test's own namespace is the box. Peers:
  phone  10.42.0.2 (+ .3 as a second device) on the box's access point ap0
  sim    192.0.2.2 on wan0, the box's default route; carries the stream's UDP
  hotel  198.51.100.2 on wan1, reachable only through its source-route table;
         a captive portal: HTTP 302 to its login page, login POST, then open
Both uplinks hold 203.0.113.10 ("the internet"), so every answer names the
uplink it came through. Only the sim peer holds 203.0.113.20.
"""
import base64
import hashlib
import json
import os
import pathlib
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid

assert os.geteuid() == 0, 'root required'
# A fresh network namespace holds only loopback; the host never does here.
assert [l['ifname'] for l in json.loads(subprocess.check_output(['ip', '-j', 'link', 'show']))] == ['lo'], 'private network namespace required'
PROXY = sys.argv[1]
children = []
results = []
failures = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail and not ok else ''), flush=True)
    if not ok:
        failures.append(name)


def run(*args, data=None, timeout=10):
    return subprocess.run(args, input=data, text=True, capture_output=True, timeout=timeout, check=True).stdout


def ns(pid, *args, timeout=10, check_rc=True):
    p = subprocess.run(['nsenter', '-t', str(pid), '-n', *args], text=True, capture_output=True, timeout=timeout)
    if check_rc and p.returncode != 0:
        raise RuntimeError(f'{args}: {p.returncode} {p.stderr}')
    return p


def peer(name, subnet):
    proc = subprocess.Popen(['unshare', '-n', 'sh', '-c', 'echo ready; exec sleep 600'], stdout=subprocess.PIPE)
    children.append(proc)
    assert proc.stdout.readline() == b'ready\n'
    pid = proc.pid
    run('ip', 'link', 'add', name, 'type', 'veth', 'peer', 'name', name + 'p')
    run('ip', 'link', 'set', name + 'p', 'netns', str(pid))
    run('ip', 'addr', 'add', subnet + '.1/24', 'dev', name)
    run('ip', 'link', 'set', name, 'up')
    ns(pid, 'ip', 'link', 'set', 'lo', 'up')
    ns(pid, 'ip', 'addr', 'add', subnet + '.2/24', 'dev', name + 'p')
    ns(pid, 'ip', 'link', 'set', name + 'p', 'up')
    ns(pid, 'ip', 'route', 'add', 'default', 'via', subnet + '.1')
    return pid


def background(pid, code, *args):
    cmd = ['python3', '-I', '-c', code, *args]
    if pid:
        cmd = ['nsenter', '-t', str(pid), '-n'] + cmd
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True)
    children.append(proc)
    assert proc.stdout.readline().strip() == 'ready', 'server failed to start'
    return proc


# Uplink servers. Each logs one JSON line per event to stdout after "ready".
SIM = r'''
import socket, threading, json, sys, time
LOG = sys.argv[1]
def log(**k):
    with open(LOG, 'a') as f: f.write(json.dumps(k) + '\n')
def tcp(addr, port):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind((addr, port)); s.listen()
    while True:
        c, a = s.accept(); log(ev='tcp', port=port, dst=addr, src=a[0])
        try: c.recv(4096); c.sendall(b'HTTP/1.0 200 OK\r\nContent-Length: 7\r\n\r\nvia-sim')
        except OSError: pass
        c.close()
def udp_echo():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(('203.0.113.10', 5000))
    while True:
        d, a = s.recvfrom(2048); s.sendto(b'sim:' + d, a)
def dns():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(('0.0.0.0', 53))
    while True:
        d, a = s.recvfrom(2048); log(ev='dns', src=a[0])
for addr in ['203.0.113.10', '203.0.113.20']:
    for port in [80, 443]:
        threading.Thread(target=tcp, args=(addr, port), daemon=True).start()
threading.Thread(target=udp_echo, daemon=True).start()
threading.Thread(target=dns, daemon=True).start()
print('ready', flush=True); time.sleep(600)
'''

HOTEL = r'''
import socket, ssl, threading, json, sys, time, struct, urllib.parse
cert, key, LOG = sys.argv[1], sys.argv[2], sys.argv[3]
state = {'authed': False}
def log(**k):
    with open(LOG, 'a') as f: f.write(json.dumps(k) + '\n')
NAMES = {'internet.test': '203.0.113.10', 'portal.hotel.test': '198.51.100.2', 'sim-only.test': '203.0.113.20'}
def dns():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(('198.51.100.2', 53))
    while True:
        q, a = s.recvfrom(2048)
        i, labels = 12, []
        while q[i]:
            labels.append(q[i+1:i+1+q[i]].decode()); i += 1 + q[i]
        name = '.'.join(labels).lower(); qtype = struct.unpack('>H', q[i+1:i+3])[0]
        question = q[12:i+5]
        log(ev='dns', src=a[0], name=name)
        ip = NAMES.get(name)
        if ip and qtype == 1:
            ans = b'\xc0\x0c' + struct.pack('>HHIH', 1, 1, 30, 4) + socket.inet_aton(ip)
            s.sendto(q[:2] + b'\x81\x80' + struct.pack('>HHHH', 1, 1, 0, 0) + question + ans, a)
        else:
            s.sendto(q[:2] + b'\x81\x83' + struct.pack('>HHHH', 1, 0, 0, 0) + question, a)
def read_request(c):
    data = b''
    while b'\r\n\r\n' not in data:
        chunk = c.recv(4096)
        if not chunk: break
        data += chunk
    head, _, body = data.partition(b'\r\n\r\n')
    lines = head.decode('latin-1').split('\r\n')
    headers = {k.strip().lower(): v.strip() for k, v in (l.split(':', 1) for l in lines[1:] if ':' in l)}
    n = int(headers.get('content-length', '0'))
    while len(body) < n:
        chunk = c.recv(4096)
        if not chunk: break
        body += chunk
    method, target, _ = lines[0].split(' ', 2)
    return method, target, headers, body
def reply(c, status, body=b'', extra=''):
    c.sendall(f'HTTP/1.1 {status}\r\n{extra}Content-Length: {len(body)}\r\nConnection: close\r\n\r\n'.encode() + body)
def http(addr):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind((addr, 80)); s.listen()
    while True:
        c, a = s.accept()
        try:
            method, target, headers, body = read_request(c)
            log(ev='http', dst=addr, src=a[0], method=method, origin_form=target.startswith('/'),
                proxy_auth='proxy-authorization' in headers, host=headers.get('host', ''))
            if addr == '198.51.100.2':
                if method == 'GET' and target.startswith('/login'):
                    reply(c, '200 OK', b'<form method=post action=/login><input name=room><input name=surname><input name=card></form>')
                elif method == 'POST' and target == '/login':
                    form = urllib.parse.parse_qs(body.decode())
                    ok = form.get('room') == ['4711'] and form.get('surname') == ['Doe'] and form.get('card') == ['4111111111111111']
                    log(ev='login', src=a[0], form_intact=ok)
                    if ok and a[0] == '198.51.100.1':
                        state['authed'] = True
                    reply(c, '302 Found', extra='Location: http://internet.test/\r\nSet-Cookie: portal=cookie-secret-77\r\n')
                else:
                    reply(c, '404 Not Found')
            elif not state['authed']:
                reply(c, '302 Found', extra='Location: http://portal.hotel.test/login?client_mac=02:aa&sig=QUERYSECRET42\r\n')
            else:
                reply(c, '200 OK', b'internet-via-hotel')
        except Exception as e:
            log(ev='http_error', err=type(e).__name__)
        finally:
            c.close()
def https():
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert, key)
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('203.0.113.10', 443)); s.listen()
    while True:
        c, a = s.accept()
        log(ev='tls_accept', src=a[0], authed=state['authed'])
        if not state['authed']:
            c.close(); continue
        def serve(c):
            try:
                t = ctx.wrap_socket(c, server_side=True)
                t.settimeout(10)
                data = t.recv(4096)
                if data.startswith(b'HOLD'):
                    t.sendall(b'held\n')
                    while t.recv(4096): pass
                else:
                    t.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 22\r\nConnection: close\r\n\r\ninternet-via-hotel-tls')
                t.close()
            except Exception as e:
                log(ev='tls_error', err=type(e).__name__)
        threading.Thread(target=serve, args=(c,), daemon=True).start()
threading.Thread(target=dns, daemon=True).start()
for addr in ['198.51.100.2', '203.0.113.10']:
    threading.Thread(target=http, args=(addr,), daemon=True).start()
threading.Thread(target=https, daemon=True).start()
print('ready', flush=True); time.sleep(600)
'''

# The stream: a source-bound UDP flow from the box's SIM address, as SRTLA uses.
FLOW = r'''
import socket, sys, time, json
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(('192.0.2.1', 0)); s.settimeout(0.5)
stop = sys.argv[1]
print('ready', flush=True)
sent = got = 0; labels = set()
import os
while not os.path.exists(stop):
    s.sendto(str(sent).encode(), ('203.0.113.10', 5000)); sent += 1
    try:
        d, a = s.recvfrom(2048); got += 1; labels.add(d.split(b':')[0].decode())
    except socket.timeout:
        pass
    time.sleep(0.02)
print(json.dumps({'sent': sent, 'got': got, 'labels': sorted(labels)}), flush=True)
'''

# Holds one CONNECT tunnel with real TLS, reports how long it stayed open.
HOLD = r'''
import socket, ssl, sys, time, base64
proxy, tok, ca = sys.argv[1], sys.argv[2], sys.argv[3]
c = socket.create_connection((proxy, 8413), timeout=30)
auth = base64.b64encode(b'signin:' + tok.encode()).decode()
c.sendall(f'CONNECT internet.test:443 HTTP/1.1\r\nHost: internet.test:443\r\nProxy-Authorization: Basic {auth}\r\n\r\n'.encode())
head = b''
while b'\r\n\r\n' not in head:
    head += c.recv(1)
assert head.startswith(b'HTTP/1.1 200'), head
ctx = ssl.create_default_context(cafile=ca)
t = ctx.wrap_socket(c, server_hostname='internet.test')
t.sendall(b'HOLD')
assert t.recv(5) == b'held\n'
print('ready', flush=True)
began = time.monotonic()
try:
    while t.recv(4096): pass
except (OSError, ssl.SSLError):
    pass
print(f'closed_after={time.monotonic() - began:.2f}', flush=True)
'''


def snapshot():
    return run('ip', '-4', 'route', 'show', 'table', 'all') + run('ip', '-4', 'rule', 'show')


def curl(phone, *args, timeout=15):
    """Exit code, body, status and stderr. A refused CONNECT reports the proxy's status."""
    p = ns(phone, 'curl', '-sS', '--max-time', '8', '-o', '/dev/stdout', '-w', '\n%{http_code} %{http_connect}', *args, timeout=timeout, check_rc=False)
    body, _, codes = p.stdout.rpartition('\n')
    code, _, connect = codes.partition(' ')
    if code == '000' and connect not in ('', '000', '200'):
        code = connect
    return p.returncode, body, code, p.stderr


def link(pid, dev):
    out = ns(pid, 'ip', '-j', 'link', 'show', dev).stdout if pid else run('ip', '-j', 'link', 'show', dev)
    return json.loads(out)[0]


def write_grant(path, role='owner', ttl=90, tok=None, session='session-1', client=None):
    tok = tok or secrets.token_urlsafe(24)
    grant = {
        'version': 1, 'session_id': session, 'role': role,
        'token_sha256': hashlib.sha256(tok.encode()).hexdigest(),
        'not_after': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + ttl)),
        'ports': [80, 443, 8080, 8443],
        **({'client': client} if client else {}),
        'binding': {
            'device_id': 1, 'if_name': 'wan1', 'if_index': link(0, 'wan1')['ifindex'],
            'physical_path': '/sys/devices/virtual/net/wan1', 'permanent_mac': WAN1_MAC, 'station_mac': WAN1_MAC,
            'bssid': HOTEL_MAC, 'bus_id': '0123456789abcdef0123456789abcdef', 'nm_owner': ':1.42',
            'activation_path': '/org/freedesktop/NetworkManager/ActiveConnection/7', 'profile_uuid': str(uuid.uuid4()),
            'source': '198.51.100.1', 'gateway': '198.51.100.2', 'dns': ['198.51.100.2'],
            'prefix_length': 24, 'route_table': 101, 'route_metric': 600,
        },
    }
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(grant, f)
    os.chmod(path, 0o600)
    return tok


def start_proxy(grant, log_path):
    log = open(log_path, 'w')
    proc = subprocess.Popen([PROXY, '-listen', '10.42.0.1:8413', '-grant', grant], stderr=log, stdout=subprocess.DEVNULL)
    children.append(proc)
    for _ in range(50):
        if proc.poll() is not None:
            break
        if 'result=listening' in pathlib.Path(log_path).read_text():
            break
        time.sleep(0.05)
    return proc


def events(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line]


tmp = pathlib.Path(tempfile.mkdtemp(prefix='signin-proxy-'))
os.chmod(tmp, 0o700)
try:
    run('ip', 'link', 'set', 'lo', 'up')
    phone = peer('ap0', '10.42.0')
    sim = peer('wan0', '192.0.2')
    hotel = peer('wan1', '198.51.100')
    ns(phone, 'ip', 'addr', 'add', '10.42.0.3/24', 'dev', 'ap0p')
    ns(sim, 'ip', 'addr', 'add', '203.0.113.10/32', 'dev', 'lo')
    ns(sim, 'ip', 'addr', 'add', '203.0.113.20/32', 'dev', 'lo')
    ns(hotel, 'ip', 'addr', 'add', '203.0.113.10/32', 'dev', 'lo')
    # The box: default route on the SIM; each uplink has its source-route table.
    run('ip', 'route', 'add', 'default', 'via', '192.0.2.2', 'dev', 'wan0')
    for table, src, gw, dev in [(100, '192.0.2.1', '192.0.2.2', 'wan0'), (101, '198.51.100.1', '198.51.100.2', 'wan1')]:
        run('ip', 'route', 'add', 'table', str(table), 'default', 'via', gw, 'dev', dev)
        run('ip', 'rule', 'add', 'priority', '100', 'from', src, 'table', str(table))
    # The box does not forward between uplinks here, so the hotel can't reach the SIM.
    run('sysctl', '-qw', 'net.ipv4.ip_forward=0')
    WAN1_MAC, HOTEL_MAC = link(0, 'wan1')['address'], link(hotel, 'wan1p')['address']
    # Counters on each uplink: what reached it from the box.
    for pid, dev in [(sim, 'wan0p'), (hotel, 'wan1p')]:
        p = subprocess.run(['nsenter', '-t', str(pid), '-n', 'nft', '-f', '-'], text=True, capture_output=True, input=f'''
table ip count {{
  chain in {{ type filter hook input priority 0;
    iifname "{dev}" udp dport 5000 counter name udp_stream
    iifname "{dev}" udp dport 53 counter name dns
    iifname "{dev}" tcp dport {{80, 443}} ct state new counter name web
  }}
  counter udp_stream {{}}
  counter dns {{}}
  counter web {{}}
}}
''')
        assert p.returncode == 0, p.stderr

    def count(pid, name):
        out = ns(pid, 'nft', '-j', 'list', 'counter', 'ip', 'count', name).stdout
        for item in json.loads(out)['nftables']:
            if 'counter' in item:
                return item['counter']['packets']
        raise RuntimeError(name)

    # Certificate for "the internet" behind the hotel. The proxy never gets its key.
    run('openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
        '-subj', '/CN=internet.test', '-addext', 'subjectAltName=DNS:internet.test',
        '-keyout', str(tmp / 'key.pem'), '-out', str(tmp / 'cert.pem'), timeout=20)
    der = run('sh', '-c', f'openssl x509 -in {tmp}/cert.pem -pubkey -noout | openssl pkey -pubin -outform der | base64 -w0')
    pin = 'sha256//' + base64.b64encode(hashlib.sha256(base64.b64decode(der)).digest()).decode()

    sim_log, hotel_log = tmp / 'sim-events.jsonl', tmp / 'hotel-events.jsonl'
    background(sim, SIM, str(sim_log))
    background(hotel, HOTEL, str(tmp / 'cert.pem'), str(tmp / 'key.pem'), str(hotel_log))
    stop_flag = tmp / 'stop-flow'
    flow = background(0, FLOW, str(stop_flag))
    before = snapshot()

    # --- Role and window refusals: nothing listens. ---
    for role in ['viewer', 'copilot', '']:
        g = tmp / f'grant-{role or "none"}.json'
        write_grant(g, role=role)
        p = subprocess.run([PROXY, '-listen', '10.42.0.1:8413', '-grant', str(g)], capture_output=True, text=True, timeout=10)
        check(f'role {role or "(none)"} refused before listening', p.returncode == 3 and 'result=role_refused' in p.stderr, p.stderr)
    g = tmp / 'grant-nosession.json'
    write_grant(g, session='')
    p = subprocess.run([PROXY, '-listen', '10.42.0.1:8413', '-grant', str(g)], capture_output=True, text=True, timeout=10)
    check('grant without a session refused', p.returncode == 3 and 'result=no_session' in p.stderr, p.stderr)
    g = tmp / 'grant-long.json'
    write_grant(g, ttl=3600)
    p = subprocess.run([PROXY, '-listen', '10.42.0.1:8413', '-grant', str(g)], capture_output=True, text=True, timeout=10)
    check('grant longer than ten minutes refused', p.returncode == 3 and 'result=outside_window' in p.stderr, p.stderr)
    g = tmp / 'grant-mode.json'
    write_grant(g)
    os.chmod(g, 0o644)
    p = subprocess.run([PROXY, '-listen', '10.42.0.1:8413', '-grant', str(g)], capture_output=True, text=True, timeout=10)
    check('world-readable grant refused', p.returncode == 2 and 'result=bad_grant' in p.stderr, p.stderr)
    rc, _, code, _ = curl(phone, 'http://10.42.0.1:8413/')
    check('nothing listens after refusals', rc != 0 and code in ('000', ''), code)

    # --- Main grant: an Owner session for one phone. ---
    grant = tmp / 'grant.json'
    token = write_grant(grant, role='owner', ttl=120)
    log_path = tmp / 'proxy.log'
    proxy = start_proxy(str(grant), log_path)
    check('proxy listening', proxy.poll() is None and 'result=listening' in log_path.read_text(), log_path.read_text())
    P = ['-x', 'http://10.42.0.1:8413', '-U', 'signin:' + token]

    rc, body, code, err = curl(phone, *P, 'http://internet.test/generate_204')
    loc = ns(phone, 'curl', '-sS', '--max-time', '8', '-o', '/dev/null', '-w', '%{redirect_url}', *P, 'http://internet.test/', check_rc=False).stdout
    check('plain HTTP via proxy gets the portal redirect', code == '302' and loc.startswith('http://portal.hotel.test/login'), f'{code} {loc} {err}')
    rc, body, code, err = curl(phone, '--cacert', str(tmp / 'cert.pem'), *P, 'https://internet.test/')
    check('HTTPS is not open before login', rc != 0, f'{rc} {code}')
    rc, body, code, err = curl(phone, *P, 'http://portal.hotel.test/login?client_mac=02:aa&sig=QUERYSECRET42')
    check('portal login page loads through the hotel', code == '200' and '<form' in body, f'{code} {err}')
    rc, body, code, err = curl(phone, *P, '-d', 'room=4711&surname=Doe&card=4111111111111111', 'http://portal.hotel.test/login')
    check('login POST accepted', code == '302', f'{code} {err}')
    rc, body, code, err = curl(phone, *P, 'http://internet.test/')
    check('open internet over plain HTTP after login, via the hotel', code == '200' and body == 'internet-via-hotel', f'{code} {body} {err}')
    rc, body, code, err = curl(phone, *P, '-p', 'http://internet.test/')
    check('plain HTTP carried as CONNECT to port 80 (connection-level proxies) works', code == '200' and body == 'internet-via-hotel', f'{code} {body} {err}')
    rc, body, code, err = curl(phone, '--cacert', str(tmp / 'cert.pem'), '--pinnedpubkey', pin, *P, 'https://internet.test/')
    check('HTTPS via CONNECT verifies the origin certificate and pinned key (no interception)', code == '200' and body == 'internet-via-hotel-tls', f'{rc} {code} {err}')
    rc, body, code, err = curl(phone, '--cacert', str(tmp / 'cert.pem'), '--pinnedpubkey', pin, '-x', 'socks5h://signin:' + token + '@10.42.0.1:8413', 'https://internet.test/')
    check('HTTPS via SOCKS5 (remote names) verifies the origin certificate', code == '200' and body == 'internet-via-hotel-tls', f'{rc} {code} {err}')

    rc, body, code, err = curl(phone, *P, 'http://sim-only.test/')
    check('a destination only the SIM reaches fails through the proxy', code == '502', f'{code} {err}')
    rc, body, code, err = curl(phone, *P, '-p', 'http://203.0.113.20/')
    check('an IPv4 literal only the SIM reaches fails through the proxy', code == '502', f'{code} {body} {err}')
    rc, body, code, err = curl(phone, *P, 'http://203.0.113.10/')
    check('an IPv4 literal both uplinks hold is reached via the hotel', code == '200' and body == 'internet-via-hotel', f'{code} {body} {err}')
    for target in ['10.42.0.1:80', '192.0.2.1:80', '198.51.100.1:80', '127.0.0.1:80']:
        rc, body, code, err = curl(phone, *P, '-p', f'http://{target}/')
        check(f'box-local {target} refused', code == '403', f'{code} {err}')
    rc, body, code, err = curl(phone, *P, '-p', 'http://internet.test:22/')
    check('port outside the list refused', code == '403', f'{code} {err}')
    rc, body, code, err = curl(phone, '-x', 'http://10.42.0.1:8413', '-U', 'signin:wrong', 'http://internet.test/')
    check('wrong token asks for proxy auth', code == '407', code)
    rc, body, code, err = curl(phone, '-x', 'http://10.42.0.1:8413', 'http://internet.test/')
    check('no token asks for proxy auth', code == '407', code)
    rc, body, code, err = curl(phone, '--interface', '10.42.0.3', *P, 'http://internet.test/')
    check('a second device with the same token is refused', code == '403', code)

    # --- Path evidence from both uplinks. ---
    time.sleep(0.3)
    hotel_events = events(hotel_log)
    sim_events = events(sim_log)
    hotel_http = [e for e in hotel_events if e['ev'] in ('http', 'tls_accept')]
    check('hotel saw proxied traffic only from the bound source 198.51.100.1', hotel_http and all(e['src'] == '198.51.100.1' for e in hotel_http), hotel_http)
    check('hotel requests arrived in origin form without proxy credentials', all(e['origin_form'] and not e['proxy_auth'] for e in hotel_events if e['ev'] == 'http'))
    logins = [e for e in hotel_events if e['ev'] == 'login']
    check('login form reached the portal intact', len(logins) == 1 and logins[0]['form_intact'], logins)
    dns_names = sorted({e['name'] for e in hotel_events if e['ev'] == 'dns'})
    check('names were looked up on the hotel resolver from the bound source', 'internet.test' in dns_names and all(e['src'] == '198.51.100.1' for e in hotel_events if e['ev'] == 'dns'), dns_names)
    check('the SIM uplink saw no web or DNS traffic', not sim_events and count(sim, 'web') == 0 and count(sim, 'dns') == 0, (sim_events, count(sim, 'web'), count(sim, 'dns')))

    # --- Revocation: the backend deletes the grant (session ended or role changed). ---
    hold = background(phone, HOLD, '10.42.0.1', token, str(tmp / 'cert.pem'))
    began = time.monotonic()
    grant.unlink()
    closed = hold.stdout.readline().strip()
    proxy.wait(timeout=5)
    check('revoking the grant cuts an open HTTPS tunnel', closed.startswith('closed_after=') and float(closed.split('=')[1]) < 2.0, closed)
    check('proxy stops on revocation', proxy.returncode is not None and 'kind=stop result=revoked' in log_path.read_text(), log_path.read_text()[-300:])
    rc, body, code, err = curl(phone, *P, 'http://internet.test/')
    check('nothing listens after revocation', code in ('000', ''), code)

    # --- Expiry: a 4-second grant. ---
    grant2 = tmp / 'grant-short.json'
    token2 = write_grant(grant2, role='tech', ttl=4, client='10.42.0.2')
    log2 = tmp / 'proxy-short.log'
    proxy2 = start_proxy(str(grant2), log2)
    hold = background(phone, HOLD, '10.42.0.1', token2, str(tmp / 'cert.pem'))
    closed = hold.stdout.readline().strip()
    proxy2.wait(timeout=8)
    check('Tech grant pinned to the session address works, then expiry cuts the open tunnel', closed.startswith('closed_after=') and float(closed.split('=')[1]) < 6.0, closed)
    check('proxy stops on expiry', 'kind=stop result=expired' in log2.read_text(), log2.read_text()[-300:])
    rc, body, code, err = curl(phone, '-x', 'http://10.42.0.1:8413', '-U', 'signin:' + token2, 'http://internet.test/')
    check('refused after expiry', code in ('000', ''), code)

    # --- The stream's UDP flow never moved. ---
    stop_flag.touch()
    stats = json.loads(flow.stdout.readline())
    check('stream UDP flow answered only by the SIM', stats['labels'] == ['sim'] and stats['got'] >= stats['sent'] - 2 and stats['sent'] > 100, stats)
    check('the hotel uplink saw no stream UDP', count(hotel, 'udp_stream') == 0, count(hotel, 'udp_stream'))
    check('routes and rules unchanged', snapshot() == before)

    # --- Logs: no paths, queries, user info, form data, cookies or tokens. ---
    logs = log_path.read_text() + log2.read_text()
    secrets_seen = [s for s in [token, token2, 'QUERYSECRET42', 'sig=', 'client_mac', '/login', '4711', 'Doe', '4111111111111111',
                                'cookie-secret-77', base64.b64encode(f'signin:{token}'.encode()).decode()] if s in logs]
    check('logs carry no secrets, paths, form or card data', not secrets_seen, secrets_seen)
    check('logs name host and port only', 'dest=portal.hotel.test:80 result=ok' in logs and 'dest=internet.test:443 result=ok' in logs, logs[-500:])
    print(f'flow sent={stats["sent"]} got={stats["got"]}', flush=True)
finally:
    for proc in reversed(children):
        if proc.poll() is None:
            proc.kill()
    for proc in children:
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass

print(f'{sum(ok for _, ok in results)}/{len(results)} checks passed', flush=True)
sys.exit(1 if failures or not results else 0)
