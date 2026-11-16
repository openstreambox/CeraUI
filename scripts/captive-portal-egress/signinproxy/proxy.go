//go:build linux

// Package signinproxy is a prototype of the explicit Wi-Fi sign-in proxy: a
// small HTTP (absolute-form), HTTP CONNECT and SOCKS5 front end whose only way
// out is a caller-supplied Dialer, normally portalegress bound to the venue
// radio. It never terminates TLS: CONNECT and SOCKS5 carry bytes unchanged.
//
// Access needs a grant: a session, the Owner or Tech role, a deadline at most
// MaxWindow away and the SHA-256 of a token handed to one device. The first
// device that presents the token owns it for the rest of the grant, unless the
// grant already names the client address. Expiry,
// revocation or repeated bad tokens close every connection and stop the server.
//
// Logs carry the event kind, the client address, the destination host and
// port, a result code and byte counts. Never paths, queries, user info,
// headers, bodies or tokens.
package signinproxy

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
)

// MaxWindow matches the sign-in window ceiling (CP7, 10 minutes).
const MaxWindow = 10 * time.Minute

const (
	headLimit       = 32 << 10
	headTimeout     = 10 * time.Second
	maxConns        = 32
	maxAuthFailures = 20
	revokePoll      = 250 * time.Millisecond
	copyChunk       = 32 << 10
)

// Roles that may sign the box in. Everyone else is refused at construction.
var allowedRoles = map[string]bool{"owner": true, "tech": true}

// DefaultPorts covers ordinary web ports and the common portal ports.
var DefaultPorts = []uint16{80, 443, 8080, 8443}

// Dialer opens one upstream TCP stream. code is "ok" on success, otherwise a
// short fixed category (for example portalegress codes) that is safe to log.
type Dialer func(ctx context.Context, host string, port uint16) (io.ReadWriteCloser, string)

type Grant struct {
	SessionID   string
	Role        string
	TokenSHA256 [32]byte
	NotAfter    time.Time
	Ports       []uint16
	// Client, when set, pins the grant to the address the backend saw on the
	// caller's authenticated session, before the token is first used. This
	// covers clients that can't send proxy credentials early.
	Client netip.Addr
}

// Event is one log line. Dest holds a host name or address only.
type Event struct {
	Kind   string
	Client string
	Dest   string
	Port   uint16
	Result string
	Up     int64
	Down   int64
}

func (e Event) String() string {
	s := "signin-proxy kind=" + e.Kind
	if e.Client != "" {
		s += " client=" + e.Client
	}
	if e.Dest != "" {
		s += " dest=" + e.Dest + ":" + strconv.Itoa(int(e.Port))
	}
	s += " result=" + e.Result
	if e.Up != 0 || e.Down != 0 {
		s += fmt.Sprintf(" up=%d down=%d", e.Up, e.Down)
	}
	return s
}

type Config struct {
	Grant Grant
	Dial  Dialer
	// Session reports whether the grant is still current (session alive, role
	// unchanged). It is polled and checked before every upstream dial.
	Session func() bool
	Now     func() time.Time
	Log     func(Event)
}

type Server struct {
	cfg      Config
	ports    map[uint16]bool
	mu       sync.Mutex
	pinned   netip.Addr
	failures int
	conns    map[net.Conn]struct{}
	closed   bool
	stop     context.CancelFunc
	reason   string
}

var (
	ErrRole    = errors.New("role may not sign the box in")
	ErrSession = errors.New("grant has no session")
	ErrWindow  = errors.New("grant deadline outside the sign-in window")
	ErrConfig  = errors.New("incomplete proxy configuration")
)

