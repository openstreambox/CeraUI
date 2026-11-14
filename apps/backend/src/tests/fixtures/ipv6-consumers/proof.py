"""Contained synthetic-link transport proof. See the adjacent README for prerequisites."""
import subprocess as s, os, time, socket, struct, json, pathlib
R = pathlib.Path(os.environ['PROOF_OUTPUT']).resolve()
R.mkdir(parents=True, exist_ok=True)
procs = []
FIXTURE = pathlib.Path(__file__).resolve().parent
BUN = os.environ.get('BUN', 'bun')
REC = os.environ['SRTLA_REC']
TAYGA = os.environ['TAYGA_BIN']

def run(*a, check=True):
    p = s.run(a, text=True, stdout=s.PIPE, stderr=s.STDOUT, timeout=20)
    if check and p.returncode:
        raise RuntimeError((a, p.stdout))
    return p.stdout

def spawn(a, name):
    f = open(R / (name + '.log'), 'w')
    p = s.Popen(a, stdout=f, stderr=s.STDOUT)
    procs.append(p)
    return p

def peer(a):
    return ['nsenter', '-t', str(ns.pid), '-n', '--'] + a
try:
    initial_links = json.loads(run('ip', '-j', 'link', 'show'))
    if {entry['ifname'] for entry in initial_links} != {'lo'}:
        raise RuntimeError('Run only in a fresh private network namespace containing loopback alone')
    run('ip', 'link', 'set', 'lo', 'up')
    ns = spawn(['unshare', '-n', 'sleep', '300'], 'peer')
    client = spawn(['unshare', '-n', 'sleep', '300'], 'client')
    time.sleep(0.2)
    C = lambda a: ['nsenter', '-t', str(client.pid), '-n', '--'] + a
    run('ip', 'link', 'add', 'wan0', 'type', 'veth', 'peer', 'name', 'srv0')
    run('ip', 'link', 'set', 'srv0', 'netns', str(ns.pid))
    run('ip', 'link', 'add', 'lan0', 'type', 'veth', 'peer', 'name', 'cli0')
    run('ip', 'link', 'set', 'cli0', 'netns', str(client.pid))
    for p, iface in [([], 'wan0'), ([], 'lan0'), (peer([]), 'srv0'), (peer([]), 'lo'), (C([]), 'cli0'), (C([]), 'lo')]:
        run(*p + ['ip', 'link', 'set', iface, 'up'])
    for p, iface, addr in [([], 'lan0', '10.42.0.1/24'), (C([]), 'cli0', '10.42.0.2/24'), (peer([]), 'lo', '192.0.2.2/32')]:
        run(*p + ['ip', 'addr', 'add', addr, 'dev', iface])
    run(*C(['ip', 'route', 'add', 'default', 'via', '10.42.0.1']))
    run('sysctl', '-qw', 'net.ipv4.ip_forward=1')
    run('sysctl', '-qw', 'net.ipv4.conf.all.rp_filter=0')
    sink = "import socket,select,pathlib\nss=[]\nfor port in [9002,9010]:\n x=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);x.bind(('192.0.2.2',port));ss.append(x)\nwhile True:\n for x in select.select(ss,[],[],1)[0]:\n  b,a=x.recvfrom(65535);x.sendto(b,a)\n  if b.endswith(b'proof'):open(%r,'a').write(str(x.getsockname()[1])+' '+str(a)+'\\n')\n" % str(R / 'received.txt')
    spawn(peer(['python3', '-u', '-c', sink]), 'sink')
    spawn(peer([REC, '9000', '192.0.2.2', '9002']), 'receiver')
    time.sleep(1)
    (R / 'received.txt').write_text('')
    results = []
    for mode in ['ipv4', 'dual', 'ipv6-nat64']:
        if mode == 'ipv4':
            run('ip', 'addr', 'add', '192.0.2.1/24', 'dev', 'wan0')
            run(*peer(['ip', 'addr', 'add', '192.0.2.2/24', 'dev', 'srv0']))
        if mode == 'dual':
            run('ip', 'addr', 'add', 'fd51::1/64', 'dev', 'wan0', 'nodad')
            run(*peer(['ip', 'addr', 'add', 'fd51::2/64', 'dev', 'srv0', 'nodad']))
        if mode == 'ipv6-nat64':
            run('ip', 'addr', 'del', '192.0.2.1/24', 'dev', 'wan0')
            run(*peer(['ip', 'addr', 'del', '192.0.2.2/24', 'dev', 'srv0']))
            cfg = R / 'tayga.conf'
            cfg.write_text('tun-device nat64\nipv4-addr 192.0.2.254\nipv6-addr fd51::64\nprefix fd64:51::/96\ndynamic-pool 192.168.255.0/24\n')
            tayga = TAYGA
            run(*peer([tayga, '-c', str(cfg), '--mktun']))
            run(*peer(['sysctl', '-qw', 'net.ipv6.conf.all.forwarding=1']))
            run(*peer(['sysctl', '-qw', 'net.ipv4.ip_forward=1']))
            run(*peer(['ip', 'link', 'set', 'nat64', 'up']))
            run(*peer(['ip', 'route', 'add', 'fd64:51::/96', 'dev', 'nat64']))
            run(*peer(['ip', 'route', 'add', '192.168.255.0/24', 'dev', 'nat64']))
            spawn(peer([tayga, '-c', str(cfg), '-d']), 'tayga')
            spawn(peer(['tcpdump', '-n', '-l', '-i', 'any', 'udp']), 'nat64-packets')
            run('ip', '-6', 'route', 'add', 'fd64:51::/96', 'via', 'fd51::2')
            time.sleep(0.3)
        dns_result = ''
        if mode != 'ipv6-nat64':
            dns4 = "import socket,struct\nu=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);u.bind(('192.0.2.2',53))\nwhile True:\n b,a=u.recvfrom(4096);q=b[12:];u.sendto(b[:2]+bytes.fromhex('81800001000100000000')+q+bytes.fromhex('c00c000100010000001e0004')+socket.inet_aton('192.0.2.2'),a)\n"
            d = spawn(peer(['python3', '-c', dns4]), mode + '-dns')
            time.sleep(0.15)
            (R / 'resolv.conf').write_text('nameserver 192.0.2.2\noptions timeout:1 attempts:1\n')
            run('mount', '--bind', str(R / 'resolv.conf'), '/etc/resolv.conf')
            dns_result = run('getent', 'ahostsv4', 'receiver.test')
            d.terminate()
            d.wait()
        if mode == 'ipv6-nat64':
            dns_code = "import socket,struct\nu=socket.socket(socket.AF_INET6,socket.SOCK_DGRAM);u.bind(('fd51::2',53))\nwhile True:\n b,a=u.recvfrom(4096);q=b[12:];t=struct.unpack('!H',q[-4:-2])[0]\n addr=socket.inet_pton(socket.AF_INET6,'fd64:51::c000:202') if t==28 else socket.inet_aton('192.0.2.2')\n ans=b[:2]+bytes.fromhex('81800001000100000000')+q+bytes.fromhex('c00c')+struct.pack('!HHIH',t,1,30,len(addr))+addr\n u.sendto(ans,a)\n"
            spawn(peer(['python3', '-c', dns_code]), 'dns64')
            time.sleep(0.2)
            (R / 'resolv.conf').write_text('nameserver fd51::2\noptions timeout:1 attempts:1\n')
            run('mount', '--bind', str(R / 'resolv.conf'), '/etc/resolv.conf')
            dns_result = run('getent', 'ahostsv6', 'receiver.test')
            print('DNS64', dns_result, flush=True)
        discovered = json.loads(next((line for line in run(BUN, 'test', '--parallel=1', '--max-concurrency=1', str(FIXTURE / 'discover.ts')).splitlines() if line.startswith('{"ips"'))))
        src = discovered['ips'][0]
        dest = 'receiver.test' if mode == 'ipv6-nat64' else '192.0.2.2'
        assert src == ('fd51::1' if mode == 'ipv6-nat64' else '192.0.2.1'), discovered
        assert discovered['ipv6Only'] == (mode == 'ipv6-nat64'), discovered
        (R / 'ips').write_text(src + '\n')
        snd = spawn(['/usr/bin/srtla_send', '--verbose', '9001', dest, '9000', str(R / 'ips')], mode + '-sender')
        time.sleep(3)
        before = (R / 'received.txt').read_text().count('9002') if (R / 'received.txt').exists() else 0
        u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for i in range(30):
            u.sendto(struct.pack('!IIII', i, 0, 0, 1) + b'proof', ('127.0.0.1', 9001))
            time.sleep(0.02)
        time.sleep(0.3)
        after = (R / 'received.txt').read_text().count('9002') if (R / 'received.txt').exists() else 0
        snd.terminate()
        snd.wait(timeout=4)
        rules = run(BUN, str(FIXTURE / 'share.ts'))
        (R / 'share.nft').write_text(rules)
        run('nft', 'flush', 'ruleset')
        s.run(['nft', '-f', '-'], input=rules, text=True, check=True)
        probe = "import socket;u=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);u.settimeout(1);u.sendto(b'proof',('192.0.2.2',9010));print(u.recvfrom(99))"
        hotspot = run(*C(['python3', '-c', probe]), check=False)
        assert after - before == 30, (mode, after - before)
        assert ('TimeoutError' in hotspot) == (mode == 'ipv6-nat64'), hotspot
        backup_hotspot = None
        if mode == 'ipv6-nat64':
            run('ip', 'link', 'add', 'backup0', 'type', 'veth', 'peer', 'name', 'backup-peer')
            run('ip', 'link', 'set', 'backup-peer', 'netns', str(ns.pid))
            run('ip', 'addr', 'add', '198.51.100.1/24', 'dev', 'backup0')
            run(*peer(['ip', 'addr', 'add', '198.51.100.2/24', 'dev', 'backup-peer']))
            run('ip', 'link', 'set', 'backup0', 'up')
            run(*peer(['ip', 'link', 'set', 'backup-peer', 'up']))
            run('ip', 'route', 'add', '192.0.2.2/32', 'via', '198.51.100.2')
            os.environ['SHARE_UPLINK'] = 'backup0'
            rules = run(BUN, str(FIXTURE / 'share.ts'))
            run('nft', 'flush', 'ruleset')
            s.run(['nft', '-f', '-'], input=rules, text=True, check=True)
            backup_hotspot = run(*C(['python3', '-c', probe]))
            assert "b'proof'" in backup_hotspot, backup_hotspot
        results.append(dict(mode=mode, dns=dns_result, srtla_forwarded=after - before, discovered=discovered, hotspot=hotspot[-250:], backup_hotspot=backup_hotspot))
        if mode == 'dual':
            (R / 'ips6').write_text('fd51::1\n')
            v = spawn(['/usr/bin/srtla_send', '--verbose', '9004', 'fd51::2', '9000', str(R / 'ips6')], 'native6-sender')
            time.sleep(2)
            v.terminate()
            v.wait()
    print(json.dumps(results, indent=2))
    (R / 'results.json').write_text(json.dumps(results, indent=2))
finally:
    for p in reversed(procs):
        if p.poll() is None:
            p.terminate()
    for p in procs:
        try:
            p.wait(timeout=3)
        except s.TimeoutExpired:
            p.kill()
