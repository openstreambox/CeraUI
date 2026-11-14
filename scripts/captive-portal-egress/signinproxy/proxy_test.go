//go:build linux

package signinproxy

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const token = "one-device-token-0123456789abcdef"

type logBuf struct {
	mu    sync.Mutex
	lines []string
}

func (l *logBuf) add(e Event) { l.mu.Lock(); l.lines = append(l.lines, e.String()); l.mu.Unlock() }
func (l *logBuf) all() string { l.mu.Lock(); defer l.mu.Unlock(); return strings.Join(l.lines, "\n") }

// fakeDial records what the proxy asked for and returns one end of a pipe to
// an in-test upstream handler.
type fakeDial struct {
	mu      sync.Mutex
	calls   []string
	handler func(net.Conn)
	code    string
}

func (f *fakeDial) dial(_ context.Context, host string, port uint16) (io.ReadWriteCloser, string) {
	f.mu.Lock()
	f.calls = append(f.calls, net.JoinHostPort(host, itoa(port)))
	code, h := f.code, f.handler
	f.mu.Unlock()
	if code != "" {
		return nil, code
	}
	a, b := net.Pipe()
	go func() { h(b); b.Close() }()
	return a, "ok"
}

func (f *fakeDial) count() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.calls) }

func itoa(p uint16) string { return strconv.Itoa(int(p)) }

type fixture struct {
	t       *testing.T
	srv     *Server
	addr    string
	log     *logBuf
	dial    *fakeDial
	session atomic.Bool
	done    chan string
	cancel  context.CancelFunc
}

func start(t *testing.T, window time.Duration, handler func(net.Conn)) *fixture {
	t.Helper()
	f := &fixture{t: t, log: &logBuf{}, dial: &fakeDial{handler: handler}, done: make(chan string, 1)}
	f.session.Store(true)
	srv, err := New(Config{
		Grant:   Grant{SessionID: "s1", Role: "owner", TokenSHA256: HashToken(token), NotAfter: time.Now().Add(window)},
		Dial:    f.dial.dial,
		Session: f.session.Load,
		Now:     time.Now,
		Log:     f.log.add,
	})
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f.srv, f.addr = srv, ln.Addr().String()
	ctx, cancel := context.WithCancel(context.Background())
	f.cancel = cancel
	go func() { f.done <- srv.Serve(ctx, ln) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-f.done:
		case <-time.After(3 * time.Second):
			t.Error("server did not stop")
		}
	})
	return f
}

func (f *fixture) connect(from string) net.Conn {
	f.t.Helper()
	d := net.Dialer{Timeout: time.Second}
	if from != "" {
		d.LocalAddr = &net.TCPAddr{IP: net.ParseIP(from)}
	}
	c, err := d.Dial("tcp4", f.addr)
	if err != nil {
		f.t.Fatal(err)
	}
	c.SetDeadline(time.Now().Add(3 * time.Second))
	return c
}

func basic(tok string) string {
	return "Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte("signin:"+tok)) + "\r\n"
}

func status(t *testing.T, c net.Conn) (*http.Response, *bufio.Reader) {
	t.Helper()
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	return resp, br
}

func echoUpstream(c net.Conn) { io.Copy(c, c) }

func TestNewRefusesRoleSessionAndWindow(t *testing.T) {
	base := Config{Dial: (&fakeDial{}).dial, Session: func() bool { return true }, Now: time.Now, Log: func(Event) {}}
	cases := map[string]struct {
		g    Grant
		want error
	}{
		"viewer":    {Grant{SessionID: "s", Role: "viewer", TokenSHA256: HashToken(token), NotAfter: time.Now().Add(time.Minute)}, ErrRole},
		"copilot":   {Grant{SessionID: "s", Role: "copilot", TokenSHA256: HashToken(token), NotAfter: time.Now().Add(time.Minute)}, ErrRole},
		"no role":   {Grant{SessionID: "s", TokenSHA256: HashToken(token), NotAfter: time.Now().Add(time.Minute)}, ErrRole},
		"session":   {Grant{Role: "tech", TokenSHA256: HashToken(token), NotAfter: time.Now().Add(time.Minute)}, ErrSession},
		"expired":   {Grant{SessionID: "s", Role: "tech", TokenSHA256: HashToken(token), NotAfter: time.Now().Add(-time.Second)}, ErrWindow},
		"too long":  {Grant{SessionID: "s", Role: "tech", TokenSHA256: HashToken(token), NotAfter: time.Now().Add(MaxWindow + time.Minute)}, ErrWindow},
		"no token":  {Grant{SessionID: "s", Role: "tech", NotAfter: time.Now().Add(time.Minute)}, ErrConfig},
		"zero port": {Grant{SessionID: "s", Role: "tech", TokenSHA256: HashToken(token), NotAfter: time.Now().Add(time.Minute), Ports: []uint16{0}}, ErrConfig},
	}
	for name, tc := range cases {
		cfg := base
		cfg.Grant = tc.g
		if _, err := New(cfg); err != tc.want {
			t.Errorf("%s: got %v want %v", name, err, tc.want)
		}
	}
	cfg := base
	cfg.Grant = Grant{SessionID: "s", Role: "tech", TokenSHA256: HashToken(token), NotAfter: time.Now().Add(time.Minute)}
	if _, err := New(cfg); err != nil {
		t.Fatalf("tech refused: %v", err)
	}
}

