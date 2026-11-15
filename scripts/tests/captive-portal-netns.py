#!/usr/bin/env python3
"""Root only, inside a disposable network + PID namespace. No host network I/O."""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import time
import tempfile
import signal
import shutil

spec = importlib.util.spec_from_file_location('portal', pathlib.Path(__file__).parents[2] / 'deployment/captive-portal-window.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
assert os.geteuid() == 0
assert os.readlink('/proc/self/ns/net') != os.readlink('/proc/1/ns/net'), 'private network namespace required'
children = []
def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=5)
def ns(pid, *args):
    return run('nsenter', '-t', str(pid), '-n', *args)
def peer(name, subnet):
    proc = subprocess.Popen(['unshare', '-n', 'sh', '-c', 'echo ready; exec sleep 300'], stdout=subprocess.PIPE)
    children.append(proc)
    assert proc.stdout.readline() == b'ready\n'
    pid = proc.pid
    run('ip', 'link', 'add', name, 'type', 'veth', 'peer', 'name', name+'p')
    run('ip', 'link', 'set', name+'p', 'netns', str(pid))
    run('ip', 'addr', 'add', subnet+'.1/24', 'dev', name)
    run('ip', 'link', 'set', name, 'up')
    ns(pid, 'ip', 'link', 'set', 'lo', 'up')
    ns(pid, 'ip', 'addr', 'add', subnet+'.2/24', 'dev', name+'p')
    ns(pid, 'ip', 'link', 'set', name+'p', 'up')
    ns(pid, 'ip', 'route', 'add', 'default', 'via', subnet+'.1')
    return pid

def request(pid, proto='tcp', port=80, destination='203.0.113.10', source=''):
    code = '''import socket,sys
s=socket.socket(socket.AF_INET,socket.SOCK_STREAM if sys.argv[1]=='tcp' else socket.SOCK_DGRAM);s.settimeout(2)
if sys.argv[4]:s.bind((sys.argv[4],0))
if sys.argv[1]=='tcp':
 s.connect((sys.argv[3],int(sys.argv[2])));s.send(b'GET / HTTP/1.0\\r\\n\\r\\n')
else:s.sendto(b'ping',(sys.argv[3],int(sys.argv[2])))
print(s.recv(4096).decode())'''
    return ns(pid, 'python3', '-c', code, proto, str(port), destination, source)

