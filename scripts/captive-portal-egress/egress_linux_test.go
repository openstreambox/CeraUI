//go:build linux

package portalegress

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net"
	"net/netip"
	"os"
	"reflect"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"portal-egress/internal/dnsmessage"
)

type testDeadline struct {
	context.Context
	deadline time.Time
}

func (c testDeadline) Deadline() (time.Time, bool) { return c.deadline, true }

// All timeouts are advanced explicitly, including blocked cleanup. No test
// needs a real timer, process, socket, or resolver.
type testClock struct {
	mu     sync.Mutex
	now    time.Time
	next   int
	timers map[int]struct {
		deadline time.Time
		cancel   context.CancelFunc
	}
	created chan time.Duration
}

func newClock() *testClock {
	return &testClock{now: time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC), timers: make(map[int]struct {
		deadline time.Time
		cancel   context.CancelFunc
	}), created: make(chan time.Duration, 256)}
}
func (c *testClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *testClock) Timeout(parent context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	c.mu.Lock()
	deadline := c.now.Add(d)
	if previous, ok := parent.Deadline(); ok && previous.Before(deadline) {
		deadline = previous
	}
	ctx, cancel := context.WithCancel(parent)
	c.next++
	id := c.next
	c.timers[id] = struct {
		deadline time.Time
		cancel   context.CancelFunc
	}{deadline, cancel}
	c.mu.Unlock()
	c.created <- d
	return testDeadline{ctx, deadline}, func() { cancel(); c.mu.Lock(); delete(c.timers, id); c.mu.Unlock() }
}
func (c *testClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	var expired []context.CancelFunc
	for id, timer := range c.timers {
		if !timer.deadline.After(c.now) {
			expired = append(expired, timer.cancel)
			delete(c.timers, id)
		}
	}
	c.mu.Unlock()
	for _, cancel := range expired {
		cancel()
	}
}
func (c *testClock) waitCreated(d time.Duration, n int) {
	for n > 0 {
		if <-c.created == d {
			n--
		}
	}
}

type fakeRaw struct{ err error }

func (r fakeRaw) Control(fn func(uintptr)) error {
	if r.err != nil {
		return r.err
	}
	fn(17)
	return nil
}
func (fakeRaw) Read(func(uintptr) bool) error  { return errors.New("forbidden raw read") }
func (fakeRaw) Write(func(uintptr) bool) error { return errors.New("forbidden raw write") }

type packetReply struct {
	data  []byte
	flags int
	peer  netip.AddrPort
}
type fakeConn struct {
	mu                  sync.Mutex
	local, peer         netip.AddrPort
	udp                 bool
	input               []byte
	written             []byte
	readSize, writeSize int
	readFn              func(*fakeConn) ([]byte, error)
	packetFn            func(*fakeConn) (packetReply, error)
	closeFn             func() error
	closeCount          int
	reads               int
	writes              int
	closeStarted        chan struct{}
	closeOnce           sync.Once
}

func (c *fakeConn) LocalAddr() net.Addr {
	if c.udp {
		return net.UDPAddrFromAddrPort(c.local)
	}
	return net.TCPAddrFromAddrPort(c.local)
}
func (c *fakeConn) RemoteAddr() net.Addr {
	if c.udp {
		return net.UDPAddrFromAddrPort(c.peer)
	}
	return net.TCPAddrFromAddrPort(c.peer)
}
func (c *fakeConn) SetDeadline(time.Time) error      { return nil }
func (c *fakeConn) SetReadDeadline(time.Time) error  { return nil }
func (c *fakeConn) SetWriteDeadline(time.Time) error { return nil }
func (c *fakeConn) bytesWritten() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]byte(nil), c.written...)
}
func (c *fakeConn) Read(p []byte) (int, error) {
	c.mu.Lock()
	c.reads++
	empty := c.input == nil
	fn := c.readFn
	c.mu.Unlock()
	if empty && fn != nil {
		data, err := fn(c)
		if err != nil {
			return 0, err
		}
		c.mu.Lock()
		c.input = data
		c.mu.Unlock()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.input) == 0 {
		return 0, io.EOF
	}
	size := len(p)
	if c.readSize > 0 && size > c.readSize {
		size = c.readSize
	}
	n := copy(p[:size], c.input)
	c.input = c.input[n:]
	return n, nil
}
func (c *fakeConn) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.writes++
	n := len(p)
	if c.writeSize > 0 && n > c.writeSize {
		n = c.writeSize
	}
	c.written = append(c.written, p[:n]...)
	return n, nil
}
func (c *fakeConn) ReadMsgUDPAddrPort(p, oob []byte) (int, int, int, netip.AddrPort, error) {
	c.mu.Lock()
	c.reads++
	fn := c.packetFn
	c.mu.Unlock()
	if fn == nil {
		return 0, 0, 0, netip.AddrPort{}, errors.New("no scripted packet")
	}
	r, err := fn(c)
	if err != nil {
		return 0, 0, 0, netip.AddrPort{}, err
	}
	n := copy(p, r.data)
	flags := r.flags
	if n < len(r.data) {
		flags |= syscall.MSG_TRUNC
	}
	return n, 0, flags, r.peer, nil
}
func (c *fakeConn) Close() error {
	c.mu.Lock()
	c.closeCount++
	fn := c.closeFn
	c.mu.Unlock()
	c.closeOnce.Do(func() { close(c.closeStarted) })
	if fn != nil {
		return fn()
	}
	return nil
}
func (c *fakeConn) closedCount() int { c.mu.Lock(); defer c.mu.Unlock(); return c.closeCount }

