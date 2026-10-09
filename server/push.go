package main

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Push notifications through Firebase Cloud Messaging (HTTP v1), for devices
// that aren't looking at the app: new messages, incoming and missed calls.
// Enabled when a Firebase service-account file is present (FIREBASE_CREDENTIALS,
// or firebase-service-account.json in the data folder).

type PushRec struct {
	Token     string `json:"token"`
	UserID    int64  `json:"userId"`
	Platform  string `json:"platform"` // web | android
	UpdatedAt int64  `json:"updatedAt"`
}

// ---------- store ----------

func (s *Store) SavePushToken(uid int64, token, platform string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := &PushRec{Token: token, UserID: uid, Platform: platform, UpdatedAt: nowMs()}
	s.pushTokens[token] = rec
	s.w.put("push", token, rec)
}

func (s *Store) DeletePushToken(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pushTokens[token] != nil {
		delete(s.pushTokens, token)
		s.w.del("push", token)
	}
}

// PushTokens lists an active user's devices.
func (s *Store) PushTokens(uid int64) []PushRec {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if u := s.users[uid]; u == nil || u.Status != "active" {
		return nil
	}
	var out []PushRec
	for _, p := range s.pushTokens {
		if p.UserID == uid {
			out = append(out, *p)
		}
	}
	return out
}

// PushRecipients is who should hear about a new message: the other members,
// minus anyone who muted the chat or blocked the sender.
func (s *Store) PushRecipients(convID, sender int64) []int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []int64
	for uid, m := range s.members[convID] {
		if uid != sender && !m.Muted && !s.blocks[uid][sender] {
			out = append(out, uid)
		}
	}
	return out
}

// ---------- FCM ----------

type serviceAccount struct {
	ProjectID   string `json:"project_id"`
	ClientEmail string `json:"client_email"`
	PrivateKey  string `json:"private_key"`
	TokenURI    string `json:"token_uri"`
}

type Pusher struct {
	store *Store
	acct  serviceAccount
	key   *rsa.PrivateKey
	http  *http.Client

	mu        sync.Mutex
	access    string
	accessExp time.Time
}

// newPusher returns nil (push off) when there are no credentials.
func newPusher(path string, store *Store) *Pusher {
	b, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("push: %v", err)
		}
		return nil
	}
	var acct serviceAccount
	if err := json.Unmarshal(b, &acct); err != nil || acct.ProjectID == "" || acct.PrivateKey == "" {
		log.Printf("push: %s is not a Firebase service-account file", path)
		return nil
	}
	if acct.TokenURI == "" {
		acct.TokenURI = "https://oauth2.googleapis.com/token"
	}
	block, _ := pem.Decode([]byte(acct.PrivateKey))
	if block == nil {
		log.Printf("push: bad private key in %s", path)
		return nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	key, ok := parsed.(*rsa.PrivateKey)
	if err != nil || !ok {
		log.Printf("push: bad private key in %s", path)
		return nil
	}
	log.Printf("push: Firebase project %s", acct.ProjectID)
	return &Pusher{store: store, acct: acct, key: key, http: &http.Client{Timeout: 15 * time.Second}}
}

func (p *Pusher) Enabled() bool { return p != nil }

// HasDevices reports whether the user can be reached by push at all.
func (p *Pusher) HasDevices(uid int64) bool {
	return p != nil && len(p.store.PushTokens(uid)) > 0
}

// Notify sends data to every device of the user, in the background.
func (p *Pusher) Notify(uid int64, data map[string]string, ttl time.Duration) {
	if p == nil {
		return
	}
	for _, t := range p.store.PushTokens(uid) {
		go func(t PushRec) {
			err := p.send(t.Token, data, ttl)
			switch {
			case errors.Is(err, errTokenGone):
				p.store.DeletePushToken(t.Token)
			case err != nil:
				log.Printf("push to %d (%s): %v", uid, t.Platform, err)
			}
		}(t)
	}
}

var errTokenGone = errors.New("device token no longer valid")

