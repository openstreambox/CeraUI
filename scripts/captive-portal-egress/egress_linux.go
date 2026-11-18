//go:build linux

// Package portalegress provides explicit, selected-device IPv4 transport.
// Callers supply authoritative binding/lifetime observations and destination
// policy. Those observations do not establish continuous kernel containment.
package portalegress

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/netip"
	"strings"
	"sync"
	"syscall"
	"time"

	"portal-egress/internal/dnsmessage"
)

type Code string

const (
	OK              Code = "ok"
	Unavailable     Code = "unavailable"
	BindingChanged  Code = "binding_changed"
	PolicyDenied    Code = "policy_denied"
	InvalidDNS      Code = "invalid_dns"
	BudgetExceeded  Code = "budget_exceeded"
	Cancelled       Code = "cancelled"
	TransportFailed Code = "transport_failed"
	Closing         Code = "closing"
	CleanupUnknown  Code = "cleanup_unknown"
	Closed          Code = "closed"
)

func (c Code) Error() string { return string(c) }

const (
	operationLimit = 10 * time.Second
	attemptLimit   = 2 * time.Second
	closeLimit     = time.Second
	streamIOLimit  = 30 * time.Second
	maxDNSBytes    = 64 * 1024
	maxTCPMessage  = 8192
	maxRecords     = 64
	maxChunk       = 64 * 1024
	// Linux UAPI asm-generic/socket.h. Unsupported readback must refuse.
	soBindToIfIndex = 62
)

// Binding is a value copied from an authoritative immutable capture. Profile
// UUID alone is insufficient identity. DNS is copied at every trust boundary.
type Binding struct {
	DeviceID       uint64
	IfName         string
	IfIndex        int
	PhysicalPath   string
	PermanentMAC   string
	StationMAC     string
	BSSID          string
	BusID          string
	NMOwner        string
	ActivationPath string
	ProfileUUID    string
	Source         netip.Addr
	Gateway        netip.Addr
	DNS            []netip.Addr
	PrefixLength   int
	RouteTable     uint32
	RouteMetric    uint32
}

// Current must be a nonblocking fresh owner observation. IPC and authoritative
// native capture belong to the caller. Its lifetime must expire within 5 min.
type Authority struct {
	Lifetime context.Context
	Current  func(Binding) bool
}

type PolicySnapshot struct {
	LocalIPv4       []netip.Addr
	AllowedTCPPorts []uint16
}

// Policy must return a fresh, owned immutable box-local address snapshot,
// including Source. The callback must be nonblocking.
type Policy func() (PolicySnapshot, bool)

type Conn interface {
	io.ReadWriteCloser
	LocalAddr() net.Addr
	RemoteAddr() net.Addr
	SetDeadline(time.Time) error
	SetReadDeadline(time.Time) error
	SetWriteDeadline(time.Time) error
}

type Datagram interface {
	Conn
	ReadMsgUDPAddrPort([]byte, []byte) (int, int, int, netip.AddrPort, error)
}

// DialFailure can acknowledge a failed injected dial that created no remaining
// resource. Native Go dial failures hide internal Close results, so LinuxPorts
// deliberately leaves their closure unconfirmed.
type DialFailure struct {
	Reason              Code
	ClosureAcknowledged bool
}

func (d *DialFailure) Error() string { return string(TransportFailed) }
func (d *DialFailure) Unwrap() error { return d.Reason }

// Ports has no implicit defaults. Tests inject all effects, including the
// syscall callbacks used by a real Dialer's ControlContext.
type Ports struct {
	TCP        func(context.Context, *net.Dialer, netip.AddrPort, netip.AddrPort) (Conn, error)
	UDP        func(context.Context, *net.Dialer, netip.AddrPort, netip.AddrPort) (Datagram, error)
	SetDevice  func(uintptr, string) error
	BoundIndex func(uintptr) (int, error)
	Now        func() time.Time
	ID         func() (uint16, error)
	Timeout    func(context.Context, time.Duration) (context.Context, context.CancelFunc)
}

// LinuxPorts constructs opt-in function references. It performs no native I/O.
func LinuxPorts() Ports {
	return Ports{
		TCP: func(ctx context.Context, d *net.Dialer, local, peer netip.AddrPort) (Conn, error) {
			c, err := d.DialTCP(ctx, "tcp4", local, peer)
			if err != nil || c == nil {
				if c != nil {
					return c, classify(err)
				}
				return nil, &DialFailure{Reason: classify(err)}
			}
			return c, nil
		},
		UDP: func(ctx context.Context, d *net.Dialer, local, peer netip.AddrPort) (Datagram, error) {
			c, err := d.DialUDP(ctx, "udp4", local, peer)
			if err != nil || c == nil {
				if c != nil {
					return c, classify(err)
				}
				return nil, &DialFailure{Reason: classify(err)}
			}
			return c, nil
		},
		SetDevice: func(fd uintptr, name string) error {
			return syscall.SetsockoptString(int(fd), syscall.SOL_SOCKET, syscall.SO_BINDTODEVICE, name)
		},
		BoundIndex: func(fd uintptr) (int, error) {
			return syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, soBindToIfIndex)
		},
		Now: time.Now,
		ID: func() (uint16, error) {
			var b [2]byte
			_, err := rand.Read(b[:])
			return binary.BigEndian.Uint16(b[:]), err
		},
		Timeout: context.WithTimeout,
	}
}