type dialRecord struct {
	network     string
	local, peer netip.AddrPort
	device      string
	index       int
	mptcp       bool
}
type fixture struct {
	t                           *testing.T
	clock                       *testClock
	e                           *Egress
	mu                          sync.Mutex
	binding                     Binding
	current                     bool
	policyOK                    bool
	locals                      []netip.Addr
	ports                       Ports
	lifetimeCancel              context.CancelFunc
	records                     []dialRecord
	connections                 []*fakeConn
	devices                     []string
	index                       int
	deviceErr, indexErr, rawErr error
	reply                       func([]byte) ([]byte, error)
	packet                      func(*fakeConn) (packetReply, error)
	tcp                         func(*fakeConn) error
}

func newFixture(t *testing.T, changes ...func(*Binding)) *fixture {
	t.Helper()
	clock := newClock()
	lifetime, cancel := clock.Timeout(context.Background(), 5*time.Minute)
	b := Binding{DeviceID: 1, IfName: "wlan1", IfIndex: 7, PhysicalPath: "/sys/devices/synthetic/radio1", PermanentMAC: "02:00:00:00:00:01", StationMAC: "02:00:00:00:00:01", BSSID: "02:00:00:00:01:01", BusID: "0123456789abcdef0123456789abcdef", NMOwner: ":1.42", ActivationPath: "/org/freedesktop/NetworkManager/ActiveConnection/1", ProfileUUID: "00000000-0000-4000-8000-000000000001", Source: netip.MustParseAddr("192.0.2.10"), Gateway: netip.MustParseAddr("192.0.2.1"), DNS: []netip.Addr{netip.MustParseAddr("192.0.2.1")}, PrefixLength: 24, RouteTable: 101, RouteMetric: 10}
	for _, change := range changes {
		change(&b)
	}
	f := &fixture{t: t, clock: clock, binding: b, current: true, policyOK: true, locals: []netip.Addr{b.Source, netip.MustParseAddr("198.51.100.1")}, index: b.IfIndex, lifetimeCancel: cancel}
	f.reply = func(q []byte) ([]byte, error) { return response(q, false, record{ip: "203.0.113.10"}), nil }
	f.ports = Ports{
		Now: clock.Now, Timeout: clock.Timeout, ID: func() (uint16, error) { return 0x1234, nil },
		SetDevice: func(_ uintptr, name string) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.devices = append(f.devices, name)
			return f.deviceErr
		},
		BoundIndex: func(uintptr) (int, error) { f.mu.Lock(); defer f.mu.Unlock(); return f.index, f.indexErr },
	}
	f.ports.UDP = func(ctx context.Context, d *net.Dialer, local, peer netip.AddrPort) (Datagram, error) {
		c, err := f.connect(ctx, d, local, peer, true)
		if c == nil {
			return nil, &DialFailure{Reason: classify(err), ClosureAcknowledged: true}
		}
		return c, err
	}
	f.ports.TCP = func(ctx context.Context, d *net.Dialer, local, peer netip.AddrPort) (Conn, error) {
		c, err := f.connect(ctx, d, local, peer, false)
		if c == nil {
			return nil, &DialFailure{Reason: classify(err), ClosureAcknowledged: true}
		}
		return c, err
	}
	owner := Authority{Lifetime: lifetime, Current: func(got Binding) bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.current && reflect.DeepEqual(got, f.binding)
	}}
	policy := func() (PolicySnapshot, bool) {
		f.mu.Lock()
		defer f.mu.Unlock()
		return PolicySnapshot{LocalIPv4: append([]netip.Addr(nil), f.locals...), AllowedTCPPorts: []uint16{80, 443}}, f.policyOK
	}
	var code Code
	f.e, code = New(b, owner, policy, f.ports)
	if code != OK {
		t.Fatalf("fixture setup: %s", code)
	}
	t.Cleanup(func() {
		f.lifetimeCancel()
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		f.e.Close(ctx)
	})
	return f
}

func (f *fixture) connect(ctx context.Context, d *net.Dialer, local, peer netip.AddrPort, udp bool) (*fakeConn, error) {
	f.mu.Lock()
	rawErr := f.rawErr
	f.mu.Unlock()
	network := "tcp4"
	if udp {
		network = "udp4"
	}
	if d.ControlContext == nil {
		return nil, errors.New("missing device control")
	}
	if err := d.ControlContext(ctx, network, peer.String(), fakeRaw{rawErr}); err != nil {
		return nil, fmt.Errorf("private transport detail: %w", err)
	}
	f.mu.Lock()
	b := cloneBinding(f.binding)
	device := f.devices[len(f.devices)-1]
	index := f.index
	f.mu.Unlock()
	if local.Addr() != b.Source || local.Port() != 0 || d.MultipathTCP() {
		return nil, errors.New("invalid selected source or MPTCP")
	}
	c := &fakeConn{local: netip.AddrPortFrom(local.Addr(), 41000), peer: peer, udp: udp, closeStarted: make(chan struct{})}
	if udp {
		c.packetFn = func(c *fakeConn) (packetReply, error) {
			f.mu.Lock()
			fn := f.packet
			reply := f.reply
			f.mu.Unlock()
			if fn != nil {
				return fn(c)
			}
			data, err := reply(c.bytesWritten())
			return packetReply{data: data, peer: c.peer}, err
		}
	} else if peer.Port() == 53 {
		c.readSize = 3
		c.writeSize = 2
		c.readFn = func(c *fakeConn) ([]byte, error) {
			written := c.bytesWritten()
			if len(written) < 2 {
				return nil, io.ErrUnexpectedEOF
			}
			f.mu.Lock()
			reply := f.reply
			f.mu.Unlock()
			data, err := reply(written[2:])
			if err != nil {
				return nil, err
			}
			framed := make([]byte, 2+len(data))
			binary.BigEndian.PutUint16(framed, uint16(len(data)))
			copy(framed[2:], data)
			return framed, nil
		}
	} else {
		c.input = []byte("response")
	}
	f.mu.Lock()
	f.records = append(f.records, dialRecord{network, local, peer, device, index, d.MultipathTCP()})
	f.connections = append(f.connections, c)
	hook := f.tcp
	f.mu.Unlock()
	if !udp && hook != nil {
		if err := hook(c); err != nil {
			return c, err
		}
	}
	return c, nil
}
func (f *fixture) mutate(fn func()) { f.mu.Lock(); defer f.mu.Unlock(); fn() }
func (f *fixture) snapshot() ([]dialRecord, []*fakeConn) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]dialRecord(nil), f.records...), append([]*fakeConn(nil), f.connections...)
}
func (f *fixture) dial(host string) (*Stream, Code) { return f.e.Dial(context.Background(), host, 443) }