try:
    run('ip', 'link', 'set', 'lo', 'up')
    phone = peer('ap0', '10.42.0')
    healthy = peer('wan0', '192.0.2')
    hotel = peer('wan1', '198.51.100')
    healthy2 = peer('wan2', '192.0.3')
    for pid in [healthy, hotel, healthy2]:
        ns(pid, 'ip', 'addr', 'add', '203.0.113.10/32', 'dev', 'lo')
    run('ip', 'route', 'add', 'default', 'via', '192.0.2.2')
    run('sysctl', '-qw', 'net.ipv4.ip_forward=1')
    for dev in ['all', 'default', 'ap0', 'wan0', 'wan1', 'wan2']:
        run('sysctl', '-qw', f'net.ipv4.conf.{dev}.rp_filter=0')
    # Baseline sharing is deliberately present; replies identify the chosen WAN.
    p.run('nft', '-f', '-', data='table ip baseline { chain nat { type nat hook postrouting priority 100; masquerade; }; }\n')
    p.run('nft', '-f', '-', data=pathlib.Path(sys.argv[1]).read_text())
    server = '''import socket,threading,sys,time
label=sys.argv[1]
def tcp():
 s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('0.0.0.0',80));s.listen()
 while True:
  c,a=s.accept();c.recv(4096);c.send(('HTTP/1.0 200 OK\\r\\n\\r\\n'+label).encode());c.close()
def tls_echo():
 s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('203.0.113.10',443));s.listen()
 while True:
  c,a=s.accept()
  def echo(c):
   try:
    while c.recv(4096):c.sendall(label.encode())
   except OSError:pass
   finally:c.close()
  threading.Thread(target=echo,args=(c,),daemon=True).start()
def udp(port):
 s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('203.0.113.10',port))
 while True:
  data,a=s.recvfrom(4096)
  if data != b'hold':s.sendto(label.encode(),a)
threading.Thread(target=tcp,daemon=True).start()
threading.Thread(target=tls_echo,daemon=True).start()
for port in [53,5000,5001]:threading.Thread(target=udp,args=(port,),daemon=True).start()
print('ready',flush=True)
time.sleep(300)'''
    for pid, label in [(healthy, 'healthy'), (hotel, 'hotel'), (healthy2, 'healthy2')]:
        proc = subprocess.Popen(['nsenter','-t',str(pid),'-n','python3','-c',server,label], stdout=subprocess.PIPE)
        children.append(proc)
        assert proc.stdout.readline() == b'ready\n'
    for index, source, gateway, dev in [(100,'192.0.2.1','192.0.2.2','wan0'),(102,'192.0.3.1','192.0.3.2','wan2')]:
        run('ip','route','add','table',str(index),'default','via',gateway,'dev',dev)
        run('ip','rule','add','priority','100','from',source,'table',str(index))
    relay_code = '''import socket,sys,time
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind((sys.argv[1],0));s.settimeout(1)
for i in range(160):
 s.sendto(str(i).encode(),('203.0.113.10',int(sys.argv[2])))
 assert s.recv(4096).decode()==sys.argv[3]
 time.sleep(.1)
print('relay packets 160/160',flush=True)'''
    relays = []
    for source,label in [('192.0.2.1','healthy'),('192.0.3.1','healthy2')]:
        for port in [5000,5001]:
            proc = subprocess.Popen(['python3','-c',relay_code,source,str(port),label], stdout=subprocess.PIPE)
            children.append(proc)
            relays.append(proc)
    local_server_code = """import socket
s=socket.socket();s.bind(('10.42.0.1',80));s.listen();print('ready',flush=True)
c,a=s.accept()
while True:
 data=c.recv(32)
 if not data: break
 c.sendall(data)
"""
    local_server = subprocess.Popen(['python3','-c',local_server_code], stdout=subprocess.PIPE)
    children.append(local_server)
    assert local_server.stdout.readline() == b'ready\n'
    control_code = '''import socket,time
s=socket.create_connection(('10.42.0.1',80));s.settimeout(1)
for i in range(160):
 s.sendall(b'control'); assert s.recv(32)==b'control'; time.sleep(.1)
print('control 160/160',flush=True)'''
    local_client = subprocess.Popen(['nsenter','-t',str(phone),'-n','python3','-c',control_code], stdout=subprocess.PIPE)
    children.append(local_client)
    share = pathlib.Path(sys.argv[1]).read_text()
    marks = sorted(set(__import__('re').findall(r'0xca[0-9a-f]{6}', share)) - {'0xca000000'})
    assert len(marks) == 2
    # Parse each selected mark's device from the generated production NAT rules.
    for mark in marks:
        dev = __import__('re').search(r'ct mark & 0xffffff00 == '+mark+r' oifname "([^"]+)"',share).group(1)
        run('ip','rule','add','priority','110','fwmark',mark+'/0xffffff00','table','100' if dev=='wan0' else '102')
    physical_before = run('ip','rule','show')
    mac = json.loads(ns(phone, 'ip', '-j', 'link', 'show', 'ap0p'))[0]['address']
    c = dict(ap='ap0',phone='10.42.0.2',mac=mac,wan='wan1',address='198.51.100.1',gateway='198.51.100.2',dns='203.0.113.10',seconds=10)
    assert 'healthy' in request(phone)
    baseline = run('ip','route','show','table','main')
    p.open_window(c)
    assert 'hotel' in request(phone)
    assert 'hotel' in request(phone, 'udp', 53)
    assert 'hotel' in request(phone, 'udp', 53, '10.42.0.1')
    stale_code = '''import socket,sys
s=socket.create_connection(('203.0.113.10',443));s.settimeout(2);s.sendall(b'first');assert s.recv(32)==b'hotel'
print('ready',flush=True);sys.stdin.readline()
try:
 s.sendall(b'expired');data=s.recv(32);assert data!=b'hotel'
except OSError:pass
print('expired',flush=True)'''
    stale = subprocess.Popen(['nsenter','-t',str(phone),'-n','python3','-c',stale_code], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    children.append(stale)
    assert stale.stdout.readline() == b'ready\n'
    unanswered_code = """import socket,sys
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('10.42.0.2',60666));s.settimeout(2)
s.sendto(b'hold',('203.0.113.10',53));print('ready',flush=True);sys.stdin.readline()
s.sendto(b'ping',('203.0.113.10',53))
try:
 s.recv(32);raise AssertionError('expired unanswered flow escaped')
except socket.timeout:pass
print('expired',flush=True)
"""
    unanswered = subprocess.Popen(['nsenter','-t',str(phone),'-n','python3','-c',unanswered_code], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    children.append(unanswered)
    assert unanswered.stdout.readline() == b'ready\n'

    assert physical_before == '\n'.join(line for line in run('ip','rule','show').splitlines() if not line.startswith('90:')) + '\n'
    assert 'healthy' in request(os.getpid())
    # Fake SRTLA and Moblink receiver traffic, both forwarded and box-originated.
    for port in [5000,5001]:
        assert 'healthy' in request(phone, 'udp', port)
        assert 'healthy' in request(os.getpid(), 'udp', port)
    # Same AP, another source address must stay on the healthy uplink.
    ns(phone,'ip','addr','add','10.42.0.3/24','dev','ap0p')
    assert 'healthy' in ns(phone,'curl','-s','--interface','10.42.0.3','--max-time','2','http://203.0.113.10')
    assert 'healthy' in request(phone, 'udp', 53, source='10.42.0.3')
    # Even the selected IP cannot borrow the window under another Ethernet MAC.
    root_mac = json.loads(run('ip','-j','link','show','ap0'))[0]['address']
    foreign_mac_code = """import socket,struct,sys
udp=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);udp.bind(('10.42.0.2',55555));udp.settimeout(2)
payload=b'ping'
header=struct.pack('!BBHHHBBH4s4s',69,0,32,1234,0,64,17,0,socket.inet_aton('10.42.0.2'),socket.inet_aton('203.0.113.10'))
words=struct.unpack('!10H',header);total=sum(words)
while total>>16:total=(total&65535)+(total>>16)
header=header[:10]+struct.pack('!H',(~total)&65535)+header[12:]
frame=bytes.fromhex(sys.argv[1].replace(':',''))+bytes.fromhex('020000000099')+bytes.fromhex('0800')+header+struct.pack('!HHHH',55555,53,12,0)+payload
raw=socket.socket(socket.AF_PACKET,socket.SOCK_RAW);raw.bind(('ap0p',0));raw.send(frame)
assert b'healthy' in udp.recv(32)
"""
    ns(phone,'python3','-c',foreign_mac_code,root_mac)

    assert baseline == run('ip','route','show','table','main')
    time.sleep(10.2)
    stale.stdin.write(b'check\n');stale.stdin.flush()
    assert stale.stdout.readline() == b'expired\n'
    assert stale.wait(timeout=5) == 0
    unanswered.stdin.write(b'check\n');unanswered.stdin.flush()
    assert unanswered.stdout.readline() == b'expired\n'
    assert unanswered.wait(timeout=5) == 0
    # Even an unanswered conntrack keeps portal ownership; sharing must not
    # reselect it onto a healthy path before the NAT layer can drop it.
    tracked = p.run('conntrack','-L','-p','udp','-s','10.42.0.2','--sport','60666')
    assert 'mark=3405775104' in tracked, tracked
    # New flows after kernel expiry use the baseline; old portal flows are dead.
    assert 'healthy' in request(phone)
    p.close_window(c)
    assert baseline == run('ip','route','show','table','main')
    assert 'healthy' in request(phone)
    p.run('nft', '-f', '-', data='table inet all_down { chain forward { type filter hook forward priority 0; ip saddr 10.42.0.0/24 ct state new meta mark != 0xcb000100 drop; }; }\n')
    p.open_window(c)
    assert 'hotel' in request(phone)
    p.close_window(c)
    p.run('nft', 'delete', 'table', 'inet', 'all_down')
    assert 'healthy' in request(phone)
    # A reconnect removes the private route before the owner closes.
    p.open_window(c)
    run('ip', 'addr', 'del', '198.51.100.1/24', 'dev', 'wan1')
    assert not run('ip', '-4', 'route', 'show', 'table', p.ROUTE_TABLE)
    p.close_window(c)
    p.close_window(c)
    run('ip', 'addr', 'add', '198.51.100.1/24', 'dev', 'wan1')
    p.open_window(c)
    assert 'hotel' in request(phone)
    # New helper process: no in-memory config, live sets/rule/route survive.
    helper = str(pathlib.Path(__file__).parents[2] / 'deployment/captive-portal-window.py')
    subprocess.run(['python3', '-I', helper, 'sweep'], input='{}', text=True, check=True)
    assert not p.run('nft', 'list', 'table', 'inet', p.TABLE, check=False)
    assert not run('ip', '-4', 'route', 'show', 'table', p.ROUTE_TABLE)
    assert 'healthy' in request(phone)
    p.open_window(c)
    p.close_window(c)
    # TERM after nft has installed live sets must execute rollback.
    with tempfile.TemporaryDirectory() as tmp:
        real_nft = shutil.which('nft')
        ready = pathlib.Path(tmp) / 'ready'
        shim = pathlib.Path(tmp) / 'nft'
        payload = pathlib.Path(tmp) / 'payload'
        shim.write_text('#!/bin/sh\n'
                        'if [ "$1" = "-f" ]; then\ncat > "' + str(payload) + '"\n'
                        + real_nft + ' "$@" < "' + str(payload) + '"\nrc=$?\n'
                        'if grep -q "timeout 10s" "' + str(payload) + '" && [ ! -e "' + str(ready) + '" ]; then\n'
                        'touch "' + str(ready) + '"\nsleep 2\nfi\nexit "$rc"\n'
                        'else\nexec ' + real_nft + ' "$@"\nfi\n')
        shim.chmod(0o755)
        proc = subprocess.Popen(['python3', '-I', helper, 'open'], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env={**os.environ, 'PATH': tmp + ':' + os.environ['PATH']})
        children.append(proc)
        proc.stdin.write(json.dumps(c).encode()); proc.stdin.close()
        limit = time.monotonic() + 5
        while not ready.exists() and time.monotonic() < limit:
            time.sleep(.01)
        assert ready.exists()
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=15) != 0
        assert not p.run('nft', 'list', 'table', 'inet', p.TABLE, check=False)
        assert not run('ip', '-4', 'route', 'show', 'table', p.ROUTE_TABLE)
    # Hard stop between route and rule installation: the inert ownership table
    # must make this partial installation recoverable too.
    with tempfile.TemporaryDirectory() as tmp:
        ready = pathlib.Path(tmp) / 'ready'
        shim = pathlib.Path(tmp) / 'ip'
        shim.write_text('#!/bin/sh\n' + shutil.which('ip') + ' "$@"\nrc=$?\n'
                        'if [ "$3" = "add" ] && [ "$2" = "route" ]; then\n'
                        'touch "' + str(ready) + '"\nsleep 5\nfi\nexit "$rc"\n')
        shim.chmod(0o755)
        proc = subprocess.Popen(['python3', '-I', helper, 'open'], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                                env={**os.environ, 'PATH': tmp + ':' + os.environ['PATH']})
        children.append(proc)
        proc.stdin.write(json.dumps(c).encode()); proc.stdin.close()
        limit = time.monotonic() + 5
        while not ready.exists() and time.monotonic() < limit:
            time.sleep(.01)
        assert ready.exists()
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(timeout=5)
        assert run('ip', '-4', 'route', 'show', 'table', p.ROUTE_TABLE)
        assert '90:' not in run('ip', '-4', 'rule', 'show')
        subprocess.run(['python3', '-I', helper, 'sweep'], input='{}', text=True, check=True)
        assert not run('ip', '-4', 'route', 'show', 'table', p.ROUTE_TABLE)
    # Expired leftovers are recoverable too; sweep is repeatable.
    short = {**c, 'seconds': 1}
    p.open_window(short)
    time.sleep(1.1)
    subprocess.run(['python3', '-I', helper, 'sweep'], input='{}', text=True, check=True)
    subprocess.run(['python3', '-I', helper, 'sweep'], input='{}', text=True, check=True)
    # A removed ingress is reported as iif_detached, not a foreign selector.
    # Use a disposable AP so the continuous phone/control proof stays intact.
    run('ip', 'link', 'add', 'retiredap', 'type', 'dummy')
    run('ip', 'link', 'set', 'retiredap', 'up')
    p.open_window({**c, 'ap': 'retiredap'})
    run('ip', 'link', 'del', 'retiredap')
    detached = json.loads(run('ip', '-j', '-4', 'rule', 'show'))
    assert any('iif_detached' in rule for rule in detached if str(rule.get('table')) == p.ROUTE_TABLE)
    subprocess.run(['python3', '-I', helper, 'sweep'], input='{}', text=True, check=True)
    subprocess.run(['python3', '-I', helper, 'sweep'], input='{}', text=True, check=True)
    assert not run('ip', '-4', 'route', 'show', 'table', p.ROUTE_TABLE)
    assert '90:' not in run('ip', '-4', 'rule', 'show')
    # Device removal also retires its routes; cleanup must not require the old name.
    p.open_window(c)
    run('ip', 'link', 'del', 'wan1')
    p.close_window(c)
    p.close_window(c)
    assert 'healthy' in request(phone)
    assert physical_before == run('ip','rule','show')
    for proc in relays:
        assert proc.wait(timeout=25) == 0
        assert proc.stdout.read() == b'relay packets 160/160\n'
    assert local_client.wait(timeout=25) == 0
    assert local_client.stdout.read() == b'control 160/160\n'
    print('PASS: local control 160/160; 640/640 continuous relay packets on two source-bound uplinks; phone web/DNS only; SRTLA/Moblink and main routes unchanged; expiry, close and detached-ingress recovery')
except subprocess.CalledProcessError as error:
    print(error.stderr, error.stdout, file=sys.stderr)
    print(run('nft','list','ruleset'), file=sys.stderr)
    print(run('conntrack','-L'), file=sys.stderr)
    raise
finally:
    for proc in reversed(children):
        if proc.poll() is None: proc.terminate()
    for proc in children:
        proc.wait(timeout=5)