func TestPlainHTTPForwardedInOriginFormWithoutProxyHeaders(t *testing.T) {
	got := make(chan string, 1)
	f := start(t, time.Minute, func(c net.Conn) {
		req, err := http.ReadRequest(bufio.NewReader(c))
		if err != nil {
			got <- "error"
			return
		}
		body, _ := io.ReadAll(req.Body)
		got <- req.Method + " " + req.RequestURI + " host=" + req.Host + " close=" + boolText(req.Close) + " pa=" + req.Header.Get("Proxy-Authorization") + " pc=" + req.Header.Get("Proxy-Connection") + " body=" + string(body)
		io.WriteString(c, "HTTP/1.1 302 Found\r\nLocation: http://portal.example/login\r\nConnection: close\r\n\r\n")
	})
	c := f.connect("")
	io.WriteString(c, "POST http://user:pw@portal.example/login?x=1 HTTP/1.1\r\nHost: portal.example\r\n"+basic(token)+"Proxy-Connection: keep-alive\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 9\r\n\r\nroom=1234")
	resp, _ := status(t, c)
	if resp.StatusCode != 302 || resp.Header.Get("Location") != "http://portal.example/login" {
		t.Fatalf("response %d %q", resp.StatusCode, resp.Header.Get("Location"))
	}
	if g := <-got; g != "POST /login?x=1 host=portal.example close=true pa= pc= body=room=1234" {
		t.Fatalf("upstream saw %q", g)
	}
	if f.dial.calls[0] != "portal.example:80" {
		t.Fatalf("dialed %v", f.dial.calls)
	}
}