type Egress struct {
	binding    Binding
	owner      Authority
	policy     Policy
	ports      Ports
	mu         sync.Mutex
	operations map[*operation]struct{}
	closing    bool
	last       time.Time
	changed    chan struct{}
	disarm     func() bool
}

func cloneBinding(b Binding) Binding { b.DNS = append([]netip.Addr(nil), b.DNS...); return b }

func safeName(s string) bool {
	if len(s) == 0 || len(s) > 15 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("_.:-", c)) {
			return false
		}
	}
	return s[0] != '-' && s[0] != '.' && s[0] != ':'
}

func validMAC(s string) bool {
	if len(s) != 17 || s == "00:00:00:00:00:00" {
		return false
	}
	for i, c := range s {
		if i%3 == 2 {
			if c != ':' {
				return false
			}
			continue
		}
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func digits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func validBinding(b Binding) bool {
	if !safeName(b.IfName) || b.IfIndex <= 0 || !validMAC(b.PermanentMAC) || !validMAC(b.StationMAC) || !validMAC(b.BSSID) {
		return false
	}
	if len(b.PhysicalPath) > 1024 || len(b.PhysicalPath) <= len("/sys/devices/") || !strings.HasPrefix(b.PhysicalPath, "/sys/devices/") {
		return false
	}
	for _, c := range b.PhysicalPath {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("_./:-", c)) {
			return false
		}
	}
	for _, part := range strings.Split(b.PhysicalPath, "/") {
		if part == ".." || part == "." {
			return false
		}
	}
	if len(b.BusID) != 32 {
		return false
	}
	for _, c := range b.BusID {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	owner := strings.Split(strings.TrimPrefix(b.NMOwner, ":"), ".")
	if !strings.HasPrefix(b.NMOwner, ":") || len(owner) != 2 || !digits(owner[0]) || !digits(owner[1]) {
		return false
	}
	const active = "/org/freedesktop/NetworkManager/ActiveConnection/"
	if !strings.HasPrefix(b.ActivationPath, active) || !digits(strings.TrimPrefix(b.ActivationPath, active)) {
		return false
	}
	if len(b.ProfileUUID) != 36 {
		return false
	}
	for i, c := range b.ProfileUUID {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	if !usableIPv4(b.Source) || !usableIPv4(b.Gateway) || b.PrefixLength < 1 || b.PrefixLength > 32 || b.RouteTable == 0 || len(b.DNS) == 0 || len(b.DNS) > 8 {
		return false
	}
	for _, ip := range b.DNS {
		if !usableIPv4(ip) {
			return false
		}
	}
	return true
}

func usableIPv4(ip netip.Addr) bool {
	if !ip.Is4() || ip.IsUnspecified() || ip.IsLoopback() || ip.IsMulticast() || ip.IsLinkLocalUnicast() {
		return false
	}
	b := ip.As4()
	return b[0] != 0 && b[0] < 224 && ip != netip.AddrFrom4([4]byte{255, 255, 255, 255})
}

func New(b Binding, owner Authority, policy Policy, ports Ports) (*Egress, Code) {
	if !validBinding(b) || owner.Lifetime == nil || owner.Current == nil || policy == nil || ports.TCP == nil || ports.UDP == nil || ports.Now == nil || ports.ID == nil || ports.Timeout == nil || ports.SetDevice == nil || ports.BoundIndex == nil {
		return nil, Unavailable
	}
	now := ports.Now()
	deadline, finite := owner.Lifetime.Deadline()
	if now.IsZero() || !finite || !deadline.After(now) || deadline.Sub(now) > 5*time.Minute || owner.Lifetime.Err() != nil {
		return nil, Unavailable
	}
	e := &Egress{binding: cloneBinding(b), owner: owner, policy: policy, ports: ports, operations: make(map[*operation]struct{}), last: now, changed: make(chan struct{})}
	if !e.current() {
		return nil, BindingChanged
	}
	e.disarm = context.AfterFunc(owner.Lifetime, e.beginClose)
	return e, OK
}

func (e *Egress) signal() { close(e.changed); e.changed = make(chan struct{}) }

func (e *Egress) current() (ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	if e.owner.Lifetime.Err() != nil {
		return false
	}
	return e.owner.Current(cloneBinding(e.binding))
}

func (e *Egress) now() (time.Time, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	n := e.ports.Now()
	if n.IsZero() || n.Before(e.last) {
		return time.Time{}, false
	}
	e.last = n
	return n, true
}

func (e *Egress) beginClose() {
	e.mu.Lock()
	e.closing = true
	all := make([]*operation, 0, len(e.operations))
	for o := range e.operations {
		all = append(all, o)
	}
	e.signal()
	e.mu.Unlock()
	for _, o := range all {
		o.beginClose()
	}
}

// Close requests shutdown and waits at most one second for acknowledged closure.
// A timeout retains ownership of pending/late resources for subsequent readback.
func (e *Egress) Close(ctx context.Context) Code {
	e.beginClose()
	if ctx == nil {
		return CleanupUnknown
	}
	ctx, cancel := e.ports.Timeout(ctx, closeLimit)
	defer cancel()
	for {
		e.mu.Lock()
		n := len(e.operations)
		changed := e.changed
		e.mu.Unlock()
		if n == 0 {
			if e.disarm != nil {
				e.disarm()
			}
			return Closed
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return CleanupUnknown
		}
	}
}

func (e *Egress) Status() Code {
	e.mu.Lock()
	closing := e.closing
	all := make([]*operation, 0, len(e.operations))
	for o := range e.operations {
		all = append(all, o)
	}
	e.mu.Unlock()
	if closing && len(all) == 0 {
		return Closed
	}
	for _, o := range all {
		o.mu.Lock()
		pending := o.closing && !o.finished
		unknown := o.unknown
		o.mu.Unlock()
		if unknown {
			return CleanupUnknown
		}
		if pending && !closing {
			return CleanupUnknown
		}
	}
	if closing {
		return Closing
	}
	return OK
}

func (e *Egress) permitted(ip netip.Addr, port uint16, dns bool) (allowed bool) {
	defer func() {
		if recover() != nil {
			allowed = false
		}
	}()
	if !usableIPv4(ip) || port == 0 {
		return false
	}
	snapshot, ok := e.policy()
	if !ok || len(snapshot.LocalIPv4) == 0 || len(snapshot.LocalIPv4) > 128 || len(snapshot.AllowedTCPPorts) == 0 || len(snapshot.AllowedTCPPorts) > 32 {
		return false
	}
	sourcePresent := false
	for _, local := range snapshot.LocalIPv4 {
		if !local.Is4() {
			return false
		}
		if local == ip {
			return false
		}
		if local == e.binding.Source {
			sourcePresent = true
		}
	}
	if !sourcePresent {
		return false
	}
	if e.binding.PrefixLength < 31 {
		prefix := netip.PrefixFrom(e.binding.Source, e.binding.PrefixLength).Masked().Addr().As4()
		base := binary.BigEndian.Uint32(prefix[:])
		target := ip.As4()
		value := binary.BigEndian.Uint32(target[:])
		mask := uint32(0xffffffff) << (32 - e.binding.PrefixLength)
		if value == base || value == base|^mask {
			return false
		}
	}
	if dns {
		return ip == e.binding.DNS[0] && port == 53
	}
	for _, permitted := range snapshot.AllowedTCPPorts {
		if permitted == port {
			return true
		}
	}
	return false
}

type operation struct {
	e         *Egress
	ctx       context.Context
	cancel    context.CancelFunc
	disarm    func() bool
	mu        sync.Mutex
	closing   bool
	unknown   bool
	finished  bool
	pending   int
	controls  int
	bytes     int
	resources []*resource
	done      chan struct{}
}

type resource struct {
	o    *operation
	c    Conn
	once sync.Once
	done chan struct{}
	ack  bool // protected by operation.mu
}

func (o *operation) settleLocked() {
	if !o.closing || o.finished || o.unknown || o.pending != 0 {
		return
	}
	for _, r := range o.resources {
		if !r.ack {
			return
		}
	}
	o.finished = true
	close(o.done)
	if o.disarm != nil {
		o.disarm()
	}
	o.e.mu.Lock()
	delete(o.e.operations, o)
	o.e.signal()
	o.e.mu.Unlock()
}

func (o *operation) beginClose() {
	o.mu.Lock()
	o.closing = true
	all := append([]*resource(nil), o.resources...)
	o.settleLocked()
	o.mu.Unlock()
	o.cancel()
	for _, r := range all {
		r.startClose()
	}
}

func (r *resource) startClose() {
	r.once.Do(func() {
		go func() {
			err := r.c.Close()
			r.o.mu.Lock()
			r.ack = err == nil
			r.o.unknown = r.o.unknown || err != nil
			close(r.done)
			r.o.settleLocked()
			r.o.mu.Unlock()
		}()
	})
}

func (r *resource) closeWait(ctx context.Context) Code {
	r.startClose()
	ctx, cancel := r.o.e.ports.Timeout(ctx, closeLimit)
	defer cancel()
	select {
	case <-r.done:
		r.o.mu.Lock()
		ack := r.ack
		r.o.mu.Unlock()
		if ack {
			return OK
		}
		return CleanupUnknown
	case <-ctx.Done():
		return CleanupUnknown
	}
}

func (o *operation) track(c Conn) *resource {
	r := &resource{o: o, c: c, done: make(chan struct{})}
	o.mu.Lock()
	o.resources = append(o.resources, r)
	closing := o.closing
	o.mu.Unlock()
	if closing {
		r.startClose()
	}
	return r
}

func invoke[T any](o *operation, ctx context.Context, fn func() (T, error)) (T, error) {
	var zero T
	if ctx.Err() != nil {
		return zero, Cancelled
	}
	o.mu.Lock()
	if o.closing {
		o.mu.Unlock()
		return zero, Cancelled
	}
	o.pending++
	o.mu.Unlock()
	type response struct {
		value T
		err   error
	}
	ch := make(chan response, 1)
	go func() {
		v, err := fn()
		o.mu.Lock()
		o.pending--
		o.settleLocked()
		o.mu.Unlock()
		ch <- response{v, err}
	}()
	select {
	case v := <-ch:
		if ctx.Err() != nil {
			return zero, Cancelled
		}
		return v.value, v.err
	case <-ctx.Done():
		return zero, Cancelled
	}
}

func (o *operation) check(ctx context.Context) Code {
	if ctx.Err() != nil || o.ctx.Err() != nil {
		return Cancelled
	}
	now, ok := o.e.now()
	if !ok {
		o.e.beginClose()
		return BindingChanged
	}
	if deadline, finite := ctx.Deadline(); finite && !now.Before(deadline) {
		return BudgetExceeded
	}
	if deadline, _ := o.e.owner.Lifetime.Deadline(); !now.Before(deadline) {
		o.e.beginClose()
		return Cancelled
	}
	if !o.e.current() {
		o.e.beginClose()
		return BindingChanged
	}
	return OK
}

func (o *operation) control(ctx context.Context, network, _ string, raw syscall.RawConn) error {
	if code := o.check(ctx); code != OK {
		return code
	}
	if raw == nil || network != "tcp4" && network != "udp4" {
		return Unavailable
	}
	o.mu.Lock()
	o.controls++
	count := o.controls
	o.mu.Unlock()
	if count > 32 {
		return BudgetExceeded
	}
	var failure error
	err := raw.Control(func(fd uintptr) {
		if err := o.e.ports.SetDevice(fd, o.e.binding.IfName); err != nil {
			failure = TransportFailed
			return
		}
		index, err := o.e.ports.BoundIndex(fd)
		if err != nil || index != o.e.binding.IfIndex {
			failure = BindingChanged
		}
	})
	if err != nil {
		return TransportFailed
	}
	if failure == BindingChanged {
		o.e.beginClose()
	}
	return failure
}

func (o *operation) dial(ctx context.Context, peer netip.AddrPort, udp, dns bool) (*resource, Code) {
	if code := o.check(ctx); code != OK {
		return nil, code
	}
	if !o.e.permitted(peer.Addr(), peer.Port(), dns) {
		return nil, PolicyDenied
	}
	d := &net.Dialer{ControlContext: func(ctx context.Context, network, address string, raw syscall.RawConn) error {
		if address != peer.String() || (udp && network != "udp4") || (!udp && network != "tcp4") {
			return Unavailable
		}
		if !o.e.permitted(peer.Addr(), peer.Port(), dns) {
			return PolicyDenied
		}
		return o.control(ctx, network, address, raw)
	}}
	d.SetMultipathTCP(false)
	local := netip.AddrPortFrom(o.e.binding.Source, 0)
	r, err := invoke(o, ctx, func() (*resource, error) {
		var c Conn
		var err error
		if udp {
			c, err = o.e.ports.UDP(ctx, d, local, peer)
		} else {
			c, err = o.e.ports.TCP(ctx, d, local, peer)
		}
		var tracked *resource
		if c != nil {
			tracked = o.track(c)
		}
		if err != nil || tracked == nil {
			if tracked != nil {
				if code := tracked.closeWait(ctx); code != OK {
					return nil, code
				}
				return nil, classify(err)
			}
			var failure *DialFailure
			if errors.As(err, &failure) && failure.ClosureAcknowledged {
				return nil, classify(err)
			}
			o.mu.Lock()
			o.unknown = true
			o.mu.Unlock()
			return nil, CleanupUnknown
		}
		return tracked, nil
	})
	if err != nil {
		return nil, classify(err)
	}
	if code := o.check(ctx); code != OK {
		r.startClose()
		return nil, code
	}
	if !matchesAddress(r.c.LocalAddr(), o.e.binding.Source, 0) || !matchesAddress(r.c.RemoteAddr(), peer.Addr(), peer.Port()) {
		r.startClose()
		return nil, TransportFailed
	}
	if !o.e.permitted(peer.Addr(), peer.Port(), dns) {
		r.startClose()
		return nil, PolicyDenied
	}
	return r, OK
}

func matchesAddress(a net.Addr, ip netip.Addr, port uint16) bool {
	var actual netip.AddrPort
	switch a := a.(type) {
	case *net.TCPAddr:
		actual = a.AddrPort()
	case *net.UDPAddr:
		actual = a.AddrPort()
	default:
		return false
	}
	if actual.Addr().Unmap() != ip || actual.Port() == 0 {
		return false
	}
	return port == 0 || actual.Port() == port
}

func classify(err error) Code {
	var code Code
	if errors.As(err, &code) {
		switch code {
		case Unavailable, BindingChanged, PolicyDenied, InvalidDNS, BudgetExceeded, Cancelled, TransportFailed, CleanupUnknown:
			return code
		}
	}
	return TransportFailed
}

func (o *operation) charge(n int) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if n < 0 || n > maxDNSBytes-o.bytes {
		return false
	}
	o.bytes += n
	return true
}

func (o *operation) remaining() int { o.mu.Lock(); defer o.mu.Unlock(); return maxDNSBytes - o.bytes }

func (o *operation) dnsRead(ctx context.Context, r *resource, p []byte) (int, Code) {
	if code := o.check(ctx); code != OK {
		return 0, code
	}
	if remaining := o.remaining(); len(p) > remaining {
		p = p[:remaining]
	}
	if len(p) == 0 {
		return 0, BudgetExceeded
	}
	buf := make([]byte, len(p))
	n, err := invoke(o, ctx, func() (int, error) {
		deadline, _ := ctx.Deadline()
		if err := r.c.SetReadDeadline(deadline); err != nil {
			return 0, TransportFailed
		}
		return r.c.Read(buf)
	})
	if err != nil && !(err == io.EOF && n > 0) {
		return 0, classify(err)
	}
	if code := o.check(ctx); code != OK {
		return 0, code
	}
	if n <= 0 || n > len(p) || !o.charge(n) {
		return 0, BudgetExceeded
	}
	copy(p, buf[:n])
	return n, OK
}

func (o *operation) dnsWrite(ctx context.Context, r *resource, p []byte, datagram bool) Code {
	if !o.charge(len(p)) {
		return BudgetExceeded
	}
	data := append([]byte(nil), p...)
	for len(data) > 0 {
		if code := o.check(ctx); code != OK {
			return code
		}
		n, err := invoke(o, ctx, func() (int, error) {
			deadline, _ := ctx.Deadline()
			if err := r.c.SetWriteDeadline(deadline); err != nil {
				return 0, TransportFailed
			}
			return r.c.Write(data)
		})
		if err != nil {
			return classify(err)
		}
		if n <= 0 || n > len(data) || datagram && n != len(data) {
			return TransportFailed
		}
		data = data[n:]
	}
	return o.check(ctx)
}

func (o *operation) readExact(ctx context.Context, r *resource, p []byte) Code {
	for len(p) > 0 {
		n, code := o.dnsRead(ctx, r, p)
		if code != OK {
			return code
		}
		p = p[n:]
	}
	return OK
}

func canonicalName(host string) (string, bool) {
	name := strings.ToLower(strings.TrimSuffix(host, "."))
	if len(name) == 0 || len(name) > 253 {
		return "", false
	}
	for _, label := range strings.Split(name, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", false
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return "", false
			}
		}
	}
	return name + ".", true
}

