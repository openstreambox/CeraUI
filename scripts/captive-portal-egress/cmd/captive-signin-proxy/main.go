//go:build linux

// captive-signin-proxy runs the prototype Wi-Fi sign-in proxy for one grant.
//
//	captive-signin-proxy -listen 10.42.0.1:8413 -grant /run/ceraui/signin-proxy.json
//
// The grant file is written by the backend after it checked the caller's
// session and role. It must be a regular file with mode 0600 owned by the
// effective user. Deleting or changing it revokes the grant at once. It holds
// the venue radio binding the egress is bound to and only the SHA-256 of the
// one-device token; the token itself never touches the disk.
package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	portalegress "portal-egress"
	"portal-egress/signinproxy"
)

type grantFile struct {
	Version     int       `json:"version"`
	SessionID   string    `json:"session_id"`
	Role        string    `json:"role"`
	TokenSHA256 string    `json:"token_sha256"`
	NotAfter    time.Time `json:"not_after"`
	Ports       []uint16  `json:"ports"`
	Client      string    `json:"client,omitempty"`
	Binding     struct {
		DeviceID       uint64   `json:"device_id"`
		IfName         string   `json:"if_name"`
		IfIndex        int      `json:"if_index"`
		PhysicalPath   string   `json:"physical_path"`
		PermanentMAC   string   `json:"permanent_mac"`
		StationMAC     string   `json:"station_mac"`
		BSSID          string   `json:"bssid"`
		BusID          string   `json:"bus_id"`
		NMOwner        string   `json:"nm_owner"`
		ActivationPath string   `json:"activation_path"`
		ProfileUUID    string   `json:"profile_uuid"`
		Source         string   `json:"source"`
		Gateway        string   `json:"gateway"`
		DNS            []string `json:"dns"`
		PrefixLength   int      `json:"prefix_length"`
		RouteTable     uint32   `json:"route_table"`
		RouteMetric    uint32   `json:"route_metric"`
	} `json:"binding"`
}

func readGrant(path string) (grantFile, []byte, error) {
	var g grantFile
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return g, nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return g, nil, err
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !st.Mode().IsRegular() || st.Mode().Perm() != 0o600 || !ok || int(sys.Uid) != os.Geteuid() || st.Size() > 16<<10 {
		return g, nil, errors.New("grant file must be a private regular file")
	}
	raw, err := io.ReadAll(io.LimitReader(f, 16<<10))
	if err != nil {
		return g, nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&g); err != nil || g.Version != 1 {
		return g, nil, errors.New("unreadable grant")
	}
	return g, raw, nil
}

func binding(g grantFile) (portalegress.Binding, error) {
	b := g.Binding
	src, err1 := netip.ParseAddr(b.Source)
	gw, err2 := netip.ParseAddr(b.Gateway)
	if err1 != nil || err2 != nil {
		return portalegress.Binding{}, errors.New("bad binding address")
	}
	var dns []netip.Addr
	for _, d := range b.DNS {
		ip, err := netip.ParseAddr(d)
		if err != nil {
			return portalegress.Binding{}, errors.New("bad binding resolver")
		}
		dns = append(dns, ip)
	}
	return portalegress.Binding{DeviceID: b.DeviceID, IfName: b.IfName, IfIndex: b.IfIndex, PhysicalPath: b.PhysicalPath, PermanentMAC: b.PermanentMAC, StationMAC: b.StationMAC, BSSID: b.BSSID, BusID: b.BusID, NMOwner: b.NMOwner, ActivationPath: b.ActivationPath, ProfileUUID: b.ProfileUUID, Source: src, Gateway: gw, DNS: dns, PrefixLength: b.PrefixLength, RouteTable: b.RouteTable, RouteMetric: b.RouteMetric}, nil
}

// interfaceCurrent re-reads the kernel's view of the venue interface: same
// index, same station MAC, up, and still holding the bound source address.
func interfaceCurrent(b portalegress.Binding) bool {
	ifc, err := net.InterfaceByName(b.IfName)
	if err != nil || ifc.Index != b.IfIndex || ifc.Flags&net.FlagUp == 0 || ifc.HardwareAddr.String() != b.StationMAC {
		return false
	}
	addrs, err := ifc.Addrs()
	if err != nil {
		return false
	}
	want := netip.PrefixFrom(b.Source, b.PrefixLength)
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok {
			ip, ok := netip.AddrFromSlice(n.IP)
			ones, _ := n.Mask.Size()
			if ok && netip.PrefixFrom(ip.Unmap(), ones) == want {
				return true
			}
		}
	}
	return false
}