func boolText(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func TestMissingOrWrongTokenAsksForAuthAndNeverDials(t *testing.T) {
	f := start(t, time.Minute, echoUpstream)
	for _, auth := range []string{"", basic("wrong")} {
		c := f.connect("")
		io.WriteString(c, "CONNECT portal.example:443 HTTP/1.1\r\nHost: portal.example:443\r\n"+auth+"\r\n")
		resp, _ := status(t, c)
		if resp.StatusCode != 407 || !strings.HasPrefix(resp.Header.Get("Proxy-Authenticate"), "Basic") {
			t.Fatalf("got %d %q", resp.StatusCode, resp.Header.Get("Proxy-Authenticate"))
		}
		c.Close()
	}
	if f.dial.count() != 0 {
		t.Fatal("dialed without a valid token")
	}
}

func TestTokenBelongsToTheFirstDevice(t *testing.T) {
	f := start(t, time.Minute, echoUpstream)
	c := f.connect("127.0.0.1")
	io.WriteString(c, "CONNECT portal.example:443 HTTP/1.1\r\n"+basic(token)+"\r\n")
	if resp, _ := status(t, c); resp.StatusCode != 200 {
		t.Fatalf("first device got %d", resp.StatusCode)
	}
	c.Close()
	other := f.connect("127.0.0.2")
	io.WriteString(other, "CONNECT portal.example:443 HTTP/1.1\r\n"+basic(token)+"\r\n")
	if resp, _ := status(t, other); resp.StatusCode != 403 {
		t.Fatalf("second device got %d", resp.StatusCode)
	}
	if f.dial.count() != 1 {
		t.Fatalf("dials %d", f.dial.count())
	}
	if !strings.Contains(f.log.all(), "client=127.0.0.2 dest=portal.example:443 result=other_device") {
		t.Fatal(f.log.all())
	}
}

func TestGrantPinnedToTheSessionAddressRefusesEveryOtherDevice(t *testing.T) {
	f := &fixture{t: t, log: &logBuf{}, dial: &fakeDial{handler: echoUpstream}, done: make(chan string, 1)}
	srv, err := New(Config{
		Grant:   Grant{SessionID: "s1", Role: "tech", TokenSHA256: HashToken(token), NotAfter: time.Now().Add(time.Minute), Client: netip.MustParseAddr("127.0.0.2")},
		Dial:    f.dial.dial,
		Session: func() bool { return true },
		Now:     time.Now,
		Log:     f.log.add,
	})
	if err != nil {
		t.Fatal(err)
	}
	ln, _ := net.Listen("tcp4", "127.0.0.1:0")
	f.addr = ln.Addr().String()
	ctx, cancel := context.WithCancel(context.Background())
	go func() { f.done <- srv.Serve(ctx, ln) }()
	defer func() { cancel(); <-f.done }()
	first := f.connect("127.0.0.1")
	io.WriteString(first, "CONNECT portal.example:443 HTTP/1.1\r\n"+basic(token)+"\r\n")
	if resp, _ := status(t, first); resp.StatusCode != 403 {
		t.Fatalf("unpinned first device got %d", resp.StatusCode)
	}
	pinned := f.connect("127.0.0.2")
	io.WriteString(pinned, "CONNECT portal.example:443 HTTP/1.1\r\n"+basic(token)+"\r\n")
	if resp, _ := status(t, pinned); resp.StatusCode != 200 {
		t.Fatalf("pinned device got %d", resp.StatusCode)
	}
	if _, err := New(Config{Grant: Grant{SessionID: "s", Role: "tech", TokenSHA256: HashToken(token), NotAfter: time.Now().Add(time.Minute), Client: netip.MustParseAddr("2001:db8::1")}, Dial: f.dial.dial, Session: func() bool { return true }, Now: time.Now, Log: f.log.add}); err != ErrConfig {
		t.Fatalf("IPv6 pin accepted: %v", err)
	}
}

func TestConnectCarriesBytesUnchangedIncludingPipelined(t *testing.T) {
	f := start(t, time.Minute, echoUpstream)
	c := f.connect("")
	hello := "\x16\x03\x01\x00\x05hello"
	io.WriteString(c, "CONNECT 203.0.113.10:443 HTTP/1.1\r\n"+basic(token)+"\r\n"+hello)
	resp, br := status(t, c)
	if resp.StatusCode != 200 {
		t.Fatalf("got %d", resp.StatusCode)
	}
	buf := make([]byte, len(hello))
	if _, err := io.ReadFull(br, buf); err != nil || string(buf) != hello {
		t.Fatalf("echo %q %v", buf, err)
	}
	io.WriteString(c, "more")
	buf = make([]byte, 4)
	if _, err := io.ReadFull(br, buf); err != nil || string(buf) != "more" {
		t.Fatalf("echo %q %v", buf, err)
	}
}

func TestPortsOutsideTheListAreRefusedBeforeDialling(t *testing.T) {
	f := start(t, time.Minute, echoUpstream)
	for _, target := range []string{"portal.example:22", "portal.example:25"} {
		c := f.connect("")
		io.WriteString(c, "CONNECT "+target+" HTTP/1.1\r\n"+basic(token)+"\r\n")
		if resp, _ := status(t, c); resp.StatusCode != 403 {
			t.Fatalf("%s got %d", target, resp.StatusCode)
		}
	}
	if f.dial.count() != 0 {
		t.Fatal("dialed a refused port")
	}
}

func TestEgressRefusalMapsToStatus(t *testing.T) {
	f := start(t, time.Minute, echoUpstream)
	for code, want := range map[string]int{"policy_denied": 403, "transport_failed": 502, "binding_changed": 502} {
		f.dial.mu.Lock()
		f.dial.code = code
		f.dial.mu.Unlock()
		c := f.connect("")
		io.WriteString(c, "CONNECT portal.example:443 HTTP/1.1\r\n"+basic(token)+"\r\n")
		if resp, _ := status(t, c); resp.StatusCode != want {
			t.Fatalf("%s got %d", code, resp.StatusCode)
		}
	}
}

func TestUnsupportedRequestsAreRefusedWithoutDialling(t *testing.T) {
	f := start(t, time.Minute, echoUpstream)
	for _, req := range []string{
		"GET /local HTTP/1.1\r\nHost: box\r\n" + basic(token) + "\r\n",
		"GET https://portal.example/ HTTP/1.1\r\n" + basic(token) + "\r\n",
		"POST http://portal.example/ HTTP/1.1\r\n" + basic(token) + "Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
		"GET http://portal.example/ HTTP/1.1\r\n" + basic(token) + "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
		"CONNECT [2001:db8::1]:443 HTTP/1.1\r\n" + basic(token) + "\r\n",
		"CONNECT bad_host!:443 HTTP/1.1\r\n" + basic(token) + "\r\n",
	} {
		c := f.connect("")
		io.WriteString(c, req)
		if resp, _ := status(t, c); resp.StatusCode < 400 {
			t.Fatalf("%q got %d", req, resp.StatusCode)
		}
	}
	if f.dial.count() != 0 {
		t.Fatalf("dialed %v", f.dial.calls)
	}
}

func TestOversizedHeadIsRefused(t *testing.T) {
	f := start(t, time.Minute, echoUpstream)
	c := f.connect("")
	go io.WriteString(c, "GET http://portal.example/ HTTP/1.1\r\nX: "+strings.Repeat("a", headLimit+10)+"\r\n\r\n")
	if resp, _ := status(t, c); resp.StatusCode != 400 {
		t.Fatalf("got %d", resp.StatusCode)
	}
}

func socksHandshake(t *testing.T, c net.Conn, tok string, cmd byte, target []byte, port uint16) []byte {
	t.Helper()
	c.Write([]byte{0x05, 0x01, 0x02})
	buf := make([]byte, 2)
	if _, err := io.ReadFull(c, buf); err != nil || buf[1] != 0x02 {
		t.Fatalf("method %v %v", buf, err)
	}
	c.Write(append(append([]byte{0x01, 6}, "signin"...), append([]byte{byte(len(tok))}, tok...)...))
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatal(err)
	}
	if buf[1] != 0 {
		return buf
	}
	p := make([]byte, 2)
	binary.BigEndian.PutUint16(p, port)
	c.Write(append(append([]byte{0x05, cmd, 0x00}, target...), p...))
	reply := make([]byte, 10)
	if _, err := io.ReadFull(c, reply); err != nil {
		t.Fatal(err)
	}
	return reply
}