type record struct{ owner, ip, target string }

func question(q []byte) (dnsmessage.Header, dnsmessage.Question) {
	var p dnsmessage.Parser
	h, err := p.Start(q)
	if err != nil {
		panic(err)
	}
	x, err := p.Question()
	if err != nil {
		panic(err)
	}
	return h, x
}
func response(q []byte, truncated bool, records ...record) []byte {
	h, x := question(q)
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: h.ID, Response: true, RecursionDesired: true, RecursionAvailable: true, Truncated: truncated})
	if err := b.StartQuestions(); err != nil {
		panic(err)
	}
	if err := b.Question(x); err != nil {
		panic(err)
	}
	if err := b.StartAnswers(); err != nil {
		panic(err)
	}
	for _, r := range records {
		owner := x.Name
		if r.owner != "" {
			owner = dnsmessage.MustNewName(r.owner)
		}
		hdr := dnsmessage.ResourceHeader{Name: owner, Class: dnsmessage.ClassINET, TTL: 60}
		var err error
		if r.target != "" {
			hdr.Type = dnsmessage.TypeCNAME
			err = b.CNAMEResource(hdr, dnsmessage.CNAMEResource{CNAME: dnsmessage.MustNewName(r.target)})
		} else {
			hdr.Type = dnsmessage.TypeA
			err = b.AResource(hdr, dnsmessage.AResource{A: netip.MustParseAddr(r.ip).As4()})
		}
		if err != nil {
			panic(err)
		}
	}
	msg, err := b.Finish()
	if err != nil {
		panic(err)
	}
	return msg
}
func rawA(q []byte, length uint16) []byte {
	msg := append([]byte(nil), q...)
	binary.BigEndian.PutUint16(msg[2:4], 0x8180)
	binary.BigEndian.PutUint16(msg[6:8], 1)
	rr := []byte{0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 203, 0, 113, 10}
	binary.BigEndian.PutUint16(rr[10:12], length)
	return append(msg, rr...)
}
func assertCode(t *testing.T, got, want Code) {
	t.Helper()
	if got != want {
		t.Fatalf("code %q, want %q", got, want)
	}
}