func query(name string, id uint16) ([]byte, Code) {
	n, err := dnsmessage.NewName(name)
	if err != nil {
		return nil, InvalidDNS
	}
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: id, RecursionDesired: true})
	if err := b.StartQuestions(); err != nil {
		return nil, InvalidDNS
	}
	if err := b.Question(dnsmessage.Question{Name: n, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}); err != nil {
		return nil, InvalidDNS
	}
	msg, err := b.Finish()
	if err != nil || len(msg) > 512 {
		return nil, InvalidDNS
	}
	return msg, OK
}

func replyQuestion(msg []byte, name string, id uint16) (dnsmessage.Header, bool) {
	if len(msg) < 12 || binary.BigEndian.Uint16(msg[4:6]) != 1 || binary.BigEndian.Uint16(msg[2:4])&0x0040 != 0 {
		return dnsmessage.Header{}, false
	}
	var p dnsmessage.Parser
	h, err := p.Start(msg)
	if err != nil || h.ID != id || !h.Response || h.OpCode != 0 {
		return h, false
	}
	q, err := p.Question()
	if err != nil {
		return h, false
	}
	canonical, ok := canonicalName(q.Name.String())
	if !ok || canonical != name || q.Type != dnsmessage.TypeA || q.Class != dnsmessage.ClassINET {
		return h, false
	}
	_, err = p.Question()
	return h, err == dnsmessage.ErrSectionDone
}