func TestSocks5ConnectWithUserPassword(t *testing.T) {
	f := start(t, time.Minute, echoUpstream)
	c := f.connect("")
	name := "portal.example"
	reply := socksHandshake(t, c, token, 0x01, append([]byte{0x03, byte(len(name))}, name...), 443)
	if reply[1] != 0x00 {
		t.Fatalf("reply %v", reply)
	}
	io.WriteString(c, "tls-bytes")
	buf := make([]byte, 9)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "tls-bytes" {
		t.Fatalf("echo %q %v", buf, err)
	}
	if f.dial.calls[0] != "portal.example:443" {
		t.Fatal(f.dial.calls)
	}
}

func TestSocks5RefusesNoAuthBadTokenAndUDP(t *testing.T) {
	f := start(t, time.Minute, echoUpstream)
	c := f.connect("")
	c.Write([]byte{0x05, 0x01, 0x00})
	buf := make([]byte, 2)
	if _, err := io.ReadFull(c, buf); err != nil || buf[1] != 0xff {
		t.Fatalf("no-auth %v %v", buf, err)
	}
	if r := socksHandshake(t, f.connect(""), "wrong", 0x01, []byte{0x01, 203, 0, 113, 10}, 443); r[1] != 0x01 {
		t.Fatalf("bad token %v", r)
	}
	if r := socksHandshake(t, f.connect(""), token, 0x03, []byte{0x01, 203, 0, 113, 10}, 443); r[1] != 0x07 {
		t.Fatalf("udp associate %v", r)
	}
	if r := socksHandshake(t, f.connect(""), token, 0x01, append([]byte{0x04}, make([]byte, 16)...), 443); r[1] != 0x08 {
		t.Fatalf("ipv6 %v", r)
	}
	if f.dial.count() != 0 {
		t.Fatal(f.dial.calls)
	}
}