func New(cfg Config) (*Server, error) {
	if cfg.Dial == nil || cfg.Session == nil || cfg.Now == nil || cfg.Log == nil {
		return nil, ErrConfig
	}
	if !allowedRoles[cfg.Grant.Role] {
		return nil, ErrRole
	}
	if strings.TrimSpace(cfg.Grant.SessionID) == "" {
		return nil, ErrSession
	}
	now := cfg.Now()
	if !cfg.Grant.NotAfter.After(now) || cfg.Grant.NotAfter.Sub(now) > MaxWindow {
		return nil, ErrWindow
	}
	if cfg.Grant.TokenSHA256 == ([32]byte{}) {
		return nil, ErrConfig
	}
	ports := cfg.Grant.Ports
	if len(ports) == 0 {
		ports = DefaultPorts
	}
	if len(ports) > 16 {
		return nil, ErrConfig
	}
	s := &Server{cfg: cfg, ports: map[uint16]bool{}, conns: map[net.Conn]struct{}{}}
	if c := cfg.Grant.Client; c.IsValid() {
		if !c.Is4() || c.IsUnspecified() {
			return nil, ErrConfig
		}
		s.pinned = c
	}
	for _, p := range ports {
		if p == 0 {
			return nil, ErrConfig
		}
		s.ports[p] = true
	}
	return s, nil
}

// HashToken returns the value a grant stores for a token.
func HashToken(token string) [32]byte { return sha256.Sum256([]byte(token)) }

// Serve accepts until the grant expires, is revoked or ctx ends. It then closes
// the listener and every open connection and returns the reason.
func (s *Server) Serve(ctx context.Context, ln net.Listener) string {
	deadline := s.cfg.Grant.NotAfter
	ctx, cancel := context.WithDeadline(ctx, deadline)
	s.mu.Lock()
	s.stop = cancel
	s.mu.Unlock()
	defer cancel()
	go func() {
		t := time.NewTicker(revokePoll)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if !s.current() {
					s.shutdown("revoked")
					return
				}
			}
		}
	}()
	go func() {
		<-ctx.Done()
		ln.Close()
		s.mu.Lock()
		s.closed = true
		for c := range s.conns {
			c.Close()
		}
		s.mu.Unlock()
	}()
	var wg sync.WaitGroup
	for {
		c, err := ln.Accept()
		if err != nil {
			break
		}
		if !s.track(c) {
			s.cfg.Log(Event{Kind: "accept", Client: clientAddr(c).String(), Result: "busy"})
			c.Close()
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer s.untrack(c)
			s.handle(ctx, c)
		}()
	}
	cancel()
	wg.Wait()
	s.mu.Lock()
	reason := s.reason
	s.mu.Unlock()
	if reason == "" {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) || !s.cfg.Now().Before(deadline) {
			reason = "expired"
		} else {
			reason = "stopped"
		}
	}
	s.cfg.Log(Event{Kind: "stop", Result: reason})
	return reason
}

func (s *Server) shutdown(reason string) {
	s.mu.Lock()
	if s.reason == "" {
		s.reason = reason
	}
	stop := s.stop
	s.mu.Unlock()
	if stop != nil {
		stop()
	}
}

func (s *Server) track(c net.Conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || len(s.conns) >= maxConns {
		return false
	}
	s.conns[c] = struct{}{}
	return true
}

func (s *Server) untrack(c net.Conn) {
	c.Close()
	s.mu.Lock()
	delete(s.conns, c)
	s.mu.Unlock()
}

func (s *Server) current() (ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	return s.cfg.Now().Before(s.cfg.Grant.NotAfter) && s.cfg.Session()
}

func clientAddr(c net.Conn) netip.Addr {
	if a, ok := c.RemoteAddr().(*net.TCPAddr); ok {
		if ip, ok := netip.AddrFromSlice(a.IP); ok {
			return ip.Unmap()
		}
	}
	return netip.Addr{}
}

type authResult int

const (
	authOK authResult = iota
	authBadToken
	authOtherDevice
	authClosed
)