// encodedNameEnd locates the encoded span without expanding compression.
// The codec separately validates expanded names, targets and pointer depth.
func encodedNameEnd(msg []byte, off, limit int) (int, bool) {
	for steps := 0; steps < 128; steps++ {
		if off < 0 || off >= limit || limit > len(msg) {
			return 0, false
		}
		n := int(msg[off])
		off++
		if n == 0 {
			return off, true
		}
		if n&0xc0 == 0xc0 {
			if off >= limit {
				return 0, false
			}
			return off + 1, true
		}
		if n&0xc0 != 0 || off+n > limit {
			return 0, false
		}
		off += n
	}
	return 0, false
}

func envelope(msg []byte) bool {
	if len(msg) < 12 {
		return false
	}
	counts := [3]int{int(binary.BigEndian.Uint16(msg[6:8])), int(binary.BigEndian.Uint16(msg[8:10])), int(binary.BigEndian.Uint16(msg[10:12]))}
	if counts[0]+counts[1]+counts[2] > maxRecords {
		return false
	}
	off, ok := encodedNameEnd(msg, 12, len(msg))
	if !ok || off+4 > len(msg) {
		return false
	}
	off += 4
	for section, count := range counts {
		for j := 0; j < count; j++ {
			off, ok = encodedNameEnd(msg, off, len(msg))
			if !ok || off+10 > len(msg) {
				return false
			}
			typ := binary.BigEndian.Uint16(msg[off : off+2])
			length := int(binary.BigEndian.Uint16(msg[off+8 : off+10]))
			off += 10
			end := off + length
			if end > len(msg) {
				return false
			}
			if typ == uint16(dnsmessage.TypeOPT) {
				return false
			}
			if section == 0 {
				switch dnsmessage.Type(typ) {
				case dnsmessage.TypeA:
					if length != 4 {
						return false
					}
				case dnsmessage.TypeCNAME:
					n, valid := encodedNameEnd(msg, off, end)
					if !valid || n != end {
						return false
					}
				default:
					return false
				}
			}
			off = end
		}
	}
	return off == len(msg)
}