func TestExpiryClosesOpenTunnelsAndStops(t *testing.T) {
	f := start(t, 600*time.Millisecond, echoUpstream)
	c := f.connect("")
	c.SetDeadline(time.Now().Add(5 * time.Second))
	io.WriteString(c, "CONNECT portal.example:443 HTTP/1.1\r\n"+basic(token)+"\r\n")
	resp, br := status(t, c)
	if resp.StatusCode != 200 {
		t.Fatalf("got %d", resp.StatusCode)
	}
	began := time.Now()
	if _, err := br.ReadByte(); err == nil {
		t.Fatal("tunnel stayed open")
	}
	if time.Since(began) > 2*time.Second {
		t.Fatal("tunnel outlived the grant")
	}
	select {
	case r := <-f.done:
		if r != "expired" {
			t.Fatalf("reason %q", r)
		}
		f.done <- r
	case <-time.After(2 * time.Second):
		t.Fatal("server kept running")
	}
	if _, err := net.DialTimeout("tcp4", f.addr, 300*time.Millisecond); err == nil {
		t.Fatal("listener still accepts after expiry")
	}
}

func TestRevokedSessionClosesTunnelsAndStops(t *testing.T) {
	f := start(t, time.Minute, echoUpstream)
	c := f.connect("")
	c.SetDeadline(time.Now().Add(5 * time.Second))
	io.WriteString(c, "CONNECT portal.example:443 HTTP/1.1\r\n"+basic(token)+"\r\n")
	resp, br := status(t, c)
	if resp.StatusCode != 200 {
		t.Fatalf("got %d", resp.StatusCode)
	}
	f.session.Store(false)
	if _, err := br.ReadByte(); err == nil {
		t.Fatal("tunnel stayed open after revocation")
	}
	select {
	case r := <-f.done:
		if r != "revoked" {
			t.Fatalf("reason %q", r)
		}
		f.done <- r
	case <-time.After(2 * time.Second):
		t.Fatal("server kept running")
	}
}

func TestRepeatedBadTokensCloseTheProxy(t *testing.T) {
	f := start(t, time.Minute, echoUpstream)
	for i := 0; i < maxAuthFailures; i++ {
		c := f.connect("")
		io.WriteString(c, "CONNECT portal.example:443 HTTP/1.1\r\n"+basic("guess")+"\r\n")
		status(t, c)
		c.Close()
	}
	select {
	case r := <-f.done:
		if r != "too_many_bad_tokens" {
			t.Fatalf("reason %q", r)
		}
		f.done <- r
	case <-time.After(2 * time.Second):
		t.Fatal("server kept running")
	}
}

func TestLogsCarryNoPathsQueriesUserInfoBodiesOrTokens(t *testing.T) {
	f := start(t, time.Minute, func(c net.Conn) {
		req, err := http.ReadRequest(bufio.NewReader(c))
		if err == nil {
			io.ReadAll(req.Body)
		}
		io.WriteString(c, "HTTP/1.1 200 OK\r\nSet-Cookie: portal-session=cookie-secret\r\nConnection: close\r\n\r\nwelcome")
	})
	c := f.connect("")
	form := "room=4711&surname=Doe&card=4111111111111111&cvc=123"
	io.WriteString(c, "POST http://alice:pw-secret@portal.example/pay/voucher-secret?mac=aa:bb&token=query-secret HTTP/1.1\r\n"+basic(token)+"Cookie: c=cookie-secret\r\nContent-Length: "+itoa(uint16(len(form)))+"\r\n\r\n"+form)
	if resp, _ := status(t, c); resp.StatusCode != 200 {
		t.Fatalf("got %d", resp.StatusCode)
	}
	c.Close()
	c = f.connect("")
	io.WriteString(c, "CONNECT portal.example:443 HTTP/1.1\r\n"+basic("bad-"+token)+"\r\n")
	status(t, c)
	time.Sleep(100 * time.Millisecond)
	logs := f.log.all()
	for _, secret := range []string{"voucher-secret", "query-secret", "pw-secret", "alice", "4711", "Doe", "4111", "cvc", "cookie-secret", token, "/pay", "mac=", base64.StdEncoding.EncodeToString([]byte("signin:" + token))} {
		if strings.Contains(logs, secret) {
			t.Errorf("log contains %q:\n%s", secret, logs)
		}
	}
	if !strings.Contains(logs, "kind=http client=127.0.0.1 dest=portal.example:80 result=ok") {
		t.Fatalf("missing http event:\n%s", logs)
	}
}
