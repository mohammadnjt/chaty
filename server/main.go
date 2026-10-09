// Chaty server: REST API, WebSocket realtime + call signaling and media relay,
// built-in TURN, admin panel API and optional HTTPS, in one binary.
// Data lives in the files/ folder by default (JSON Lines), or in a database
// the admin points it at.
package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/acme/autocert"
	"golang.org/x/crypto/bcrypt"
)

type Config struct {
	Port       string
	DataDir    string
	StaticDir  string
	Domain     string // enables Let's Encrypt on :443
	SelfSigned bool   // HTTPS=self: self-signed cert, for testing calls across devices on a LAN

	AdminPhone    string
	AdminPassword string

	// Emergency override of the storage chosen in the admin panel.
	StorageDriver string
	StorageDSN    string
}

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// loadDotEnv reads KEY=VALUE lines from .env without overriding the real environment.
func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.Trim(strings.TrimSpace(v), `"'`)
		if _, set := os.LookupEnv(k); !set {
			os.Setenv(k, v)
		}
	}
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func loadConfig() Config {
	loadDotEnv(".env")
	// Running from server/ inside the project: keep data in the project's files/ folder.
	defaultData := "files"
	if exists("../app/package.json") && exists("go.mod") {
		defaultData = "../files"
	}
	cfg := Config{
		Port:          env("PORT", "8080"),
		DataDir:       env("DATA_DIR", defaultData),
		StaticDir:     env("STATIC_DIR", ""),
		Domain:        env("DOMAIN", ""),
		SelfSigned:    env("HTTPS", "") == "self",
		AdminPhone:    env("ADMIN_PHONE", "09130895830"),
		AdminPassword: env("ADMIN_PASSWORD", ""),
		StorageDriver: env("STORAGE_DRIVER", ""),
		StorageDSN:    env("STORAGE_DSN", ""),
	}
	if cfg.StaticDir == "" {
		for _, dir := range []string{"web", "app/web-build", "../app/web-build"} {
			if exists(filepath.Join(dir, "index.html")) {
				cfg.StaticDir = dir
				break
			}
		}
	}
	return cfg
}

// ensureAdmin makes sure the account from ADMIN_PHONE exists, is active, is
// an admin and uses ADMIN_PASSWORD.
func ensureAdmin(store *Store, cfg Config) {
	phone, ok := normalizePhone(cfg.AdminPhone)
	if !ok {
		log.Printf("ADMIN_PHONE %q is not a valid phone number; no admin account", cfg.AdminPhone)
		return
	}
	pass := cfg.AdminPassword
	if pass == "" {
		path := filepath.Join(cfg.DataDir, "admin-password.txt")
		if b, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(b))) >= 6 {
			pass = strings.TrimSpace(string(b))
		} else {
			pass = randomHex(5)
			os.WriteFile(path, []byte(pass+"\n"), 0o600)
		}
		log.Printf("ADMIN_PASSWORD is not set; using the one in %s", path)
	}
	hash := func() string {
		h, _ := bcrypt.GenerateFromPassword([]byte(pass), bcrypt.DefaultCost)
		return string(h)
	}
	if u, ok := store.UserByPhone(phone); ok {
		store.UpdateUser(u.ID, func(u *UserRec) {
			u.Role, u.Status = "admin", "active"
			if bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(pass)) != nil {
				u.PasswordHash = hash()
			}
		})
	} else if _, err := store.CreateUser(phone, "Admin", hash(), "admin", "active"); err != nil {
		log.Printf("creating admin: %v", err)
		return
	}
	log.Printf("admin account: %s", phone)
}

func openStorage(cfg Config, settings *SettingsStore) (*Store, error) {
	st := settings.Get().Storage
	if cfg.StorageDriver != "" {
		st = StorageSettings{Driver: cfg.StorageDriver, DSN: cfg.StorageDSN}
		log.Printf("storage overridden by STORAGE_DRIVER=%s", st.Driver)
	}
	if st.Driver == "" {
		st.Driver = "file"
	}
	var p Persister
	var err error
	for attempt := 1; ; attempt++ {
		if p, err = openPersister(st, cfg.DataDir); err == nil {
			break
		}
		if attempt == 5 {
			return nil, err
		}
		log.Printf("storage: %v (retrying)", err)
		time.Sleep(2 * time.Second)
	}
	log.Printf("storage: %s", p.Describe())
	return newStore(p, st.Driver)
}

