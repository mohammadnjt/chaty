package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"log"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/turn/v4"
)

// turnManager runs the built-in TURN relay (UDP and TCP on the same port) so
// calls connect behind strict NATs, on mobile data, or where UDP is filtered.
// It restarts itself when the admin changes the settings.
type turnManager struct {
	mu  sync.Mutex
	srv *turn.Server
	cur CallSettings
	err string
	// allow reports whether a user may still use the relay (their account is active).
	allow func(userID int64) bool
}

func turnKey(c CallSettings) string {
	return fmt.Sprintf("%v|%s|%d|%s|%d|%d", c.TurnEnabled, c.TurnPublicIP, c.TurnPort, c.TurnSecret, c.TurnRelayMin, c.TurnRelayMax)
}

// Each signed-in user gets their own short-lived TURN login (the "TURN REST
// API" scheme): username "<expiry>:<userId>", password HMAC-SHA1(secret,
// username). Nothing reusable ships to clients, and a blocked account stops
// working at its next refresh.
const turnCredTTL = 24 * time.Hour

func turnCredentials(secret string, userID int64) (username, password string) {
	username = fmt.Sprintf("%d:%d", time.Now().Add(turnCredTTL).Unix(), userID)
	return username, turnPassword(secret, username)
}

func turnPassword(secret, username string) string {
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// turnUserID returns the user a TURN username belongs to, if it hasn't expired.
func turnUserID(username string) (int64, bool) {
	exp, id, ok := strings.Cut(username, ":")
	if !ok {
		return 0, false
	}
	expiry, err := strconv.ParseInt(exp, 10, 64)
	if err != nil || time.Now().Unix() > expiry {
		return 0, false
	}
	uid, err := strconv.ParseInt(id, 10, 64)
	return uid, err == nil
}

// Peers the relay will not send to: loopback, private and other non-public
// ranges, so it can't be used to reach this server's internal network.
var nonPublicNets = func() []*net.IPNet {
	var out []*net.IPNet
	for _, c := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "198.18.0.0/15", "240.0.0.0/4"} {
		_, n, _ := net.ParseCIDR(c)
		out = append(out, n)
	}
	return out
}()

func isPublicIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() || ip.IsMulticast() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() {
		return false
	}
	for _, n := range nonPublicNets {
		if n.Contains(ip) {
			return false
		}
	}
	return true
}

func (t *turnManager) Apply(c CallSettings) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.srv != nil && turnKey(t.cur) == turnKey(c) {
		return nil
	}
	if t.srv != nil {
		t.srv.Close()
		t.srv = nil
	}
	t.cur = c
	t.err = ""
	if !c.TurnEnabled {
		return nil
	}
	srv, err := startTURN(c, t.allow)
	if err != nil {
		t.err = err.Error()
		return err
	}
	t.srv = srv
	return nil
}

func (t *turnManager) Status() (running bool, err string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.srv != nil, t.err
}

func (t *turnManager) Close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.srv != nil {
		t.srv.Close()
		t.srv = nil
	}
}

func startTURN(c CallSettings, allow func(userID int64) bool) (*turn.Server, error) {
	ip := net.ParseIP(c.TurnPublicIP)
	if ip == nil {
		return nil, fmt.Errorf("TURN public IP %q is not an IP address", c.TurnPublicIP)
	}
	addr := fmt.Sprintf("0.0.0.0:%d", c.TurnPort)
	udp, err := net.ListenPacket("udp4", addr)
	if err != nil {
		return nil, err
	}
	tcp, err := net.Listen("tcp4", addr)
	if err != nil {
		udp.Close()
		return nil, err
	}
	gen := func() turn.RelayAddressGenerator {
		return &turn.RelayAddressGeneratorPortRange{
			RelayAddress: ip,
			Address:      "0.0.0.0",
			MinPort:      uint16(c.TurnRelayMin),
			MaxPort:      uint16(c.TurnRelayMax),
		}
	}
	// Our own address stays reachable: that's where the other caller's relay lives.
	permit := func(_ net.Addr, peer net.IP) bool { return peer.Equal(ip) || isPublicIP(peer) }
	s, err := turn.NewServer(turn.ServerConfig{
		Realm: "chaty",
		AuthHandler: func(username, realm string, src net.Addr) ([]byte, bool) {
			uid, ok := turnUserID(username)
			if !ok || (allow != nil && !allow(uid)) {
				return nil, false
			}
			return turn.GenerateAuthKey(username, realm, turnPassword(c.TurnSecret, username)), true
		},
		PacketConnConfigs: []turn.PacketConnConfig{{PacketConn: udp, RelayAddressGenerator: gen(), PermissionHandler: permit}},
		ListenerConfigs:   []turn.ListenerConfig{{Listener: tcp, RelayAddressGenerator: gen(), PermissionHandler: permit}},
	})
	if err != nil {
		udp.Close()
		tcp.Close()
		return nil, err
	}
	log.Printf("TURN relay on udp+tcp/%d (relay ports %d-%d, public ip %s)", c.TurnPort, c.TurnRelayMin, c.TurnRelayMax, ip)
	return s, nil
}

// selfSignedCert loads or creates a certificate for localhost and this
// machine's LAN addresses. Browsers will warn once; accept it and the camera
// and microphone work over the LAN.
func selfSignedCert(dir string) (tls.Certificate, error) {
	certPath, keyPath := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	if cert, err := tls.LoadX509KeyPair(certPath, keyPath); err == nil {
		return cert, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return tls.Certificate{}, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "Chaty local"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(5, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1)},
	}
	for _, s := range lanIPs() {
		tmpl.IPAddresses = append(tmpl.IPAddresses, net.ParseIP(s))
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(certPath, certPEM, 0o600); err != nil {
		return tls.Certificate{}, err
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return tls.Certificate{}, err
	}
	return tls.X509KeyPair(certPEM, keyPEM)
}