type answer struct {
	aliases   map[string]string
	addresses map[string][]netip.Addr
}

func parseAnswer(msg []byte, name string, id uint16) (answer, Code) {
	result := answer{aliases: make(map[string]string), addresses: make(map[string][]netip.Addr)}
	h, ok := replyQuestion(msg, name, id)
	if !ok || h.Truncated || h.RCode != dnsmessage.RCodeSuccess || !envelope(msg) {
		return result, InvalidDNS
	}
	var p dnsmessage.Parser
	if _, err := p.Start(msg); err != nil {
		return result, InvalidDNS
	}
	if _, err := p.Question(); err != nil {
		return result, InvalidDNS
	}
	if _, err := p.Question(); err != dnsmessage.ErrSectionDone {
		return result, InvalidDNS
	}
	for i := 0; i <= maxRecords; i++ {
		hdr, err := p.AnswerHeader()
		if err == dnsmessage.ErrSectionDone {
			break
		}
		if err != nil || i == maxRecords || hdr.Class != dnsmessage.ClassINET {
			return result, InvalidDNS
		}
		owner, valid := canonicalName(hdr.Name.String())
		if !valid {
			return result, InvalidDNS
		}
		switch hdr.Type {
		case dnsmessage.TypeA:
			a, err := p.AResource()
			if err != nil {
				return result, InvalidDNS
			}
			ip := netip.AddrFrom4(a.A)
			found := false
			for _, old := range result.addresses[owner] {
				if old == ip {
					found = true
				}
			}
			if !found {
				result.addresses[owner] = append(result.addresses[owner], ip)
			}
		case dnsmessage.TypeCNAME:
			a, err := p.CNAMEResource()
			if err != nil {
				return result, InvalidDNS
			}
			target, valid := canonicalName(a.CNAME.String())
			if !valid {
				return result, InvalidDNS
			}
			if previous, exists := result.aliases[owner]; exists && previous != target {
				return result, InvalidDNS
			}
			result.aliases[owner] = target
		default:
			return result, InvalidDNS
		}
	}
	for owner := range result.aliases {
		if len(result.addresses[owner]) > 0 {
			return result, InvalidDNS
		}
	}
	for i := 0; i <= maxRecords; i++ {
		_, err := p.AuthorityHeader()
		if err == dnsmessage.ErrSectionDone {
			break
		}
		if err != nil || i == maxRecords {
			return result, InvalidDNS
		}
		if err = p.SkipAuthority(); err != nil {
			return result, InvalidDNS
		}
	}
	for i := 0; i <= maxRecords; i++ {
		_, err := p.AdditionalHeader()
		if err == dnsmessage.ErrSectionDone {
			break
		}
		if err != nil || i == maxRecords {
			return result, InvalidDNS
		}
		if err = p.SkipAdditional(); err != nil {
			return result, InvalidDNS
		}
	}
	return result, OK
}