func TestBoundDomainUsesRealCodecAndNumericTransports(t *testing.T) {
	f := newFixture(t)
	s, code := f.dial("Portal.Example")
	assertCode(t, code, OK)
	if s == nil {
		t.Fatal("missing real-composition stream")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	r, cs := f.snapshot()
	if len(r) != 2 || r[0].network != "udp4" || r[0].peer.Port() != 53 || r[1].peer != netip.MustParseAddrPort("203.0.113.10:443") {
		t.Fatalf("unexpected numeric transport records: %v", r)
	}
	for _, d := range r {
		if d.device != "wlan1" || d.index != 7 || d.local.Addr() != f.binding.Source || d.mptcp {
			t.Fatal("binding missing")
		}
	}
	for _, c := range cs {
		if c.closedCount() != 1 {
			t.Fatal("resource closure was not acknowledged once")
		}
	}
}

func TestNumericLiteralAvoidsEveryDNSPath(t *testing.T) {
	f := newFixture(t)
	s, code := f.dial("203.0.113.10")
	assertCode(t, code, OK)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	r, _ := f.snapshot()
	if len(r) != 1 || r[0].network != "tcp4" {
		t.Fatal("literal entered DNS")
	}
}

func TestTCPTruncationRetryHasSameBindingAndHandlesPartialFraming(t *testing.T) {
	f := newFixture(t)
	f.mutate(func() {
		f.packet = func(c *fakeConn) (packetReply, error) {
			return packetReply{data: response(c.bytesWritten(), true), peer: c.peer}, nil
		}
	})
	s, code := f.dial("portal.example")
	assertCode(t, code, OK)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	r, cs := f.snapshot()
	if len(r) != 3 || r[0].network != "udp4" || r[1].network != "tcp4" || r[1].peer != r[0].peer || cs[1].writes < 2 || cs[1].reads < 2 {
		t.Fatal("missing bounded partial TCP DNS retry")
	}
	for _, d := range r {
		if d.local.Addr() != f.binding.Source || d.device != "wlan1" {
			t.Fatal("retry lost source/device")
		}
	}
}

func TestMultipleAnswersRetainWireOrderAndEachPolicyCheck(t *testing.T) {
	f := newFixture(t)
	f.mutate(func() {
		f.reply = func(q []byte) ([]byte, error) {
			return response(q, false, record{ip: "203.0.113.20"}, record{ip: "203.0.113.10"}, record{ip: "203.0.113.20"}), nil
		}
		f.tcp = func(c *fakeConn) error {
			if c.peer.Addr() == netip.MustParseAddr("203.0.113.20") {
				return errors.New("first candidate refused")
			}
			return nil
		}
	})
	s, code := f.dial("localhost.example")
	assertCode(t, code, OK)
	if s.peer.Addr() != netip.MustParseAddr("203.0.113.10") {
		t.Fatal("wrong successful peer")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	r, _ := f.snapshot()
	if len(r) != 3 || r[1].peer.Addr() != netip.MustParseAddr("203.0.113.20") {
		t.Fatal("unexpected answer sorting or deduplication")
	}
}

func TestOutOfOrderCNAMEAndFreshAliasQuery(t *testing.T) {
	for _, samePacket := range []bool{true, false} {
		t.Run(fmt.Sprint(samePacket), func(t *testing.T) {
			f := newFixture(t)
			var names []string
			f.mutate(func() {
				f.reply = func(q []byte) ([]byte, error) {
					_, x := question(q)
					names = append(names, x.Name.String())
					if x.Name.String() == "portal.example." {
						if samePacket {
							return response(q, false, record{owner: "final.example.", ip: "203.0.113.10"}, record{target: "final.example."}), nil
						}
						return response(q, false, record{target: "final.example."}), nil
					}
					return response(q, false, record{ip: "203.0.113.10"}), nil
				}
			})
			s, code := f.dial("portal.example")
			assertCode(t, code, OK)
			if err := s.Close(); err != nil {
				t.Fatal(err)
			}
			want := 1
			if !samePacket {
				want = 2
			}
			if len(names) != want {
				t.Fatalf("queries %v", names)
			}
		})
	}
}

func TestAliasConflictLoopLimitAndUnsupportedAnswers(t *testing.T) {
	for _, kind := range []string{"conflict", "loop", "mixed", "limit", "nodata", "many"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			calls := 0
			f.mutate(func() {
				f.reply = func(q []byte) ([]byte, error) {
					calls++
					switch kind {
					case "conflict":
						return response(q, false, record{target: "a.example."}, record{target: "b.example."}), nil
					case "loop":
						return response(q, false, record{target: "PORTAL.example."}), nil
					case "mixed":
						return response(q, false, record{target: "a.example."}, record{ip: "203.0.113.10"}), nil
					case "limit":
						return response(q, false, record{target: fmt.Sprintf("alias%d.example.", calls)}), nil
					case "many":
						return response(q, false, record{ip: "203.0.113.1"}, record{ip: "203.0.113.2"}, record{ip: "203.0.113.3"}, record{ip: "203.0.113.4"}, record{ip: "203.0.113.5"}), nil
					default:
						return response(q, false), nil
					}
				}
			})
			_, code := f.dial("portal.example")
			if code != InvalidDNS && code != BudgetExceeded {
				t.Fatalf("accepted %s: %s", kind, code)
			}
			r, _ := f.snapshot()
			for _, d := range r {
				if d.peer.Port() != 53 {
					t.Fatal("invalid answer reached application dial")
				}
			}
			if calls > 5 {
				t.Fatal("unbounded aliases")
			}
		})
	}
}

func TestMalformedDNSHeaderCompressionSpansAndLengthsRefuse(t *testing.T) {
	for _, kind := range []string{"id", "question", "reserved", "opcode", "response", "rcode", "trailing", "recordcount", "Ashort", "Along", "pointer", "CNAMEspan", "OPT", "AAAA", "oversize", "truncated-kernel"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			f.mutate(func() {
				f.packet = func(c *fakeConn) (packetReply, error) {
					q := c.bytesWritten()
					msg := rawA(q, 4)
					flags := 0
					switch kind {
					case "id":
						msg[0] ^= 1
					case "question":
						msg[13] ^= 1
					case "reserved":
						msg[3] |= 0x40
					case "opcode":
						msg[2] |= 0x08
					case "response":
						msg[2] &= 0x7f
					case "rcode":
						msg[3] |= 3
					case "trailing":
						msg = append(msg, 0)
					case "recordcount":
						binary.BigEndian.PutUint16(msg[6:8], 65)
					case "Ashort":
						msg = rawA(q, 3)
					case "Along":
						msg = rawA(q, 5)
						msg = append(msg, 0)
					case "pointer":
						msg[len(q)+1] = byte(len(q))
					case "CNAMEspan":
						msg = rawA(q, 1)
						binary.BigEndian.PutUint16(msg[len(q)+2:len(q)+4], uint16(dnsmessage.TypeCNAME))
					case "OPT":
						binary.BigEndian.PutUint16(msg[len(q)+2:len(q)+4], uint16(dnsmessage.TypeOPT))
					case "AAAA":
						binary.BigEndian.PutUint16(msg[len(q)+2:len(q)+4], uint16(dnsmessage.TypeAAAA))
					case "oversize":
						msg = append(msg, make([]byte, 513)...)
					case "truncated-kernel":
						flags = syscall.MSG_TRUNC
					}
					return packetReply{msg, flags, c.peer}, nil
				}
			})
			_, code := f.dial("portal.example")
			assertCode(t, code, InvalidDNS)
			r, _ := f.snapshot()
			for _, d := range r {
				if d.peer.Port() != 53 {
					t.Fatal("malformed reply reached TCP destination")
				}
			}
		})
	}
}