func (s *Server) authorize(client netip.Addr, token string) authResult {
	if !s.current() {
		s.shutdown("revoked")
		return authClosed
	}
	sum := sha256.Sum256([]byte(token))
	good := subtle.ConstantTimeCompare(sum[:], s.cfg.Grant.TokenSHA256[:]) == 1
	s.mu.Lock()
	if !good {
		s.failures++
		over := s.failures >= maxAuthFailures
		s.mu.Unlock()
		if over {
			s.shutdown("too_many_bad_tokens")
			return authClosed
		}
		return authBadToken
	}
	defer s.mu.Unlock()
	if !client.IsValid() {
		return authOtherDevice
	}
	if !s.pinned.IsValid() {
		s.pinned = client
	}
	if s.pinned != client {
		return authOtherDevice
	}
	return authOK
}

// capReader fails once more than left bytes are read; the head parser uses it
// so an endless request line or header block can't grow memory.
type capReader struct {
	r    io.Reader
	left int
	open bool
}

func (c *capReader) Read(p []byte) (int, error) {
	if c.open {
		return c.r.Read(p)
	}
	if c.left <= 0 {
		return 0, errors.New("request head too large")
	}
	if len(p) > c.left {
		p = p[:c.left]
	}
	n, err := c.r.Read(p)
	c.left -= n
	return n, err
}

func (s *Server) handle(ctx context.Context, c net.Conn) {
	client := clientAddr(c)
	c.SetReadDeadline(time.Now().Add(headTimeout))
	cr := &capReader{r: c, left: headLimit}
	br := bufio.NewReaderSize(cr, 4096)
	first, err := br.Peek(1)
	if err != nil {
		return
	}
	if first[0] == 0x05 {
		s.socks(ctx, c, br, cr, client)
		return
	}
	s.httpProxy(ctx, c, br, cr, client)
}

func (s *Server) allowedPort(port uint16) bool { return s.ports[port] }

func (s *Server) dial(ctx context.Context, host string, port uint16) (io.ReadWriteCloser, string) {
	if !s.current() {
		s.shutdown("revoked")
		return nil, "revoked"
	}
	if !s.allowedPort(port) {
		return nil, "port_denied"
	}
	up, code := s.cfg.Dial(ctx, host, port)
	if code != "ok" || up == nil {
		if up != nil {
			up.Close()
		}
		if code == "ok" || code == "" {
			code = "transport_failed"
		}
		return nil, code
	}
	return up, "ok"
}

func validHost(h string) bool {
	if h == "" || len(h) > 253 {
		return false
	}
	if ip, err := netip.ParseAddr(h); err == nil {
		return ip.Is4()
	}
	for _, r := range h {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '.') {
			return false
		}
	}
	return true
}

func splitHostPort(authority string, def uint16) (string, uint16, bool) {
	host, portText, err := net.SplitHostPort(authority)
	if err != nil {
		if def == 0 || strings.Contains(authority, ":") {
			return "", 0, false
		}
		host, portText = authority, strconv.Itoa(int(def))
	}
	p, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || p == 0 || !validHost(host) {
		return "", 0, false
	}
	return strings.ToLower(host), uint16(p), true
}

func writeStatus(c net.Conn, code int, extra string) {
	fmt.Fprintf(c, "HTTP/1.1 %d %s\r\n%sContent-Length: 0\r\nConnection: close\r\n\r\n", code, http.StatusText(code), extra)
}

func proxyToken(h http.Header) (string, bool) {
	v := h.Get("Proxy-Authorization")
	scheme, rest, ok := strings.Cut(v, " ")
	if !ok || !strings.EqualFold(scheme, "Basic") {
		return "", false
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(rest))
	if err != nil {
		return "", false
	}
	_, pass, ok := strings.Cut(string(raw), ":")
	return pass, ok
}

var hopByHop = []string{"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authorization", "Proxy-Authenticate", "Te", "Trailer", "Transfer-Encoding", "Upgrade"}