func (p *Pusher) send(token string, data map[string]string, ttl time.Duration) error {
	secs := fmt.Sprintf("%d", int(ttl.Seconds()))
	body, _ := json.Marshal(map[string]any{"message": map[string]any{
		"token":   token,
		"data":    data,
		"android": map[string]any{"priority": "HIGH", "ttl": secs + "s"},
		"webpush": map[string]any{"headers": map[string]string{"Urgency": "high", "TTL": secs}},
	}})
	for attempt := 0; attempt < 2; attempt++ {
		access, err := p.accessToken(attempt > 0)
		if err != nil {
			return err
		}
		req, _ := http.NewRequest("POST", "https://fcm.googleapis.com/v1/projects/"+p.acct.ProjectID+"/messages:send", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+access)
		req.Header.Set("Content-Type", "application/json")
		res, err := p.http.Do(req)
		if err != nil {
			return err
		}
		reply, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		res.Body.Close()
		switch {
		case res.StatusCode == http.StatusOK:
			return nil
		case res.StatusCode == http.StatusUnauthorized && attempt == 0:
			continue // the access token expired early: get a new one
		case res.StatusCode == http.StatusNotFound || strings.Contains(string(reply), "UNREGISTERED") ||
			(res.StatusCode == http.StatusBadRequest && strings.Contains(string(reply), "registration token")):
			return errTokenGone
		default:
			return fmt.Errorf("FCM %d: %s", res.StatusCode, strings.TrimSpace(string(reply)))
		}
	}
	return errors.New("FCM rejected the credentials")
}

// accessToken signs in as the service account (cached for about an hour).
func (p *Pusher) accessToken(renew bool) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !renew && p.access != "" && time.Now().Before(p.accessExp) {
		return p.access, nil
	}
	now := time.Now().Unix()
	enc := base64.RawURLEncoding
	header := enc.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, _ := json.Marshal(map[string]any{
		"iss": p.acct.ClientEmail, "scope": "https://www.googleapis.com/auth/firebase.messaging",
		"aud": p.acct.TokenURI, "iat": now, "exp": now + 3600,
	})
	unsigned := header + "." + enc.EncodeToString(claims)
	sum := sha256.Sum256([]byte(unsigned))
	sig, err := rsa.SignPKCS1v15(rand.Reader, p.key, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	res, err := p.http.PostForm(p.acct.TokenURI, url.Values{
		"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
		"assertion":  {unsigned + "." + enc.EncodeToString(sig)},
	})
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
		Error       string `json:"error_description"`
	}
	json.NewDecoder(res.Body).Decode(&out)
	if out.AccessToken == "" {
		return "", fmt.Errorf("Google sign-in failed (%d): %s", res.StatusCode, out.Error)
	}
	p.access, p.accessExp = out.AccessToken, time.Now().Add(time.Duration(out.ExpiresIn-120)*time.Second)
	return p.access, nil
}

// ---------- API ----------

func (s *Server) pushRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/push", s.authed(s.registerPush))
	mux.HandleFunc("DELETE /api/push", s.authed(s.unregisterPush))
}

func (s *Server) registerPush(w http.ResponseWriter, r *http.Request, me UserRec) {
	var in struct{ Token, Platform string }
	if !readJSON(w, r, &in) {
		return
	}
	if !s.push.Enabled() {
		httpError(w, http.StatusServiceUnavailable, "push notifications aren't set up on this server")
		return
	}
	if in.Token == "" || len(in.Token) > 4096 || (in.Platform != "web" && in.Platform != "android") {
		httpError(w, http.StatusBadRequest, "invalid push token")
		return
	}
	s.store.SavePushToken(me.ID, in.Token, in.Platform)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) unregisterPush(w http.ResponseWriter, r *http.Request, me UserRec) {
	var in struct{ Token string }
	if !readJSON(w, r, &in) {
		return
	}
	s.store.DeletePushToken(in.Token)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------- what gets pushed ----------

func pushPreview(m Message) string {
	switch m.Type {
	case "image":
		return orDefault(m.Body, "📷 Photo")
	case "video":
		return orDefault(m.Body, "🎬 Video")
	case "audio":
		return "🎤 Voice message"
	case "file":
		return orDefault(m.Body, "📎 "+m.FileName)
	}
	if r := []rune(m.Body); len(r) > 180 {
		return string(r[:180]) + "…"
	}
	return m.Body
}

func orDefault(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

// pushMessage tells members who aren't looking at the app about a new message.
func (s *Server) pushMessage(m Message) {
	if !s.push.Enabled() {
		return
	}
	sender, ok := s.store.UserByID(m.SenderID)
	if !ok {
		return
	}
	title, body := sender.Name, pushPreview(m)
	if t, _ := s.store.ConvType(m.ConversationID); t == "group" {
		title = s.store.ConvTitle(m.ConversationID)
		body = sender.Name + ": " + body
	}
	for _, uid := range s.store.PushRecipients(m.ConversationID, m.SenderID) {
		if s.hub.isActive(uid) {
			continue
		}
		s.push.Notify(uid, map[string]string{
			"type": "message", "title": title, "body": body,
			"tag": fmt.Sprintf("chat-%d", m.ConversationID), "url": fmt.Sprintf("/app/#/chat/%d", m.ConversationID),
		}, 24*time.Hour)
	}
}