func TestWrongUDPPeerHasFiniteDiscardBudget(t *testing.T) {
	f := newFixture(t)
	count := 0
	f.mutate(func() {
		f.packet = func(c *fakeConn) (packetReply, error) {
			count++
			return packetReply{data: response(c.bytesWritten(), false, record{ip: "203.0.113.10"}), peer: netip.MustParseAddrPort("192.0.2.2:53")}, nil
		}
	})
	_, code := f.dial("portal.example")
	assertCode(t, code, InvalidDNS)
	if count != 5 {
		t.Fatalf("discard count %d", count)
	}
}

func TestTCPDNSLengthAndEOFRefuse(t *testing.T) {
	for _, kind := range []string{"large", "short", "tc", "id"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			f.mutate(func() {
				f.packet = func(c *fakeConn) (packetReply, error) {
					return packetReply{data: response(c.bytesWritten(), true), peer: c.peer}, nil
				}
				f.tcp = func(c *fakeConn) error {
					if c.peer.Port() != 53 {
						return nil
					}
					c.readFn = nil
					switch kind {
					case "large":
						c.input = []byte{0xff, 0xff}
					case "short":
						c.input = []byte{0}
					case "tc", "id":
						q, _ := query("portal.example.", 0x1234)
						data := response(q, kind == "tc", record{ip: "203.0.113.10"})
						if kind == "id" {
							data[0] ^= 1
						}
						c.input = make([]byte, 2+len(data))
						binary.BigEndian.PutUint16(c.input, uint16(len(data)))
						copy(c.input[2:], data)
					}
					return nil
				}
			})
			_, code := f.dial("portal.example")
			if code == OK {
				t.Fatal("bad TCP DNS accepted")
			}
			r, _ := f.snapshot()
			if len(r) != 2 {
				t.Fatalf("unexpected fallback count %d", len(r))
			}
		})
	}
}

func TestDeniedDNSAndTerminalCandidatesNeverConnect(t *testing.T) {
	for _, target := range []string{"127.0.0.1", "0.0.0.0", "169.254.169.254", "224.0.0.1", "255.255.255.255", "192.0.2.10", "198.51.100.1", "192.0.2.255", "192.0.2.0", "::1", "::ffff:203.0.113.10"} {
		t.Run(target, func(t *testing.T) {
			f := newFixture(t)
			_, code := f.dial(target)
			assertCode(t, code, PolicyDenied)
			r, _ := f.snapshot()
			if len(r) != 0 {
				t.Fatal("denied literal dialed")
			}
		})
	}
	f := newFixture(t)
	f.mutate(func() { f.locals = append(f.locals, f.binding.DNS[0]) })
	_, code := f.dial("portal.example")
	assertCode(t, code, PolicyDenied)
	r, _ := f.snapshot()
	if len(r) != 0 {
		t.Fatal("box-local DNS peer dialed")
	}
	g := newFixture(t)
	g.mutate(func() {
		g.reply = func(q []byte) ([]byte, error) {
			return response(q, false, record{ip: "203.0.113.10"}, record{ip: "127.0.0.1"}), nil
		}
	})
	_, code = g.dial("portal.example")
	assertCode(t, code, PolicyDenied)
	r, _ = g.snapshot()
	if len(r) != 1 {
		t.Fatal("mixed denied answer dialed")
	}
}

func TestMissingAuthorityPolicyAndSocketControlRefuse(t *testing.T) {
	f := newFixture(t)
	_, code := New(f.binding, Authority{}, nil, Ports{})
	assertCode(t, code, Unavailable)
	for _, kind := range []string{"current", "policy", "setdevice", "readback", "index", "rawcontrol"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			f.mutate(func() {
				switch kind {
				case "current":
					f.current = false
				case "policy":
					f.policyOK = false
				case "setdevice":
					f.deviceErr = errors.New("permission denied SECRET")
				case "readback":
					f.indexErr = errors.New("unsupported SECRET")
				case "index":
					f.index = 8
				case "rawcontrol":
					f.rawErr = errors.New("control failure SECRET")
				}
			})
			_, code := f.dial("203.0.113.10")
			if code == OK {
				t.Fatal("missing authority/control accepted")
			}
			r, _ := f.snapshot()
			if len(r) != 0 {
				t.Fatal("failed binding transmitted")
			}
		})
	}
}

func TestFreshBindingAndPolicyCheckedAfterAwaitedConnect(t *testing.T) {
	for _, kind := range []string{"owner", "bus", "activation", "source", "dns", "policy"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			f.mutate(func() {
				f.tcp = func(c *fakeConn) error {
					f.mutate(func() {
						switch kind {
						case "owner":
							f.binding.NMOwner = ":1.43"
						case "bus":
							f.binding.BusID = "1123456789abcdef0123456789abcdef"
						case "activation":
							f.binding.ActivationPath = "/org/freedesktop/NetworkManager/ActiveConnection/2"
						case "source":
							f.binding.Source = netip.MustParseAddr("192.0.2.20")
						case "dns":
							f.binding.DNS = []netip.Addr{netip.MustParseAddr("192.0.2.2")}
						case "policy":
							f.locals = append(f.locals, c.peer.Addr())
						}
					})
					return nil
				}
			})
			_, code := f.dial("203.0.113.10")
			if code != BindingChanged && code != PolicyDenied {
				t.Fatalf("wrong refusal %s", code)
			}
			_, cs := f.snapshot()
			for _, c := range cs {
				if c.closedCount() != 1 {
					t.Fatal("late stale connection not closed")
				}
			}
		})
	}
}