func (s *Server) httpProxy(ctx context.Context, c net.Conn, br *bufio.Reader, cr *capReader, client netip.Addr) {
	req, err := http.ReadRequest(br)
	if err != nil {
		writeStatus(c, http.StatusBadRequest, "")
		s.cfg.Log(Event{Kind: "http", Client: client.String(), Result: "bad_request"})
		return
	}
	cr.open = true
	c.SetReadDeadline(time.Time{})
	kind := "http"
	var host string
	var port uint16
	var ok bool
	if req.Method == http.MethodConnect {
		kind = "connect"
		host, port, ok = splitHostPort(req.RequestURI, 0)
	} else if req.URL != nil && req.URL.Scheme == "http" && req.URL.Host != "" {
		host, port, ok = splitHostPort(req.URL.Host, 80)
	}
	if !ok {
		writeStatus(c, http.StatusBadRequest, "")
		s.cfg.Log(Event{Kind: kind, Client: client.String(), Result: "bad_target"})
		return
	}
	ev := Event{Kind: kind, Client: client.String(), Dest: host, Port: port}
	token, present := proxyToken(req.Header)
	switch s.authorize(client, token) {
	case authOK:
	case authBadToken:
		writeStatus(c, http.StatusProxyAuthRequired, "Proxy-Authenticate: Basic realm=\"box sign-in\"\r\n")
		ev.Result = "auth_required"
		if present {
			ev.Result = "bad_token"
		}
		s.cfg.Log(ev)
		return
	case authOtherDevice:
		writeStatus(c, http.StatusForbidden, "")
		ev.Result = "other_device"
		s.cfg.Log(ev)
		return
	default:
		writeStatus(c, http.StatusForbidden, "")
		ev.Result = "closed"
		s.cfg.Log(ev)
		return
	}
	if kind == "http" && (len(req.TransferEncoding) > 0 || req.Header.Get("Upgrade") != "") {
		writeStatus(c, http.StatusNotImplemented, "")
		ev.Result = "unsupported_body"
		s.cfg.Log(ev)
		return
	}
	up, code := s.dial(ctx, host, port)
	if code != "ok" {
		status := http.StatusBadGateway
		if code == "port_denied" || code == "policy_denied" {
			status = http.StatusForbidden
		}
		writeStatus(c, status, "")
		ev.Result = code
		s.cfg.Log(ev)
		return
	}
	defer up.Close()
	if kind == "connect" {
		if _, err := io.WriteString(c, "HTTP/1.1 200 Connection established\r\n\r\n"); err != nil {
			ev.Result = "client_gone"
			s.cfg.Log(ev)
			return
		}
		ev.Up, ev.Down = splice(c, br, up)
		ev.Result = "ok"
		s.cfg.Log(ev)
		return
	}
	for _, h := range strings.Split(req.Header.Get("Connection"), ",") {
		if h = strings.TrimSpace(h); h != "" {
			req.Header.Del(h)
		}
	}
	for _, h := range hopByHop {
		req.Header.Del(h)
	}
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", "")
	}
	req.Close = true
	req.URL.User = nil
	cw := &countWriter{w: onlyWriter{up}}
	if err := req.Write(cw); err != nil {
		ev.Result = "upstream_write"
		ev.Up = cw.n
		s.cfg.Log(ev)
		return
	}
	ev.Up = cw.n
	down, _ := io.CopyBuffer(onlyWriter{c}, onlyReader{up}, make([]byte, copyChunk))
	ev.Down = down
	ev.Result = "ok"
	s.cfg.Log(ev)
}