func localIPv4() ([]netip.Addr, bool) {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil, false
	}
	var out []netip.Addr
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok {
			if ip, ok := netip.AddrFromSlice(n.IP); ok && ip.Unmap().Is4() {
				out = append(out, ip.Unmap())
			}
		}
	}
	return out, len(out) > 0 && len(out) <= 128
}

func main() {
	listen := flag.String("listen", "", "address:port on a box-local interface (AP or tunnel)")
	grantPath := flag.String("grant", "", "grant file written by the backend")
	flag.Parse()
	logf := func(e signinproxy.Event) { fmt.Fprintln(os.Stderr, e.String()) }
	fail := func(result string, code int) {
		logf(signinproxy.Event{Kind: "start", Result: result})
		os.Exit(code)
	}
	addr, err := netip.ParseAddrPort(*listen)
	if err != nil || addr.Addr().IsUnspecified() || !addr.Addr().Is4() {
		fail("bad_listen", 2)
	}
	g, original, err := readGrant(*grantPath)
	if err != nil {
		fail("bad_grant", 2)
	}
	sum, err := hex.DecodeString(g.TokenSHA256)
	if err != nil || len(sum) != 32 {
		fail("bad_grant", 2)
	}
	b, err := binding(g)
	if err != nil {
		fail("bad_binding", 2)
	}
	// The grant is unchanged byte for byte and the interface still matches.
	// Results are reused for at most 200 ms, because egress asks on every read.
	var mu sync.Mutex
	var checked time.Time
	var last bool
	session := func() bool {
		mu.Lock()
		defer mu.Unlock()
		if now := time.Now(); now.Sub(checked) >= 200*time.Millisecond || now.Before(checked) {
			_, raw, err := readGrant(*grantPath)
			last = err == nil && bytes.Equal(raw, original) && interfaceCurrent(b)
			checked = now
		}
		return last
	}
	ports := g.Ports
	if len(ports) == 0 {
		ports = signinproxy.DefaultPorts
	}
	policy := func() (portalegress.PolicySnapshot, bool) {
		local, ok := localIPv4()
		return portalegress.PolicySnapshot{LocalIPv4: local, AllowedTCPPorts: append([]uint16(nil), ports...)}, ok
	}
	dial := func(ctx context.Context, host string, port uint16) (io.ReadWriteCloser, string) {
		// portalegress caps one owner lifetime at five minutes; each upstream
		// stream gets its own, ending no later than the grant.
		end := g.NotAfter
		if limit := time.Now().Add(5 * time.Minute); limit.Before(end) {
			end = limit
		}
		life, cancel := context.WithDeadline(ctx, end)
		e, code := portalegress.New(b, portalegress.Authority{Lifetime: life, Current: func(portalegress.Binding) bool { return session() }}, policy, portalegress.LinuxPorts())
		if code != portalegress.OK {
			cancel()
			return nil, string(code)
		}
		st, code := e.Dial(ctx, host, port)
		if code != portalegress.OK {
			e.Close(context.Background())
			cancel()
			return nil, string(code)
		}
		return &ownedStream{Stream: st, e: e, cancel: cancel}, "ok"
	}
	var token [32]byte
	copy(token[:], sum)
	var client netip.Addr
	if g.Client != "" {
		if client, err = netip.ParseAddr(g.Client); err != nil {
			fail("bad_grant", 2)
		}
	}
	srv, err := signinproxy.New(signinproxy.Config{
		Grant:   signinproxy.Grant{SessionID: g.SessionID, Role: g.Role, TokenSHA256: token, NotAfter: g.NotAfter, Ports: ports, Client: client},
		Dial:    dial,
		Session: session,
		Now:     time.Now,
		Log:     logf,
	})
	switch {
	case errors.Is(err, signinproxy.ErrRole):
		fail("role_refused", 3)
	case errors.Is(err, signinproxy.ErrSession):
		fail("no_session", 3)
	case errors.Is(err, signinproxy.ErrWindow):
		fail("outside_window", 3)
	case err != nil:
		fail("bad_config", 2)
	}
	if !session() {
		fail("binding_changed", 3)
	}
	ln, err := net.Listen("tcp4", addr.String())
	if err != nil {
		fail("listen_failed", 2)
	}
	logf(signinproxy.Event{Kind: "start", Result: "listening"})
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	srv.Serve(ctx, ln)
}

type ownedStream struct {
	*portalegress.Stream
	e      *portalegress.Egress
	cancel context.CancelFunc
}

func (s *ownedStream) Close() error {
	err := s.Stream.Close()
	s.e.Close(context.Background())
	s.cancel()
	return err
}
