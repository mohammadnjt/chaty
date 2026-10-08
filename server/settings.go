package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Settings are what the admin panel edits. They live in files/settings.json
// (always a plain file, since it also says where the rest of the data lives).

type Features struct {
	VoiceCalls     bool `json:"voiceCalls"`
	VideoCalls     bool `json:"videoCalls"`
	Groups         bool `json:"groups"`
	Photos         bool `json:"photos"`
	Files          bool `json:"files"`
	VoiceMessages  bool `json:"voiceMessages"`
	EditMessages   bool `json:"editMessages"`
	DeleteMessages bool `json:"deleteMessages"`
	Reactions      bool `json:"reactions"`
	Forwarding     bool `json:"forwarding"`
}

type CallSettings struct {
	// auto: WebRTC first, fall back to relaying media through this server.
	// p2p: WebRTC only. relay: always through this server (works wherever the app works).
	Mode          string   `json:"mode"`
	P2PTimeoutSec int      `json:"p2pTimeoutSec"`
	STUNServers   []string `json:"stunServers"`
	TurnEnabled   bool     `json:"turnEnabled"`
	TurnPublicIP  string   `json:"turnPublicIp"`
	TurnHost      string   `json:"turnHost"`
	TurnPort      int      `json:"turnPort"`
	TurnUser      string   `json:"turnUser"`
	TurnPassword  string   `json:"turnPassword"`
	TurnRelayMin  int      `json:"turnRelayMin"`
	TurnRelayMax  int      `json:"turnRelayMax"`
	ExtraICE      string   `json:"extraIce"` // optional JSON array of RTCIceServer
}

type StorageSettings struct {
	Driver string `json:"driver"` // file | sqlite | postgres | mysql
	DSN    string `json:"dsn"`
}

type Settings struct {
	AppName          string          `json:"appName"`
	RequireApproval  bool            `json:"requireApproval"`
	RegistrationOpen bool            `json:"registrationOpen"`
	MaxUploadMB      int             `json:"maxUploadMB"`
	Features         Features        `json:"features"`
	Calls            CallSettings    `json:"calls"`
	Storage          StorageSettings `json:"storage"`
}

func defaultSettings(cfg Config) Settings {
	s := Settings{
		AppName:          "Chaty",
		RequireApproval:  true,
		RegistrationOpen: true,
		MaxUploadMB:      50,
		Features: Features{
			VoiceCalls: true, VideoCalls: true, Groups: true, Photos: true, Files: true,
			VoiceMessages: true, EditMessages: true, DeleteMessages: true, Reactions: true, Forwarding: true,
		},
		Calls: CallSettings{
			Mode:          "auto",
			P2PTimeoutSec: 12,
			STUNServers:   []string{"stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"},
			TurnPort:      3478,
			TurnUser:      "chaty",
			TurnPassword:  randomHex(12),
			TurnRelayMin:  49160,
			TurnRelayMax:  49200,
		},
		Storage: StorageSettings{Driver: "file"},
	}
	// Environment values seed the first settings file.
	if ip := env("TURN_PUBLIC_IP", ""); ip != "" {
		s.Calls.TurnEnabled = true
		s.Calls.TurnPublicIP = ip
	}
	s.Calls.TurnHost = env("TURN_HOST", "")
	fmt.Sscanf(env("TURN_PORT", "3478"), "%d", &s.Calls.TurnPort)
	s.Calls.TurnUser = env("TURN_USER", s.Calls.TurnUser)
	s.Calls.TurnPassword = env("TURN_PASSWORD", s.Calls.TurnPassword)
	fmt.Sscanf(env("TURN_RELAY_PORTS", ""), "%d-%d", &s.Calls.TurnRelayMin, &s.Calls.TurnRelayMax)
	s.Calls.ExtraICE = env("ICE_SERVERS", "")
	return s
}

func (s *Settings) validate() error {
	s.AppName = strings.TrimSpace(s.AppName)
	if s.AppName == "" {
		s.AppName = "Chaty"
	}
	if s.MaxUploadMB < 1 || s.MaxUploadMB > 2048 {
		return errors.New("max upload size must be between 1 and 2048 MB")
	}
	switch s.Calls.Mode {
	case "auto", "p2p", "relay":
	default:
		return errors.New("call mode must be auto, p2p or relay")
	}
	if s.Calls.P2PTimeoutSec < 3 || s.Calls.P2PTimeoutSec > 60 {
		return errors.New("P2P timeout must be between 3 and 60 seconds")
	}
	if s.Calls.TurnPort < 1 || s.Calls.TurnPort > 65535 {
		return errors.New("invalid TURN port")
	}
	if s.Calls.TurnRelayMin < 1024 || s.Calls.TurnRelayMax > 65535 || s.Calls.TurnRelayMin > s.Calls.TurnRelayMax {
		return errors.New("invalid TURN relay port range")
	}
	if s.Calls.TurnEnabled && s.Calls.TurnPublicIP == "" {
		return errors.New("TURN needs the server's public IP")
	}
	if s.Calls.ExtraICE != "" {
		var v []map[string]any
		if json.Unmarshal([]byte(s.Calls.ExtraICE), &v) != nil {
			return errors.New("extra ICE servers must be a JSON array")
		}
	}
	clean := s.Calls.STUNServers[:0]
	for _, u := range s.Calls.STUNServers {
		if u = strings.TrimSpace(u); u != "" {
			clean = append(clean, u)
		}
	}
	s.Calls.STUNServers = clean
	return nil
}

type SettingsStore struct {
	path string
	mu   sync.RWMutex
	s    Settings
}

func loadSettings(path string, cfg Config) (*SettingsStore, error) {
	ss := &SettingsStore{path: path, s: defaultSettings(cfg)}
	b, err := os.ReadFile(path)
	switch {
	case err == nil:
		// Unmarshal over the defaults so fields added later get sane values.
		if err := json.Unmarshal(b, &ss.s); err != nil {
			return nil, fmt.Errorf("%s is not valid JSON: %w", path, err)
		}
	case errors.Is(err, os.ErrNotExist):
	default:
		return nil, err
	}
	if err := ss.s.validate(); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return ss, ss.save()
}

func (ss *SettingsStore) Get() Settings {
	ss.mu.RLock()
	defer ss.mu.RUnlock()
	s := ss.s
	s.Calls.STUNServers = append([]string(nil), s.Calls.STUNServers...)
	return s
}

func (ss *SettingsStore) Update(fn func(*Settings)) (Settings, error) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	next := ss.s
	next.Calls.STUNServers = append([]string(nil), next.Calls.STUNServers...)
	fn(&next)
	if err := next.validate(); err != nil {
		return ss.s, err
	}
	prev := ss.s
	ss.s = next
	if err := ss.save(); err != nil {
		ss.s = prev
		return prev, err
	}
	return next, nil
}

func (ss *SettingsStore) save() error {
	b, err := json.MarshalIndent(ss.s, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(ss.path, b)
}

func writeFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