func (o *operation) exchange(ctx context.Context, name string) (answer, Code) {
	id, err := o.e.ports.ID()
	if err != nil {
		return answer{}, Unavailable
	}
	msg, code := query(name, id)
	if code != OK {
		return answer{}, code
	}
	peer := netip.AddrPortFrom(o.e.binding.DNS[0], 53)
	udpCtx, cancel := o.e.ports.Timeout(ctx, attemptLimit)
	r, code := o.dial(udpCtx, peer, true, true)
	if code != OK {
		cancel()
		return answer{}, code
	}
	var reply []byte
	truncated := false
	code = o.dnsWrite(udpCtx, r, msg, true)
	if code == OK {
		u, ok := r.c.(Datagram)
		if !ok {
			code = TransportFailed
		} else {
			for mismatch := 0; mismatch <= 4; mismatch++ {
				if o.remaining() < 513 {
					code = BudgetExceeded
					break
				}
				type packet struct {
					data  []byte
					flags int
					peer  netip.AddrPort
				}
				packetResult, readErr := invoke(o, udpCtx, func() (packet, error) {
					buf := make([]byte, 513)
					deadline, _ := udpCtx.Deadline()
					if err := u.SetReadDeadline(deadline); err != nil {
						return packet{}, TransportFailed
					}
					n, _, flags, from, err := u.ReadMsgUDPAddrPort(buf, nil)
					if err != nil {
						return packet{}, err
					}
					if n < 0 || n > len(buf) {
						return packet{}, InvalidDNS
					}
					return packet{buf[:n], flags, from}, nil
				})
				if readErr != nil {
					code = classify(readErr)
					break
				}
				if code = o.check(udpCtx); code != OK {
					break
				}
				if !o.charge(len(packetResult.data)) {
					code = BudgetExceeded
					break
				}
				if len(packetResult.data) > 512 || packetResult.flags&syscall.MSG_TRUNC != 0 {
					code = InvalidDNS
					break
				}
				h, matched := replyQuestion(packetResult.data, name, id)
				if packetResult.peer != peer || !matched {
					code = InvalidDNS
					continue
				}
				if h.RCode != dnsmessage.RCodeSuccess {
					code = InvalidDNS
					break
				}
				reply = packetResult.data
				truncated = h.Truncated
				code = OK
				break
			}
		}
	}
	closeCode := r.closeWait(ctx)
	cancel()
	if closeCode != OK {
		return answer{}, closeCode
	}
	if code != OK {
		return answer{}, code
	}
	if !truncated {
		return parseAnswer(reply, name, id)
	}
	tcpCtx, cancelTCP := o.e.ports.Timeout(ctx, attemptLimit)
	defer cancelTCP()
	r, code = o.dial(tcpCtx, peer, false, true)
	if code != OK {
		return answer{}, code
	}
	frame := make([]byte, 2+len(msg))
	binary.BigEndian.PutUint16(frame, uint16(len(msg)))
	copy(frame[2:], msg)
	code = o.dnsWrite(tcpCtx, r, frame, false)
	if code == OK {
		var prefix [2]byte
		code = o.readExact(tcpCtx, r, prefix[:])
		length := int(binary.BigEndian.Uint16(prefix[:]))
		if code == OK {
			if length < 12 || length > maxTCPMessage {
				code = InvalidDNS
			} else if length > o.remaining() {
				code = BudgetExceeded
			} else {
				reply = make([]byte, length)
				code = o.readExact(tcpCtx, r, reply)
			}
		}
	}
	closeCode = r.closeWait(ctx)
	if closeCode != OK {
		return answer{}, closeCode
	}
	if code != OK {
		return answer{}, code
	}
	return parseAnswer(reply, name, id)
}