func TestDuplicateAddressDevicesAndMutationOfCapturedSlice(t *testing.T) {
	a := newFixture(t)
	b := newFixture(t, func(b *Binding) {
		b.DeviceID = 2
		b.IfName = "wlan2"
		b.IfIndex = 8
		b.PhysicalPath = "/sys/devices/synthetic/radio2"
		b.PermanentMAC = "02:00:00:00:00:02"
		b.StationMAC = "02:00:00:00:00:02"
	})
	x, c := a.dial("203.0.113.10")
	assertCode(t, c, OK)
	y, c := b.dial("203.0.113.10")
	assertCode(t, c, OK)
	if err := x.Close(); err != nil {
		t.Fatal(err)
	}
	if err := y.Close(); err != nil {
		t.Fatal(err)
	}
	ar, _ := a.snapshot()
	br, _ := b.snapshot()
	if ar[0].local != br[0].local || ar[0].device == br[0].device || ar[0].index == br[0].index {
		t.Fatal("duplicate-address bindings collapsed")
	}
	a.mutate(func() { a.binding.DNS[0] = netip.MustParseAddr("192.0.2.99") })
	if a.e.binding.DNS[0] == a.binding.DNS[0] {
		t.Fatal("input DNS slice retained")
	}
}

func TestLateDialAfterCancellationIsOwnedUntilAcknowledged(t *testing.T) {
	f := newFixture(t)
	started := make(chan struct{})
	release := make(chan struct{})
	f.mutate(func() { f.tcp = func(*fakeConn) error { close(started); <-release; return nil } })
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan Code, 1)
	go func() { _, code := f.e.Dial(ctx, "203.0.113.10", 443); result <- code }()
	<-started
	cancel()
	f.clock.waitCreated(closeLimit, 1)
	f.clock.Advance(2 * time.Second)
	assertCode(t, <-result, CleanupUnknown)
	assertCode(t, f.e.Status(), CleanupUnknown)
	f.mutate(func() { f.tcp = nil })
	replacement, code := f.dial("203.0.113.20")
	assertCode(t, code, OK)
	_, cs := f.snapshot()
	close(release)
	<-cs[0].closeStarted
	buf := make([]byte, 8)
	if _, err := replacement.Read(buf); err != nil {
		t.Fatal(err)
	}
	if err := replacement.Close(); err != nil {
		t.Fatal(err)
	}
	// Close waits for the late dial's pending count as well as Close itself.
	assertCode(t, f.e.Close(context.Background()), Closed)
	if cs[0].closedCount() != 1 {
		t.Fatal("late connection closure count")
	}
}

func TestBlockedDNSDoesNotPublishAfterOwnerExpiry(t *testing.T) {
	f := newFixture(t)
	started := make(chan struct{})
	release := make(chan struct{})
	f.mutate(func() {
		f.packet = func(c *fakeConn) (packetReply, error) {
			close(started)
			<-release
			return packetReply{data: response(c.bytesWritten(), false, record{ip: "203.0.113.10"}), peer: c.peer}, nil
		}
	})
	result := make(chan Code, 1)
	go func() { _, code := f.dial("portal.example"); result <- code }()
	<-started
	f.lifetimeCancel()
	f.clock.waitCreated(closeLimit, 2)
	f.clock.Advance(2 * time.Second)
	assertCode(t, <-result, CleanupUnknown)
	close(release)
	assertCode(t, f.e.Close(context.Background()), Closed)
	r, _ := f.snapshot()
	if len(r) != 1 {
		t.Fatal("late DNS opened application connection")
	}
}

func TestCloseErrorPreservesUnknownAndStopsLeaseReuse(t *testing.T) {
	f := newFixture(t)
	f.mutate(func() {
		f.tcp = func(c *fakeConn) error {
			c.closeFn = func() error { return errors.New("COOKIE_SENTINEL close") }
			return nil
		}
	})
	s, code := f.dial("203.0.113.10")
	assertCode(t, code, OK)
	result := make(chan error, 1)
	go func() { result <- s.Close() }()
	f.clock.waitCreated(closeLimit, 1)
	_, cs := f.snapshot()
	<-cs[0].closeStarted
	f.clock.Advance(2 * time.Second)
	err := <-result
	if err != CleanupUnknown {
		t.Fatalf("close result %v", err)
	}
	assertCode(t, f.e.Status(), CleanupUnknown)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	assertCode(t, f.e.Close(ctx), CleanupUnknown)
	_, code = f.dial("203.0.113.10")
	assertCode(t, code, Unavailable)
}

func TestStreamsKeepLifetimeAndPrivateReadBuffers(t *testing.T) {
	f := newFixture(t)
	s, code := f.dial("203.0.113.10")
	assertCode(t, code, OK)
	_, cs := f.snapshot()
	c := cs[0]
	started := make(chan struct{})
	release := make(chan struct{})
	c.mu.Lock()
	c.input = nil
	c.readFn = func(*fakeConn) ([]byte, error) { close(started); <-release; return []byte("late"), nil }
	c.mu.Unlock()
	buf := bytes.Repeat([]byte{'x'}, 4)
	done := make(chan error, 1)
	go func() { _, err := s.Read(buf); done <- err }()
	<-started
	f.lifetimeCancel()
	if err := <-done; err == nil {
		t.Fatal("expired stream read exposed")
	}
	if string(buf) != "xxxx" {
		t.Fatal("caller buffer mutated after cancellation")
	}
	close(release)
	assertCode(t, f.e.Close(context.Background()), Closed)
}

