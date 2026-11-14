#!/usr/bin/env python3
"""Run as root in fresh mount/PID/network namespaces. Synthetic links only.

BUN, SRTLA_RECEIVER (dual-stack), SRTLA_IPV4_RECEIVER, TAYGA_BIN,
and PROOF_OUTPUT are explicit local binary/output paths. The CLAT status fixture
uses the image's schema v1; no service or host device is passed into the lab.
"""
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess as sp
import time

R = Path(os.environ['PROOF_OUTPUT']); R.mkdir(parents=True, exist_ok=True)
HERE = Path(__file__).resolve().parent
BUN = os.environ['BUN']; TAYGA = os.environ['TAYGA_BIN']
processes = []
def run(*args):
    return sp.check_output(args, text=True, stderr=sp.STDOUT)
def spawn(args, name, **kw):
    p = sp.Popen(args, stdout=open(R / (name + '.log'), 'w'), stderr=sp.STDOUT, **kw)
    processes.append(p); return p
try:
    assert {x['ifname'] for x in json.loads(run('ip','-j','link'))} == {'lo'}
    run('mount','--make-rprivate','/')
    run('mount','-t','sysfs','sysfs','/sys')
    run('ip','link','set','lo','up')
    peer = spawn(['unshare','-n','sleep','180'], 'peer'); time.sleep(.2)
    def P(*a): return ['nsenter','-t',str(peer.pid),'-n','--',*a]
    run(*P('ip','link','set','lo','up'))
    run('ip','link','add','wan0','type','veth','peer','name','srv0')
    run('ip','link','set','srv0','netns',str(peer.pid))
    for prefix,dev,addr in [([], 'wan0','fd51::1/64'),(P(), 'srv0','fd51::2/64')]:
        run(*prefix,'ip','link','set',dev,'up')
        run(*prefix,'ip','addr','add',addr,'dev',dev,'nodad')
    run(*P('ip','addr','add','192.0.2.2/32','dev','lo'))
    # DNS fixture supplies an A/AAAA pair for mixed.test, A alone for aonly.test.
    dns = '''import socket,struct
s=socket.socket(socket.AF_INET6,socket.SOCK_DGRAM);s.bind(('::',53))
while True:
 b,a=s.recvfrom(4096);q=b[12:];t=struct.unpack('!H',q[-4:-2])[0];answer=b''
 if t==1: answer=socket.inet_aton('192.0.2.2')
 if t==28 and b'mixed' in q: answer=socket.inet_pton(socket.AF_INET6,'fd51::2')
 s.sendto(b[:2]+struct.pack('!HHHHH',0x8180,1,int(bool(answer)),0,0)+q+(b'\\xc0\\x0c'+struct.pack('!HHIH',t,1,30,len(answer))+answer if answer else b''),a)
'''
    spawn(P('python3','-u','-c',dns),'dns')
    (R/'resolv.conf').write_text('nameserver fd51::2\noptions timeout:1 attempts:1\n')
    run('mount','--bind',str(R/'resolv.conf'),'/etc/resolv.conf')
    sink = '''import socket
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('192.0.2.2',9002))
while True:
 b,a=s.recvfrom(65535)
 if b.endswith(b'family-proof'):open(%r,'a').write('packet\\n')
''' % str(R/'received.txt')
    (R/'received.txt').write_text('')
    spawn(P('python3','-u','-c',sink),'sink')
    spawn(P(os.environ['SRTLA_RECEIVER'],'--srtla_port','9000','--srt_hostname','192.0.2.2','--srt_port','9002'),'receiver6')
    spawn(P(os.environ['SRTLA_IPV4_RECEIVER'],'9003','192.0.2.2','9002'),'receiver4')
    selector = sp.Popen([BUN,str(HERE/'select.ts')],stdin=sp.PIPE,stdout=sp.PIPE,text=True)
    processes.append(selector)
    def choose(source,receiver={'ipv4':True,'ipv6':True},reset=False,**extra):
        selector.stdin.write(json.dumps(dict(source=source,receiver=receiver,reset=reset,**extra))+'\n');selector.stdin.flush()
        return json.loads(selector.stdout.readline())
    def publish(path):
        (R/'ips').write_text((path['ip']+'\n') if path else '')
    results=[]
    def start(path,dest='mixed.test',port='9000'):
        publish(path)
        p=spawn(['/usr/bin/srtla_send','--verbose','9001',dest,port,str(R/'ips')],f'sender-{len(results)}')
        time.sleep(3)
        warm=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);warm.sendto(struct.pack('!IIII',0,0,0,1)+b'warmup',('127.0.0.1',9001));warm.close();time.sleep(1);return p
    def packets(name,path,p):
        before=(R/'received.txt').read_text().count('packet')
        u=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
        for i in range(30):
            u.sendto(struct.pack('!IIII',i,0,0,1)+b'family-proof',('127.0.0.1',9001));time.sleep(.02)
        u.close();time.sleep(.4)
        count=(R/'received.txt').read_text().count('packet')-before
        assert count==30,(name,count)
        results.append(dict(case=name,path=path,forwarded=count,sender_pid=p.pid));print('PASS',name,count,flush=True)
    v6={'ipv6':'fd51::1'}; dual={**v6,'ip':'192.0.2.1'}
    path=choose(v6,reset=True);assert path['mode']=='ipv6'
    sender=start(path);packets('native-ipv6',path,sender);sender.terminate();sender.wait()
    run('ip','addr','add','192.0.2.1/24','dev','wan0')
    run(*P('ip','addr','add','192.0.2.2/24','dev','srv0'))
    path=choose(dual,reset=True);assert path['mode']=='ipv4'
    sender=start(path,'aonly.test');packets('dual-stack',path,sender)
    sender.terminate();sender.wait()
    run('ip','addr','del','192.0.2.1/24','dev','wan0')
    run(*P('ip','addr','del','192.0.2.2/24','dev','srv0'))
    # Real tayga pair: local CLAT (IPv4 source) -> IPv6-only veth -> PLAT -> IPv4 receiver.
    run('sysctl','-qw','net.ipv6.conf.all.forwarding=1')
    run(*P('sysctl','-qw','net.ipv6.conf.all.forwarding=1'))
    run(*P('sysctl','-qw','net.ipv4.ip_forward=1'))
    cfg=R/'plat.conf';cfg.write_text('tun-device plat\nipv4-addr 192.0.2.254\nipv6-addr fd51::64\nprefix fd64:51::/96\ndynamic-pool 192.168.255.0/24\n')
    run(*P(TAYGA,'-c',str(cfg),'--mktun'));run(*P('ip','link','set','plat','up'))
    run(*P('ip','-6','route','add','fd64:51::/96','dev','plat'))
    run(*P('ip','route','add','192.168.255.0/24','dev','plat'))
    spawn(P(TAYGA,'-c',str(cfg),'-d'),'plat')
    index=socket.if_nametoindex('wan0');tun=f'clat{index}';ip=f'10.254.{index//256}.{index%256}';mapping=f'fd46:4:4::{index:x}'
    cfg=R/'clat.conf';cfg.write_text(f'tun-device {tun}\nipv4-addr 192.0.0.2\nipv6-addr fd46:4:ffff::{index:x}\nprefix fd64:51::/96\nmap {ip} {mapping}\n')
    run(TAYGA,'-c',str(cfg),'--mktun');run('ip','link','set',tun,'up');run('ip','addr','add',ip+'/32','dev',tun)
    run('ip','route','add','192.0.2.2/32','dev',tun)
    run('ip','-6','route','add',mapping+'/128','dev',tun)
    run('ip','-6','route','add','fd64:51::/96','via','fd51::2')
    run('nft','add','table','ip6','proof');run('nft','add','chain','ip6','proof','post','{ type nat hook postrouting priority 100; }')
    run('nft','add','rule','ip6','proof','post','ip6','saddr',mapping,'oifname','wan0','snat','to','fd51::1')
    spawn([TAYGA,'-c',str(cfg),'-d'],'clat');time.sleep(.3)
    snapshot=dict(schema_version=1,interface='wan0',tun=tun,prefix='fd64:51::/96',ipv4=ip,state='up',last_error=None,updated_at=int(time.time()))
    (R/'clat-status.json').write_text(json.dumps(snapshot))
    path=choose(v6,{'ipv4':True,'ipv6':False},True,snapshot=snapshot,index=index,active=True,tunExists=Path('/sys/class/net',tun,'tun_flags').exists())
    assert path['mode']=='clat'
    sender=start(path,'aonly.test','9003');packets('ipv6-only-clat-nat64',path,sender)
    sender.terminate();sender.wait()
    # Current sender chooses the first DNS destination without source-family matching.
    # Retain the failing transition as a merge-blocking receipt, never call it a proof.
    path=choose(v6,reset=True)
    sender=start(path)
    packets('family-change-before',path,sender)
    run('ip','addr','add','192.0.2.1/24','dev','wan0')
    run(*P('ip','addr','add','192.0.2.2/24','dev','srv0'))
    # A second synthetic IPv6 uplink keeps the host genuinely mixed when wan0
    # loses IPv6. No physical device is moved or used.
    run('ip','link','add','backup0','type','veth','peer','name','backup-peer')
    run('ip','link','set','backup-peer','netns',str(peer.pid))
    run('ip','link','set','backup0','up');run(*P('ip','link','set','backup-peer','up'))
    run('ip','addr','add','fd52::1/64','dev','backup0','nodad')
    run(*P('ip','addr','add','fd52::2/64','dev','backup-peer','nodad'))
    run('ip','-6','route','add','fd51::2/128','via','fd52::2','dev','backup0')
    run('ip','addr','del','fd51::1/64','dev','wan0')
    assert choose({'ip':'192.0.2.1'}) is None
    time.sleep(10.2)
    path=choose({'ip':'192.0.2.1'});assert path['mode']=='ipv4'
    publish(path);sender.send_signal(signal.SIGHUP);time.sleep(3)
    (R/'results.json').write_text(json.dumps(results,indent=2))
    packets('family-change-after',path,sender)
    (R/'results.json').write_text(json.dumps(results,indent=2))
finally:
    for p in reversed(processes):
        if p.poll() is None:p.terminate()
    for p in processes:
        try:p.wait(timeout=3)
        except sp.TimeoutExpired:p.kill();p.wait()