func (o *operation) resolve(ctx context.Context, host string) ([]netip.Addr, Code) {
	if ip, err := netip.ParseAddr(host); err == nil {
		if !ip.Is4() {
			return nil, PolicyDenied
		}
		return []netip.Addr{ip}, OK
	}
	name, ok := canonicalName(host)
	if !ok {
		return nil, InvalidDNS
	}
	visited := map[string]bool{name: true}
	edges := 0
	for queries := 0; queries < 5; queries++ {
		a, code := o.exchange(ctx, name)
		if code != OK {
			return nil, code
		}
		for {
			if ips := a.addresses[name]; len(ips) > 0 {
				if len(ips) > 4 {
					return nil, BudgetExceeded
				}
				return ips, OK
			}
			target, exists := a.aliases[name]
			if !exists {
				return nil, InvalidDNS
			}
			edges++
			if edges > 4 || visited[target] {
				return nil, InvalidDNS
			}
			visited[target] = true
			name = target
			if _, found := a.aliases[name]; !found && len(a.addresses[name]) == 0 {
				break
			}
		}
	}
	return nil, BudgetExceeded
}

// Dial resolves once and dials approved numeric candidates in wire order. A
// failed/cancelled operation retains its slot until late resources acknowledge.
func (e *Egress) Dial(ctx context.Context, host string, port uint16) (*Stream, Code) {
	if ctx == nil {
		return nil, Unavailable
	}
	if !e.current() {
		e.beginClose()
		return nil, BindingChanged
	}
	e.mu.Lock()
	if e.closing || len(e.operations) >= 8 {
		e.mu.Unlock()
		return nil, Unavailable
	}
	groupCtx, cancelGroup := context.WithCancel(ctx)
	o := &operation{e: e, ctx: groupCtx, cancel: cancelGroup, done: make(chan struct{})}
	e.operations[o] = struct{}{}
	e.mu.Unlock()
	o.mu.Lock()
	o.disarm = context.AfterFunc(groupCtx, o.beginClose)
	o.mu.Unlock()
	stopOwner := context.AfterFunc(e.owner.Lifetime, o.beginClose)
	defer func() {
		if groupCtx.Err() != nil {
			stopOwner()
		}
	}()
	operationCtx, cancel := e.ports.Timeout(groupCtx, operationLimit)
	defer cancel()
	start, valid := e.now()
	if !valid {
		e.beginClose()
		return nil, BindingChanged
	}
	ips, code := o.resolve(operationCtx, host)
	if code == OK {
		for _, ip := range ips {
			if !e.permitted(ip, port, false) {
				code = PolicyDenied
				break
			}
		}
	}
	var r *resource
	var connectedPeer netip.AddrPort
	if code == OK {
		for _, ip := range ips {
			now, valid := e.now()
			if !valid || now.Sub(start) >= operationLimit {
				code = BudgetExceeded
				break
			}
			attempt, cancelAttempt := e.ports.Timeout(operationCtx, attemptLimit)
			r, code = o.dial(attempt, netip.AddrPortFrom(ip, port), false, false)
			cancelAttempt()
			if code == OK {
				connectedPeer = netip.AddrPortFrom(ip, port)
				break
			}
			if code != TransportFailed {
				break
			}
		}
	}
	if code == OK {
		if now, valid := e.now(); !valid || now.Sub(start) >= operationLimit {
			code = BudgetExceeded
		} else {
			code = o.check(operationCtx)
		}
	}
	if code != OK {
		o.beginClose()
		wait, cancelWait := e.ports.Timeout(context.Background(), closeLimit)
		defer cancelWait()
		select {
		case <-o.done:
			stopOwner()
			return nil, code
		case <-wait.Done():
			return nil, CleanupUnknown
		}
	}
	return &Stream{r: r, o: o, stopOwner: stopOwner, peer: connectedPeer}, OK
}