func main() {
	log.SetOutput(os.Stdout) // supervisors (BAS, systemd) show stderr as errors
	mime.AddExtensionType(".webmanifest", "application/manifest+json")
	cfg := loadConfig()
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		log.Fatal(err)
	}
	settings, err := loadSettings(filepath.Join(cfg.DataDir, "settings.json"), cfg)
	if err != nil {
		log.Fatalf("settings: %v", err)
	}
	store, err := openStorage(cfg, settings)
	if err != nil {
		log.Fatalf("storage: %v\nFix the address in %s (\"storage\") or set STORAGE_DRIVER=file to start from the local file.",
			err, filepath.Join(cfg.DataDir, "settings.json"))
	}
	ensureAdmin(store, cfg)

	turn := &turnManager{allow: func(id int64) bool {
		u, ok := store.UserByID(id)
		return ok && u.Status == "active"
	}}
	if err := turn.Apply(settings.Get().Calls); err != nil {
		log.Printf("turn: %v", err)
	}

	srv := &Server{cfg: cfg, store: store, hub: newHub(store, settings), settings: settings, turn: turn}
	srv.hub.configFor = srv.clientConfigData
	srv.push = newPusher(env("FIREBASE_CREDENTIALS", filepath.Join(cfg.DataDir, "firebase-service-account.json")), store)
	srv.hub.push = srv.push
	go srv.expireStories()
	httpSrv := &http.Server{Handler: srv.routes(), ReadHeaderTimeout: 15 * time.Second}
	errc := make(chan error, 2)

	switch {
	case cfg.Domain != "":
		m := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(cfg.Domain),
			Cache:      autocert.DirCache(filepath.Join(cfg.DataDir, "certs")),
		}
		httpSrv.Addr = ":443"
		httpSrv.TLSConfig = m.TLSConfig()
		go func() { errc <- http.ListenAndServe(":80", m.HTTPHandler(nil)) }()
		go func() { errc <- httpSrv.ListenAndServeTLS("", "") }()
		log.Printf("Chaty is up at https://%s", cfg.Domain)
	case cfg.SelfSigned:
		cert, err := selfSignedCert(filepath.Join(cfg.DataDir, "tls"))
		if err != nil {
			log.Fatalf("tls: %v", err)
		}
		httpSrv.Addr = ":" + cfg.Port
		httpSrv.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}}
		go func() { errc <- httpSrv.ListenAndServeTLS("", "") }()
		printURLs("https", cfg.Port)
	default:
		httpSrv.Addr = ":" + cfg.Port
		go func() { errc <- httpSrv.ListenAndServe() }()
		printURLs("http", cfg.Port)
	}
	if cfg.StaticDir != "" {
		log.Printf("serving web app from %s", cfg.StaticDir)
	} else {
		log.Printf("web app not built yet — API only (use the Vite dev server for the UI)")
	}
	log.Printf("data folder: %s", cfg.DataDir)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			store.Close()
			log.Fatal(err)
		}
	case <-stop:
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		httpSrv.Shutdown(ctx)
	}
	turn.Close()
	store.Close() // flushes pending writes
}

func lanIPs() []string {
	var out []string
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if ipn, ok := a.(*net.IPNet); ok && !ipn.IP.IsLoopback() && ipn.IP.To4() != nil {
			out = append(out, ipn.IP.String())
		}
	}
	return out
}

func printURLs(scheme, port string) {
	log.Printf("Chaty is up:")
	log.Printf("  %s://localhost:%s", scheme, port)
	for _, ip := range lanIPs() {
		log.Printf("  %s://%s:%s", scheme, ip, port)
	}
}