func TestDeadlineByteRecordResultAndSlotBudgets(t *testing.T) {
	f := newFixture(t)
	o := &operation{e: f.e}
	if !o.charge(maxDNSBytes) || o.charge(1) {
		t.Fatal("aggregate byte limit")
	}
	g := newFixture(t)
	g.mutate(func() {
		g.reply = func(q []byte) ([]byte, error) {
			g.clock.Advance(11 * time.Second)
			return response(q, false, record{ip: "203.0.113.10"}), nil
		}
	})
	_, code := g.dial("portal.example")
	if code == OK {
		t.Fatal("elapsed budget accepted")
	}
	h := newFixture(t)
	var streams []*Stream
	for i := 0; i < 8; i++ {
		s, code := h.dial("203.0.113.10")
		assertCode(t, code, OK)
		streams = append(streams, s)
	}
	_, code = h.dial("203.0.113.10")
	assertCode(t, code, Unavailable)
	for _, s := range streams {
		if err := s.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestOnlyFixedErrorCategoriesEscape(t *testing.T) {
	f := newFixture(t)
	sentinel := "https://portal.invalid/?TOKEN_SENTINEL COOKIE_SENTINEL CREDENTIAL_SENTINEL ERROR_SENTINEL"
	f.mutate(func() { f.reply = func([]byte) ([]byte, error) { return nil, errors.New(sentinel) } })
	_, code := f.dial("portal.example")
	if strings.Contains(string(code), "SENTINEL") {
		t.Fatal("raw error escaped")
	}
	assertCode(t, code, TransportFailed)
	if classify(Code(sentinel)) != TransportFailed {
		t.Fatal("untrusted error category escaped")
	}
}

func TestSourceHasOnlyExplicitNumericNativeEntry(t *testing.T) {
	data, err := os.ReadFile("egress_linux.go")
	if err != nil {
		t.Fatal(err)
	}
	file, err := parser.ParseFile(token.NewFileSet(), "egress_linux.go", data, 0)
	if err != nil {
		t.Fatal(err)
	}
	allowedImports := map[string]bool{"context": true, "crypto/rand": true, "encoding/binary": true, "errors": true, "io": true, "net": true, "net/netip": true, "strings": true, "sync": true, "syscall": true, "time": true, "portal-egress/internal/dnsmessage": true}
	for _, spec := range file.Imports {
		if !allowedImports[strings.Trim(spec.Path.Value, "\"")] {
			t.Errorf("unreviewed production import %s", spec.Path.Value)
		}
	}
	forbidden := map[string]bool{"Resolver": true, "DefaultResolver": true, "DialContext": true, "LookupIP": true, "LookupNetIP": true, "LookupHost": true, "LookupIPAddr": true, "ResolveTCPAddr": true, "ResolveUDPAddr": true, "Listen": true, "ListenUDP": true, "ListenTCP": true, "DialIP": true}
	inspect := func(node ast.Node, scope string) map[string]int {
		counts := make(map[string]int)
		ast.Inspect(node, func(n ast.Node) bool {
			if call, ok := n.(*ast.CallExpr); ok {
				if sel, ok := call.Fun.(*ast.SelectorExpr); ok {
					if pkg, ok := sel.X.(*ast.Ident); ok {
						if pkg.Name == "net" {
							t.Errorf("package-level socket/lookup call %s", sel.Sel.Name)
						}
						if pkg.Name == "syscall" && (scope != "LinuxPorts" || (sel.Sel.Name != "SetsockoptString" && sel.Sel.Name != "GetsockoptInt")) {
							t.Errorf("unowned syscall %s", sel.Sel.Name)
						}
					}
				}
			}
			sel, ok := n.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			counts[sel.Sel.Name]++
			if forbidden[sel.Sel.Name] {
				t.Errorf("forbidden path %s in %s", sel.Sel.Name, scope)
			}
			if sel.Sel.Name == "DialTCP" || sel.Sel.Name == "DialUDP" || sel.Sel.Name == "SetsockoptString" || sel.Sel.Name == "GetsockoptInt" {
				if scope != "LinuxPorts" {
					t.Errorf("native entry outside explicit factory in %s", scope)
				}
			}
			if sel.Sel.Name == "Dial" {
				if id, ok := sel.X.(*ast.Ident); ok && id.Name == "net" {
					t.Error("package-level string dial")
				}
			}
			return true
		})
		return counts
	}
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok {
			if gen, ok := decl.(*ast.GenDecl); ok && gen.Tok == token.VAR {
				inspect(gen, "package initializer")
			}
			continue
		}
		counts := inspect(fn.Body, fn.Name.Name)
		if fn.Name.Name == "dial" {
			for _, gate := range []string{"check", "permitted", "track"} {
				if counts[gate] == 0 {
					t.Errorf("dial lost %s gate", gate)
				}
			}
			if counts["permitted"] < 2 || counts["check"] < 2 {
				t.Error("dial lost pre/post checks")
			}
		}
		if fn.Name.Name == "control" {
			for _, gate := range []string{"check", "SetDevice", "BoundIndex"} {
				if counts[gate] == 0 {
					t.Errorf("control lost %s", gate)
				}
			}
		}
		if fn.Recv != nil && len(fn.Recv.List) > 0 {
			if star, ok := fn.Recv.List[0].Type.(*ast.StarExpr); ok {
				if id, ok := star.X.(*ast.Ident); ok && id.Name == "Stream" && (fn.Name.Name == "Read" || fn.Name.Name == "Write") {
					if counts["check"] < 2 || counts["beginClose"] == 0 {
						t.Error("stream lost lifetime checks")
					}
				}
			}
		}
	}
}

func TestRequiredBindingFieldsAndNativeFactoryAreExplicit(t *testing.T) {
	f := newFixture(t)
	cases := []func(*Binding){func(b *Binding) { b.BusID = "" }, func(b *Binding) { b.NMOwner = "" }, func(b *Binding) { b.ActivationPath = "" }, func(b *Binding) { b.ProfileUUID = "" }, func(b *Binding) { b.PhysicalPath = "" }, func(b *Binding) { b.IfIndex = 0 }, func(b *Binding) { b.Source = netip.Addr{} }, func(b *Binding) { b.DNS = nil }, func(b *Binding) { b.StationMAC = "" }, func(b *Binding) { b.PermanentMAC = "" }, func(b *Binding) { b.BSSID = "" }}
	for _, mutate := range cases {
		b := cloneBinding(f.binding)
		mutate(&b)
		_, code := New(b, f.e.owner, f.e.policy, f.ports)
		assertCode(t, code, Unavailable)
	}
	_, code := New(f.binding, Authority{Lifetime: context.Background(), Current: func(Binding) bool { return true }}, f.e.policy, f.ports)
	assertCode(t, code, Unavailable)
	native := LinuxPorts()
	if native.TCP == nil || native.UDP == nil || native.SetDevice == nil || native.BoundIndex == nil {
		t.Fatal("explicit factory omitted function references")
	}
}

func TestUnacknowledgedFailedDialRemainsUnknown(t *testing.T) {
	f := newFixture(t)
	f.e.ports.TCP = func(context.Context, *net.Dialer, netip.AddrPort, netip.AddrPort) (Conn, error) {
		return nil, &DialFailure{Reason: TransportFailed}
	}
	result := make(chan Code, 1)
	go func() { _, code := f.dial("203.0.113.10"); result <- code }()
	f.clock.waitCreated(closeLimit, 1)
	f.clock.Advance(2 * time.Second)
	assertCode(t, <-result, CleanupUnknown)
	assertCode(t, f.e.Status(), CleanupUnknown)
}

func TestControlCreationBudgetAndPerRetryDestinationCheck(t *testing.T) {
	f := newFixture(t)
	f.e.ports.TCP = func(ctx context.Context, d *net.Dialer, local, peer netip.AddrPort) (Conn, error) {
		for i := 0; i < 33; i++ {
			if err := d.ControlContext(ctx, "tcp4", peer.String(), fakeRaw{}); err != nil {
				return nil, &DialFailure{Reason: classify(err), ClosureAcknowledged: true}
			}
		}
		return nil, errors.New("budget guard missed")
	}
	_, code := f.dial("203.0.113.10")
	assertCode(t, code, BudgetExceeded)
	g := newFixture(t)
	g.e.ports.TCP = func(ctx context.Context, d *net.Dialer, local, peer netip.AddrPort) (Conn, error) {
		if err := d.ControlContext(ctx, "tcp4", peer.String(), fakeRaw{}); err != nil {
			return nil, &DialFailure{Reason: classify(err), ClosureAcknowledged: true}
		}
		g.mutate(func() { g.locals = append(g.locals, peer.Addr()) })
		err := d.ControlContext(ctx, "tcp4", peer.String(), fakeRaw{})
		return nil, &DialFailure{Reason: classify(err), ClosureAcknowledged: true}
	}
	_, code = g.dial("203.0.113.10")
	assertCode(t, code, PolicyDenied)
}

func TestAdditionalAddressesCannotSupplyOrReplaceTheAnswer(t *testing.T) {
	for _, onlyAdditional := range []bool{true, false} {
		t.Run(fmt.Sprint(onlyAdditional), func(t *testing.T) {
			f := newFixture(t)
			f.mutate(func() {
				f.reply = func(q []byte) ([]byte, error) {
					msg := rawA(q, 4)
					if onlyAdditional {
						binary.BigEndian.PutUint16(msg[6:8], 0)
						binary.BigEndian.PutUint16(msg[10:12], 1)
					} else {
						extra := rawA(q, 4)[len(q):]
						extra = append([]byte(nil), extra...)
						copy(extra[len(extra)-4:], []byte{127, 0, 0, 1})
						msg = append(msg, extra...)
						binary.BigEndian.PutUint16(msg[10:12], 1)
					}
					return msg, nil
				}
			})
			s, code := f.dial("portal.example")
			if onlyAdditional {
				assertCode(t, code, InvalidDNS)
			} else {
				assertCode(t, code, OK)
				if s.peer.Addr() != netip.MustParseAddr("203.0.113.10") {
					t.Fatal("additional answer substituted")
				}
				if err := s.Close(); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestClockRollbackAndIDFailureRefuseBeforeTransport(t *testing.T) {
	f := newFixture(t)
	f.clock.Advance(-time.Second)
	_, code := f.dial("203.0.113.10")
	assertCode(t, code, BindingChanged)
	r, _ := f.snapshot()
	if len(r) != 0 {
		t.Fatal("rollback reached transport")
	}
	g := newFixture(t)
	g.e.ports.ID = func() (uint16, error) { return 0, errors.New("URL_SECRET_SENTINEL") }
	_, code = g.dial("portal.example")
	assertCode(t, code, Unavailable)
	r, _ = g.snapshot()
	if len(r) != 0 {
		t.Fatal("missing ID reached transport")
	}
}