// Stream preserves ownership across caller I/O. Returned errors are fixed
// categories. A failed write cannot establish that earlier wire effects vanished.
type Stream struct {
	r         *resource
	o         *operation
	stopOwner func() bool
	peer      netip.AddrPort
	readMu    sync.Mutex
	writeMu   sync.Mutex
}

func (s *Stream) check(ctx context.Context) Code {
	if code := s.o.check(ctx); code != OK {
		s.o.beginClose()
		return code
	}
	if !s.o.e.permitted(s.peer.Addr(), s.peer.Port(), false) {
		s.o.beginClose()
		return PolicyDenied
	}
	return OK
}

func (s *Stream) Read(p []byte) (int, error) {
	if !s.readMu.TryLock() {
		return 0, BudgetExceeded
	}
	defer s.readMu.Unlock()
	if len(p) == 0 {
		return 0, nil
	}
	if len(p) > maxChunk {
		return 0, BudgetExceeded
	}
	ctx, cancel := s.o.e.ports.Timeout(s.o.ctx, streamIOLimit)
	defer cancel()
	if code := s.check(ctx); code != OK {
		return 0, code
	}
	buf := make([]byte, len(p))
	type result struct {
		n   int
		err error
	}
	v, err := invoke(s.o, ctx, func() (result, error) {
		deadline, _ := ctx.Deadline()
		if err := s.r.c.SetReadDeadline(deadline); err != nil {
			return result{}, err
		}
		n, err := s.r.c.Read(buf)
		return result{n, err}, nil
	})
	if err != nil {
		s.o.beginClose()
		return 0, classify(err)
	}
	if code := s.check(ctx); code != OK {
		s.o.beginClose()
		return 0, code
	}
	if v.n < 0 || v.n > len(buf) || v.n == 0 && v.err == nil {
		s.o.beginClose()
		return 0, TransportFailed
	}
	copy(p, buf[:v.n])
	if v.err == io.EOF {
		return v.n, io.EOF
	}
	if v.err != nil {
		s.o.beginClose()
		return v.n, TransportFailed
	}
	return v.n, nil
}

func (s *Stream) Write(p []byte) (int, error) {
	if !s.writeMu.TryLock() {
		return 0, BudgetExceeded
	}
	defer s.writeMu.Unlock()
	if len(p) == 0 {
		return 0, nil
	}
	if len(p) > maxChunk {
		return 0, BudgetExceeded
	}
	ctx, cancel := s.o.e.ports.Timeout(s.o.ctx, streamIOLimit)
	defer cancel()
	if code := s.check(ctx); code != OK {
		return 0, code
	}
	buf := append([]byte(nil), p...)
	n, err := invoke(s.o, ctx, func() (int, error) {
		deadline, _ := ctx.Deadline()
		if err := s.r.c.SetWriteDeadline(deadline); err != nil {
			return 0, err
		}
		return s.r.c.Write(buf)
	})
	if err != nil {
		s.o.beginClose()
		return 0, classify(err)
	}
	if code := s.check(ctx); code != OK {
		s.o.beginClose()
		return 0, code
	}
	if n < 0 || n > len(buf) {
		s.o.beginClose()
		return 0, TransportFailed
	}
	if n != len(buf) {
		return n, io.ErrShortWrite
	}
	return n, nil
}

func (s *Stream) Close() error {
	s.o.beginClose()
	ctx, cancel := s.o.e.ports.Timeout(context.Background(), closeLimit)
	defer cancel()
	select {
	case <-s.o.done:
		s.stopOwner()
		return nil
	case <-ctx.Done():
		return CleanupUnknown
	}
}