// SOCKS5 (RFC 1928) with username/password (RFC 1929). The password is the
// token. Only CONNECT, IPv4 or domain targets.
func (s *Server) socks(ctx context.Context, c net.Conn, br *bufio.Reader, cr *capReader, client netip.Addr) {
	ev := Event{Kind: "socks", Client: client.String()}
	fail := func(result string) {
		ev.Result = result
		s.cfg.Log(ev)
	}
	var hdr [2]byte
	if _, err := io.ReadFull(br, hdr[:]); err != nil || hdr[1] == 0 {
		fail("bad_greeting")
		return
	}
	methods := make([]byte, hdr[1])
	if _, err := io.ReadFull(br, methods); err != nil {
		fail("bad_greeting")
		return
	}
	hasUserPass := false
	for _, m := range methods {
		if m == 0x02 {
			hasUserPass = true
		}
	}
	if !hasUserPass {
		c.Write([]byte{0x05, 0xff})
		fail("auth_required")
		return
	}
	c.Write([]byte{0x05, 0x02})
	var v [2]byte
	if _, err := io.ReadFull(br, v[:]); err != nil || v[0] != 0x01 {
		fail("bad_auth")
		return
	}
	user := make([]byte, v[1])
	if _, err := io.ReadFull(br, user); err != nil {
		fail("bad_auth")
		return
	}
	var pl [1]byte
	if _, err := io.ReadFull(br, pl[:]); err != nil {
		fail("bad_auth")
		return
	}
	pass := make([]byte, pl[0])
	if _, err := io.ReadFull(br, pass); err != nil {
		fail("bad_auth")
		return
	}
	switch s.authorize(client, string(pass)) {
	case authOK:
		c.Write([]byte{0x01, 0x00})
	case authBadToken:
		c.Write([]byte{0x01, 0x01})
		fail("bad_token")
		return
	case authOtherDevice:
		c.Write([]byte{0x01, 0x01})
		fail("other_device")
		return
	default:
		c.Write([]byte{0x01, 0x01})
		fail("closed")
		return
	}
	reply := func(code byte) { c.Write([]byte{0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0}) }
	var rq [4]byte
	if _, err := io.ReadFull(br, rq[:]); err != nil || rq[0] != 0x05 {
		fail("bad_request")
		return
	}
	if rq[1] != 0x01 {
		reply(0x07)
		fail("command_not_supported")
		return
	}
	var host string
	switch rq[3] {
	case 0x01:
		var a [4]byte
		if _, err := io.ReadFull(br, a[:]); err != nil {
			fail("bad_request")
			return
		}
		host = netip.AddrFrom4(a).String()
	case 0x03:
		var l [1]byte
		if _, err := io.ReadFull(br, l[:]); err != nil || l[0] == 0 {
			fail("bad_request")
			return
		}
		name := make([]byte, l[0])
		if _, err := io.ReadFull(br, name); err != nil {
			fail("bad_request")
			return
		}
		host = strings.ToLower(string(name))
	default:
		reply(0x08)
		fail("address_type_not_supported")
		return
	}
	var pb [2]byte
	if _, err := io.ReadFull(br, pb[:]); err != nil {
		fail("bad_request")
		return
	}
	port := binary.BigEndian.Uint16(pb[:])
	cr.open = true
	c.SetReadDeadline(time.Time{})
	if !validHost(host) || port == 0 {
		reply(0x01)
		fail("bad_target")
		return
	}
	ev.Dest, ev.Port = host, port
	up, code := s.dial(ctx, host, port)
	if code != "ok" {
		switch code {
		case "port_denied", "policy_denied":
			reply(0x02)
		default:
			reply(0x05)
		}
		fail(code)
		return
	}
	defer up.Close()
	reply(0x00)
	ev.Up, ev.Down = splice(c, br, up)
	ev.Result = "ok"
	s.cfg.Log(ev)
}

// splice copies both ways until either side ends, then closes both. Buffered
// client bytes (a pipelined TLS ClientHello) go first, unchanged.
func splice(c net.Conn, br *bufio.Reader, up io.ReadWriteCloser) (int64, int64) {
	var up64, down64 int64
	done := make(chan struct{}, 2)
	go func() {
		n, _ := io.CopyBuffer(onlyWriter{up}, onlyReader{br}, make([]byte, copyChunk))
		up64 = n
		done <- struct{}{}
	}()
	go func() {
		n, _ := io.CopyBuffer(onlyWriter{c}, onlyReader{up}, make([]byte, copyChunk))
		down64 = n
		done <- struct{}{}
	}()
	<-done
	c.Close()
	up.Close()
	<-done
	return up64, down64
}

type onlyReader struct{ io.Reader }
type onlyWriter struct{ io.Writer }

type countWriter struct {
	w io.Writer
	n int64
}

func (c *countWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}
