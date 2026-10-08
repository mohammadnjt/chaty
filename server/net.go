package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"log"
	"math/big"
	"net"
	"os"
	"path/filepath"
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
}

func turnKey(c CallSettings) string {
	return fmt.Sprintf("%v|%s|%d|%s|%s|%d|%d", c.TurnEnabled, c.TurnPublicIP, c.TurnPort, c.TurnUser, c.TurnPassword, c.TurnRelayMin, c.TurnRelayMax)
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
	srv, err := startTURN(c)
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

func startTURN(c CallSettings) (*turn.Server, error) {
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
	realm := "chaty"
	key := turn.GenerateAuthKey(c.TurnUser, realm, c.TurnPassword)
	s, err := turn.NewServer(turn.ServerConfig{
		Realm: realm,
		AuthHandler: func(username, realm string, src net.Addr) ([]byte, bool) {
			return key, username == c.TurnUser
		},
		PacketConnConfigs: []turn.PacketConnConfig{{PacketConn: udp, RelayAddressGenerator: gen()}},
		ListenerConfigs:   []turn.ListenerConfig{{Listener: tcp, RelayAddressGenerator: gen()}},
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
