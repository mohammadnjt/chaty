package main

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

type Server struct {
	cfg      Config
	store    *Store
	hub      *Hub
	settings *SettingsStore
	turn     *turnManager
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("GET /api/public-config", s.publicConfig)
	mux.HandleFunc("POST /api/auth/register", s.register)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.HandleFunc("POST /api/auth/logout", s.authed(s.logout))
	mux.HandleFunc("GET /api/me", s.authed(s.me))
	mux.HandleFunc("PATCH /api/me", s.authed(s.updateMe))
	mux.HandleFunc("POST /api/me/password", s.authed(s.changePassword))
	mux.HandleFunc("GET /api/config", s.authed(s.clientConfig))
	mux.HandleFunc("GET /api/users", s.authed(s.searchUsers))
	mux.HandleFunc("GET /api/blocks", s.authed(s.listBlocked))
	mux.HandleFunc("POST /api/users/{id}/block", s.authed(s.blockUser))
	mux.HandleFunc("DELETE /api/users/{id}/block", s.authed(s.unblockUser))
	mux.HandleFunc("GET /api/conversations", s.authed(s.listConversations))
	mux.HandleFunc("POST /api/conversations/direct", s.authed(s.openDirect))
	mux.HandleFunc("POST /api/conversations/group", s.authed(s.createGroup))
	mux.HandleFunc("GET /api/conversations/{id}", s.authed(s.getConversation))
	mux.HandleFunc("GET /api/conversations/{id}/messages", s.authed(s.listMessages))
	mux.HandleFunc("POST /api/conversations/{id}/messages", s.authed(s.sendMessage))
	mux.HandleFunc("POST /api/conversations/{id}/read", s.authed(s.markRead))
	mux.HandleFunc("POST /api/conversations/{id}/pin", s.authed(s.pinMessage))
	mux.HandleFunc("POST /api/conversations/{id}/mute", s.authed(s.muteConversation))
	mux.HandleFunc("POST /api/conversations/{id}/clear", s.authed(s.clearConversation))
	mux.HandleFunc("POST /api/conversations/{id}/leave", s.authed(s.leaveConversation))
	mux.HandleFunc("PATCH /api/messages/{id}", s.authed(s.editMessage))
	mux.HandleFunc("DELETE /api/messages/{id}", s.authed(s.deleteMessage))
	mux.HandleFunc("POST /api/messages/{id}/react", s.authed(s.reactMessage))
	mux.HandleFunc("POST /api/messages/{id}/forward", s.authed(s.forwardMessage))
	mux.HandleFunc("GET /api/calls", s.authed(s.listCalls))
	mux.HandleFunc("POST /api/upload", s.authed(s.upload))
	s.adminRoutes(mux)
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		u, ok := s.store.UserByToken(r.URL.Query().Get("token"))
		if !ok {
			httpError(w, http.StatusUnauthorized, "invalid session")
			return
		}
		s.hub.serve(w, r, u)
	})
	mux.Handle("GET /uploads/", uploadsHandler(s.uploadDir()))
	mux.HandleFunc("GET /download/chaty.apk", s.downloadAPK)
	mux.Handle("/", spaHandler(s.cfg.StaticDir))
	return withCORS(mux)
}

// ---------- helpers ----------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}
	return true
}

func serverError(w http.ResponseWriter, err error) {
	log.Printf("error: %v", err)
	httpError(w, http.StatusInternalServerError, "something went wrong")
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		h.Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type authedHandler func(w http.ResponseWriter, r *http.Request, me UserRec)

func bearerToken(r *http.Request) string {
	if t, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
		return strings.TrimSpace(t)
	}
	return ""
}

func (s *Server) authed(h authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		me, ok := s.store.UserByToken(bearerToken(r))
		if !ok {
			httpError(w, http.StatusUnauthorized, "please sign in again")
			return
		}
		h(w, r, me)
	}
}

func pathID(r *http.Request) int64 {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	return id
}

func (s *Server) features() Features { return s.settings.Get().Features }

func disabled(w http.ResponseWriter) {
	httpError(w, http.StatusForbidden, "this feature is turned off by the admin")
}

// ---------- config ----------

func (s *Server) publicConfig(w http.ResponseWriter, r *http.Request) {
	st := s.settings.Get()
	writeJSON(w, http.StatusOK, map[string]any{
		"appName": st.AppName, "registrationOpen": st.RegistrationOpen, "requireApproval": st.RequireApproval,
		"android": s.apkInfo(),
	})
}

// ---------- Android app download ----------

// The APK the admin uploaded lives in the data folder (files/downloads), so
// it survives updates and isn't part of the repository.
type apkInfo struct {
	URL       string `json:"url"`
	Version   string `json:"version"`
	Size      int64  `json:"size"`
	UpdatedAt int64  `json:"updatedAt"`
}

func (s *Server) apkPath() string { return filepath.Join(s.cfg.DataDir, "downloads", "chaty.apk") }

func (s *Server) apkInfo() *apkInfo {
	st, err := os.Stat(s.apkPath())
	if err != nil {
		return nil
	}
	info := &apkInfo{URL: "/download/chaty.apk", Size: st.Size(), UpdatedAt: st.ModTime().UnixMilli()}
	if b, err := os.ReadFile(s.apkPath() + ".json"); err == nil {
		var meta struct{ Version string }
		if json.Unmarshal(b, &meta) == nil {
			info.Version = meta.Version
		}
	}
	return info
}

func (s *Server) downloadAPK(w http.ResponseWriter, r *http.Request) {
	if _, err := os.Stat(s.apkPath()); err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.android.package-archive")
	w.Header().Set("Content-Disposition", `attachment; filename="chaty.apk"`)
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, s.apkPath())
}

func (s *Server) clientConfig(w http.ResponseWriter, r *http.Request, me UserRec) {
	writeJSON(w, http.StatusOK, s.clientConfigData(me.ID))
}

// clientConfigData is per user: it carries that user's own TURN login.
func (s *Server) clientConfigData(userID int64) map[string]any {
	st := s.settings.Get()
	return map[string]any{
		"appName":     st.AppName,
		"features":    st.Features,
		"maxUploadMB": st.MaxUploadMB,
		"calls": map[string]any{
			"mode":          st.Calls.Mode,
			"p2pTimeoutSec": st.Calls.P2PTimeoutSec,
			"iceServers":    s.iceServers(st.Calls, userID),
		},
	}
}

func (s *Server) iceServers(c CallSettings, userID int64) []map[string]any {
	out := []map[string]any{}
	if c.TurnEnabled {
		host := c.TurnHost
		if host == "" {
			host = s.cfg.Domain
		}
		if host == "" {
			host = c.TurnPublicIP
		}
		addr := host + ":" + strconv.Itoa(c.TurnPort)
		user, pass := turnCredentials(c.TurnSecret, userID)
		out = append(out,
			map[string]any{"urls": []string{"stun:" + addr}},
			map[string]any{
				"urls":       []string{"turn:" + addr + "?transport=udp", "turn:" + addr + "?transport=tcp"},
				"username":   user,
				"credential": pass,
			})
	}
	if len(c.STUNServers) > 0 {
		out = append(out, map[string]any{"urls": c.STUNServers})
	}
	if c.ExtraICE != "" {
		var extra []map[string]any
		if json.Unmarshal([]byte(c.ExtraICE), &extra) == nil {
			out = append(out, extra...)
		}
	}
	return out
}

// ---------- auth ----------

type authResponse struct {
	Token string `json:"token"`
	User  User   `json:"user"`
}

func (s *Server) meView(u UserRec) User {
	v := fullUser(&u)
	v.Online = true
	return v
}

func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	st := s.settings.Get()
	if !st.RegistrationOpen {
		httpError(w, http.StatusForbidden, "sign-ups are closed right now")
		return
	}
	var in struct{ Phone, Name, Password string }
	if !readJSON(w, r, &in) {
		return
	}
	phone, ok := normalizePhone(in.Phone)
	if !ok {
		httpError(w, http.StatusBadRequest, "enter a valid phone number")
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || utf8.RuneCountInString(in.Name) > 64 {
		httpError(w, http.StatusBadRequest, "enter your name (up to 64 characters)")
		return
	}
	if len(in.Password) < 6 {
		httpError(w, http.StatusBadRequest, "password must be at least 6 characters")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
	if err != nil {
		serverError(w, err)
		return
	}
	status := "active"
	if st.RequireApproval {
		status = "pending"
	}
	u, err := s.store.CreateUser(phone, in.Name, string(hash), "user", status)
	if errors.Is(err, errPhoneTaken) {
		httpError(w, http.StatusConflict, err.Error())
		return
	}
	if err != nil {
		serverError(w, err)
		return
	}
	if status == "pending" {
		s.hub.sendToUsers(s.store.AdminIDs(), "admin:pending", fullUser(&u))
		writeJSON(w, http.StatusAccepted, map[string]any{"pending": true})
		return
	}
	writeJSON(w, http.StatusOK, authResponse{Token: s.store.CreateSession(u.ID), User: s.meView(u)})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var in struct{ Phone, Password string }
	if !readJSON(w, r, &in) {
		return
	}
	phone, _ := normalizePhone(in.Phone)
	u, ok := s.store.UserByPhone(phone)
	if !ok {
		log.Printf("login: no account for %s", maskPhone(phone))
		httpError(w, http.StatusUnauthorized, "there's no account with this phone number")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(in.Password)) != nil {
		log.Printf("login: wrong password for %s", maskPhone(phone))
		httpError(w, http.StatusUnauthorized, "wrong password")
		return
	}
	if u.Status != "active" {
		log.Printf("login: %s is %s", maskPhone(phone), u.Status)
	}
	switch u.Status {
	case "pending":
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "your account is waiting for admin approval", "code": "pending"})
		return
	case "blocked":
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "your account has been blocked", "code": "blocked"})
		return
	}
	writeJSON(w, http.StatusOK, authResponse{Token: s.store.CreateSession(u.ID), User: s.meView(u)})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request, me UserRec) {
	s.store.DeleteSession(bearerToken(r))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request, me UserRec) {
	writeJSON(w, http.StatusOK, s.meView(me))
}

func (s *Server) updateMe(w http.ResponseWriter, r *http.Request, me UserRec) {
	var in struct {
		Name            *string `json:"name"`
		About           *string `json:"about"`
		Avatar          *string `json:"avatar"`
		Username        *string `json:"username"`
		HidePhoneSearch *bool   `json:"hidePhoneSearch"`
		HideLastSeen    *bool   `json:"hideLastSeen"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.Name != nil {
		if n := strings.TrimSpace(*in.Name); n == "" || utf8.RuneCountInString(n) > 64 {
			httpError(w, http.StatusBadRequest, "name must be 1-64 characters")
			return
		}
	}
	if in.About != nil && utf8.RuneCountInString(*in.About) > 140 {
		httpError(w, http.StatusBadRequest, "status must be at most 140 characters")
		return
	}
	if in.Avatar != nil && *in.Avatar != "" && !strings.HasPrefix(*in.Avatar, "/uploads/") {
		httpError(w, http.StatusBadRequest, "invalid avatar")
		return
	}
	if in.Username != nil {
		name := strings.TrimPrefix(strings.TrimSpace(*in.Username), "@")
		if name != "" {
			if _, ok := normalizeUsername(name); !ok {
				httpError(w, http.StatusBadRequest, "ID must be 4-32 letters, numbers or _ and start with a letter")
				return
			}
		}
		if _, err := s.store.SetUsername(me.ID, name); err != nil {
			httpError(w, http.StatusConflict, err.Error())
			return
		}
	}
	wasHidden := me.HideLastSeen
	u, err := s.store.UpdateUser(me.ID, func(u *UserRec) {
		if in.Name != nil {
			u.Name = strings.TrimSpace(*in.Name)
		}
		if in.About != nil {
			u.About = strings.TrimSpace(*in.About)
		}
		if in.Avatar != nil {
			u.Avatar = *in.Avatar
		}
		if in.HidePhoneSearch != nil {
			u.HidePhoneSearch = *in.HidePhoneSearch
		}
		if in.HideLastSeen != nil {
			u.HideLastSeen = *in.HideLastSeen
		}
	})
	if err != nil {
		serverError(w, err)
		return
	}
	s.announceUser(u.ID)
	if wasHidden != u.HideLastSeen {
		s.announcePresence(u.ID, s.store.ContactIDs(u.ID))
	}
	writeJSON(w, http.StatusOK, s.meView(u))
}

// announceUser sends everyone who knows uid their own view of uid's profile.
func (s *Server) announceUser(uid int64) {
	for _, viewer := range append(s.store.ContactIDs(uid), uid) {
		if v, ok := s.store.ViewUser(uid, viewer); ok {
			if viewer == uid {
				v = s.meView(mustUser(s.store, uid))
			} else {
				s.hub.withOnline([]User{v})
			}
			s.hub.sendToUsers([]int64{viewer}, "user", v)
		}
	}
}

// announcePresence re-sends uid's presence as each viewer may now see it.
func (s *Server) announcePresence(uid int64, viewers []int64) {
	online := s.hub.isOnline(uid)
	for _, viewer := range viewers {
		v, ok := s.store.ViewUser(uid, viewer)
		if !ok {
			continue
		}
		visible := s.store.PresenceVisible(uid, viewer)
		s.hub.sendToUsers([]int64{viewer}, "presence", map[string]any{
			"userId": uid, "online": visible && online, "lastSeen": v.LastSeen,
		})
	}
}

func mustUser(st *Store, id int64) UserRec {
	u, _ := st.UserByID(id)
	return u
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request, me UserRec) {
	var in struct{ Current, Next string }
	if !readJSON(w, r, &in) {
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(me.PasswordHash), []byte(in.Current)) != nil {
		httpError(w, http.StatusBadRequest, "current password is wrong")
		return
	}
	if len(in.Next) < 6 {
		httpError(w, http.StatusBadRequest, "new password must be at least 6 characters")
		return
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte(in.Next), bcrypt.DefaultCost)
	s.store.UpdateUser(me.ID, func(u *UserRec) { u.PasswordHash = string(hash) })
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------- users & conversations ----------

func (s *Server) searchUsers(w http.ResponseWriter, r *http.Request, me UserRec) {
	writeJSON(w, http.StatusOK, s.hub.withOnline(s.store.FindUsers(r.URL.Query().Get("q"), me.ID)))
}

func (s *Server) listBlocked(w http.ResponseWriter, r *http.Request, me UserRec) {
	writeJSON(w, http.StatusOK, s.store.BlockedUsers(me.ID))
}

func (s *Server) setBlock(w http.ResponseWriter, r *http.Request, me UserRec, on bool) {
	id := pathID(r)
	if err := s.store.SetBlocked(me.ID, id, on); err != nil {
		httpError(w, http.StatusNotFound, "user not found")
		return
	}
	// The other side's view of me changes (photo, presence); my devices refresh their chats.
	s.announceUser(me.ID)
	s.announcePresence(me.ID, []int64{id})
	s.hub.sendToUsers([]int64{me.ID}, "block", map[string]any{"userId": id, "blocked": on})
	writeJSON(w, http.StatusOK, map[string]any{"blocked": on})
}

func (s *Server) blockUser(w http.ResponseWriter, r *http.Request, me UserRec) {
	s.setBlock(w, r, me, true)
}

func (s *Server) unblockUser(w http.ResponseWriter, r *http.Request, me UserRec) {
	s.setBlock(w, r, me, false)
}

// blockReason explains why a 1:1 conversation is closed, or "" if it isn't.
func (s *Server) blockReason(conv, me int64) string {
	peer := s.store.DirectPeer(conv, me)
	switch {
	case peer == 0:
		return ""
	case s.store.Blocked(me, peer):
		return "you blocked this user; unblock them to send messages"
	case s.store.Blocked(peer, me):
		return "you can't send messages to this user"
	}
	return ""
}

func (s *Server) muteConversation(w http.ResponseWriter, r *http.Request, me UserRec) {
	var in struct{ Muted bool }
	if !readJSON(w, r, &in) {
		return
	}
	if err := s.store.SetMuted(pathID(r), me.ID, in.Muted); err != nil {
		httpError(w, http.StatusNotFound, "conversation not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"muted": in.Muted})
}

func (s *Server) clearConversation(w http.ResponseWriter, r *http.Request, me UserRec) {
	id := pathID(r)
	if err := s.store.ClearHistory(id, me.ID); err != nil {
		httpError(w, http.StatusNotFound, "conversation not found")
		return
	}
	s.hub.sendToUsers([]int64{me.ID}, "conversation:cleared", map[string]any{"conversationId": id})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) leaveConversation(w http.ResponseWriter, r *http.Request, me UserRec) {
	id := pathID(r)
	if err := s.store.Leave(id, me.ID); err != nil {
		httpError(w, http.StatusNotFound, "group not found")
		return
	}
	s.hub.sendToUsers([]int64{me.ID}, "conversation:left", map[string]any{"conversationId": id})
	for _, uid := range s.store.MemberIDs(id) {
		if c, err := s.loadConversation(id, uid); err == nil {
			s.hub.sendToUsers([]int64{uid}, "conversation", c)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) loadConversation(id, viewer int64) (*Conversation, error) {
	c, err := s.store.Conversation(id, viewer)
	if err != nil {
		return nil, err
	}
	s.hub.withOnline(c.Members)
	return c, nil
}

func (s *Server) listConversations(w http.ResponseWriter, r *http.Request, me UserRec) {
	out := []*Conversation{}
	for _, id := range s.store.ConversationIDs(me.ID) {
		if c, err := s.loadConversation(id, me.ID); err == nil {
			out = append(out, c)
		}
	}
	sort.Slice(out, func(i, j int) bool { return activity(out[i]) > activity(out[j]) })
	writeJSON(w, http.StatusOK, out)
}

func activity(c *Conversation) int64 {
	if c.LastMessage != nil {
		return c.LastMessage.CreatedAt
	}
	return c.CreatedAt
}

func (s *Server) getConversation(w http.ResponseWriter, r *http.Request, me UserRec) {
	id := pathID(r)
	if !s.store.IsMember(id, me.ID) {
		httpError(w, http.StatusNotFound, "conversation not found")
		return
	}
	c, err := s.loadConversation(id, me.ID)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) openDirect(w http.ResponseWriter, r *http.Request, me UserRec) {
	var in struct {
		UserID int64  `json:"userId"`
		Query  string `json:"query"` // the phone number / ID used to find them
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.UserID == me.ID {
		httpError(w, http.StatusBadRequest, "you can't chat with yourself")
		return
	}
	if !s.store.CanReach(me.ID, in.UserID, in.Query) {
		httpError(w, http.StatusNotFound, "user not found")
		return
	}
	id, err := s.store.DirectConversation(me.ID, in.UserID)
	if err != nil {
		httpError(w, http.StatusNotFound, "user not found")
		return
	}
	c, err := s.loadConversation(id, me.ID)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) createGroup(w http.ResponseWriter, r *http.Request, me UserRec) {
	if !s.features().Groups {
		disabled(w)
		return
	}
	var in struct {
		Title     string            `json:"title"`
		MemberIDs []int64           `json:"memberIds"`
		Queries   map[string]string `json:"queries"` // userId -> phone/ID used to find a new contact
	}
	if !readJSON(w, r, &in) {
		return
	}
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" || utf8.RuneCountInString(in.Title) > 64 {
		httpError(w, http.StatusBadRequest, "group name must be 1-64 characters")
		return
	}
	if len(in.MemberIDs) == 0 || len(in.MemberIDs) > 500 {
		httpError(w, http.StatusBadRequest, "pick at least one member")
		return
	}
	// Only people you can reach, and who haven't blocked you, can be added.
	var members []int64
	for _, uid := range in.MemberIDs {
		if uid != me.ID && s.store.CanReach(me.ID, uid, in.Queries[strconv.FormatInt(uid, 10)]) && !s.store.Blocked(uid, me.ID) {
			members = append(members, uid)
		}
	}
	if len(members) == 0 {
		httpError(w, http.StatusBadRequest, "none of these people can be added")
		return
	}
	id, err := s.store.CreateGroup(in.Title, me.ID, members)
	if err != nil {
		serverError(w, err)
		return
	}
	for _, uid := range s.store.MemberIDs(id) {
		if c, err := s.loadConversation(id, uid); err == nil {
			s.hub.sendToUsers([]int64{uid}, "conversation", c)
		}
	}
	c, _ := s.loadConversation(id, me.ID)
	writeJSON(w, http.StatusOK, c)
}

// ---------- messages ----------

func (s *Server) listMessages(w http.ResponseWriter, r *http.Request, me UserRec) {
	id := pathID(r)
	if !s.store.IsMember(id, me.ID) {
		httpError(w, http.StatusNotFound, "conversation not found")
		return
	}
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 200 {
		limit = 60
	}
	writeJSON(w, http.StatusOK, s.store.Messages(id, me.ID, before, limit))
}

// publish sends a new message to every member of its conversation.
func (s *Server) publish(msg Message) {
	s.hub.sendToUsers(s.store.MemberIDs(msg.ConversationID), "message", msg)
}

func (s *Server) sendMessage(w http.ResponseWriter, r *http.Request, me UserRec) {
	id := pathID(r)
	if !s.store.IsMember(id, me.ID) {
		httpError(w, http.StatusNotFound, "conversation not found")
		return
	}
	var in struct {
		Type     string `json:"type"`
		Body     string `json:"body"`
		MediaURL string `json:"mediaUrl"`
		FileName string `json:"fileName"`
		FileSize int64  `json:"fileSize"`
		Duration int64  `json:"duration"`
		ClientID string `json:"clientId"`
		ReplyTo  int64  `json:"replyTo"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	f := s.features()
	in.Body = strings.TrimSpace(in.Body)
	switch in.Type {
	case "text":
		if in.Body == "" || utf8.RuneCountInString(in.Body) > 4000 {
			httpError(w, http.StatusBadRequest, "message must be 1-4000 characters")
			return
		}
		in.MediaURL, in.FileName, in.FileSize = "", "", 0
	case "image", "audio", "video", "file":
		if (in.Type == "image" && !f.Photos && !f.Files) || (in.Type == "audio" && !f.VoiceMessages && !f.Files) ||
			((in.Type == "video" || in.Type == "file") && !f.Files) {
			disabled(w)
			return
		}
		if !strings.HasPrefix(in.MediaURL, "/uploads/") {
			httpError(w, http.StatusBadRequest, "missing file")
			return
		}
		if utf8.RuneCountInString(in.Body) > 1000 {
			in.Body = string([]rune(in.Body)[:1000])
		}
		if utf8.RuneCountInString(in.FileName) > 200 {
			in.FileName = string([]rune(in.FileName)[:200])
		}
	default:
		httpError(w, http.StatusBadRequest, "unknown message type")
		return
	}
	if len(in.ClientID) > 64 {
		in.ClientID = in.ClientID[:64]
	}
	if reason := s.blockReason(id, me.ID); reason != "" {
		httpError(w, http.StatusForbidden, reason)
		return
	}
	msg, created := s.store.InsertMessage(MsgRec{
		ConvID: id, SenderID: me.ID, Type: in.Type, Body: in.Body, MediaURL: in.MediaURL, FileName: in.FileName,
		FileSize: in.FileSize, Duration: in.Duration, ClientID: in.ClientID, ReplyTo: in.ReplyTo,
	})
	if created {
		s.publish(msg)
	}
	writeJSON(w, http.StatusOK, msg)
}

// messageFor loads a message the user can act on.
func (s *Server) messageFor(w http.ResponseWriter, r *http.Request, me UserRec) (MsgRec, bool) {
	m, ok := s.store.Message(pathID(r))
	if !ok || !s.store.IsMember(m.ConvID, me.ID) || containsID(m.HiddenFor, me.ID) {
		httpError(w, http.StatusNotFound, "message not found")
		return m, false
	}
	return m, true
}

func (s *Server) editMessage(w http.ResponseWriter, r *http.Request, me UserRec) {
	if !s.features().EditMessages {
		disabled(w)
		return
	}
	m, ok := s.messageFor(w, r, me)
	if !ok {
		return
	}
	var in struct{ Body string }
	if !readJSON(w, r, &in) {
		return
	}
	in.Body = strings.TrimSpace(in.Body)
	if m.SenderID != me.ID || m.Type == "deleted" {
		httpError(w, http.StatusForbidden, "you can only edit your own messages")
		return
	}
	if (m.Type == "text" && in.Body == "") || utf8.RuneCountInString(in.Body) > 4000 {
		httpError(w, http.StatusBadRequest, "message must be 1-4000 characters")
		return
	}
	view, err := s.store.UpdateMessage(m.ID, func(x *MsgRec) error {
		x.Body = in.Body
		x.EditedAt = nowMs()
		return nil
	})
	if err != nil {
		serverError(w, err)
		return
	}
	s.hub.sendToUsers(s.store.MemberIDs(m.ConvID), "message:update", view)
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) deleteMessage(w http.ResponseWriter, r *http.Request, me UserRec) {
	if !s.features().DeleteMessages {
		disabled(w)
		return
	}
	m, ok := s.messageFor(w, r, me)
	if !ok {
		return
	}
	if r.URL.Query().Get("for") != "all" {
		s.store.UpdateMessage(m.ID, func(x *MsgRec) error {
			if !containsID(x.HiddenFor, me.ID) {
				x.HiddenFor = append(x.HiddenFor, me.ID)
			}
			return nil
		})
		s.hub.sendToUsers([]int64{me.ID}, "message:hide", map[string]any{"conversationId": m.ConvID, "id": m.ID})
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	if m.SenderID != me.ID && me.Role != "admin" {
		httpError(w, http.StatusForbidden, "you can only delete your own messages for everyone")
		return
	}
	view, err := s.store.UpdateMessage(m.ID, func(x *MsgRec) error {
		x.Type, x.Body, x.MediaURL, x.FileName, x.FileSize, x.Duration = "deleted", "", "", "", 0, 0
		x.Reactions, x.ReplyTo, x.ForwardedFrom = nil, 0, ""
		return nil
	})
	if err != nil {
		serverError(w, err)
		return
	}
	members := s.store.MemberIDs(m.ConvID)
	s.hub.sendToUsers(members, "message:update", view)
	if s.store.UnpinIf(m.ConvID, m.ID) {
		s.hub.sendToUsers(members, "pin", map[string]any{"conversationId": m.ConvID, "pinned": nil})
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) reactMessage(w http.ResponseWriter, r *http.Request, me UserRec) {
	if !s.features().Reactions {
		disabled(w)
		return
	}
	m, ok := s.messageFor(w, r, me)
	if !ok {
		return
	}
	var in struct{ Emoji string }
	if !readJSON(w, r, &in) {
		return
	}
	if in.Emoji == "" || utf8.RuneCountInString(in.Emoji) > 8 || m.Type == "deleted" {
		httpError(w, http.StatusBadRequest, "invalid reaction")
		return
	}
	view, err := s.store.UpdateMessage(m.ID, func(x *MsgRec) error {
		had := ""
		next := map[string][]int64{}
		for emoji, users := range x.Reactions {
			kept := []int64{}
			for _, u := range users {
				if u == me.ID {
					had = emoji
				} else {
					kept = append(kept, u)
				}
			}
			if len(kept) > 0 {
				next[emoji] = kept
			}
		}
		if had != in.Emoji { // tapping your current reaction again removes it
			next[in.Emoji] = append(next[in.Emoji], me.ID)
		}
		x.Reactions = next
		return nil
	})
	if err != nil {
		serverError(w, err)
		return
	}
	s.hub.sendToUsers(s.store.MemberIDs(m.ConvID), "message:update", view)
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) forwardMessage(w http.ResponseWriter, r *http.Request, me UserRec) {
	if !s.features().Forwarding {
		disabled(w)
		return
	}
	m, ok := s.messageFor(w, r, me)
	if !ok {
		return
	}
	var in struct {
		ConversationIDs []int64 `json:"conversationIds"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if m.Type == "deleted" || len(in.ConversationIDs) == 0 || len(in.ConversationIDs) > 20 {
		httpError(w, http.StatusBadRequest, "nothing to forward")
		return
	}
	from := m.ForwardedFrom
	if from == "" {
		if u, ok := s.store.UserByID(m.SenderID); ok {
			from = u.Name
		}
	}
	out := []Message{}
	for _, cid := range in.ConversationIDs {
		if !s.store.IsMember(cid, me.ID) || s.blockReason(cid, me.ID) != "" {
			continue
		}
		msg, _ := s.store.InsertMessage(MsgRec{
			ConvID: cid, SenderID: me.ID, Type: m.Type, Body: m.Body, MediaURL: m.MediaURL, FileName: m.FileName,
			FileSize: m.FileSize, Duration: m.Duration, ForwardedFrom: from,
		})
		s.publish(msg)
		out = append(out, msg)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) pinMessage(w http.ResponseWriter, r *http.Request, me UserRec) {
	id := pathID(r)
	if !s.store.IsMember(id, me.ID) {
		httpError(w, http.StatusNotFound, "conversation not found")
		return
	}
	var in struct {
		MessageID int64 `json:"messageId"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if err := s.store.SetPinned(id, in.MessageID); err != nil {
		httpError(w, http.StatusNotFound, "message not found")
		return
	}
	var pinned any
	if in.MessageID != 0 {
		if v, ok := s.store.MessageView(in.MessageID); ok {
			pinned = v
		}
	}
	s.hub.sendToUsers(s.store.MemberIDs(id), "pin", map[string]any{"conversationId": id, "pinned": pinned})
	writeJSON(w, http.StatusOK, map[string]any{"pinned": pinned})
}

func (s *Server) markRead(w http.ResponseWriter, r *http.Request, me UserRec) {
	id := pathID(r)
	if !s.store.IsMember(id, me.ID) {
		httpError(w, http.StatusNotFound, "conversation not found")
		return
	}
	var in struct {
		MessageID int64 `json:"messageId"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	v := s.store.MarkRead(id, me.ID, in.MessageID)
	s.hub.sendToUsers(s.store.MemberIDs(id), "read", map[string]any{"conversationId": id, "userId": me.ID, "messageId": v})
	writeJSON(w, http.StatusOK, map[string]any{"messageId": v})
}

func (s *Server) listCalls(w http.ResponseWriter, r *http.Request, me UserRec) {
	calls := s.store.CallHistory(me.ID)
	for i := range calls {
		calls[i].Peer.Online = s.hub.isOnline(calls[i].Peer.ID)
	}
	writeJSON(w, http.StatusOK, calls)
}

// ---------- uploads ----------

// Media plays inline; everything else is served as a download so nothing
// uploaded can ever run as a page on this origin.
var inlineTypes = map[string]string{
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
	".bmp": "image/bmp", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".mp3": "audio/mpeg",
	".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".webm": "video/webm", ".mp4": "video/mp4",
	".m4v": "video/mp4", ".mov": "video/quicktime",
}

var mimeExt = map[string]string{
	"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
	"audio/webm": ".webm", "video/webm": ".webm", "audio/ogg": ".ogg", "application/ogg": ".ogg",
	"audio/mpeg": ".mp3", "audio/mp4": ".m4a", "video/mp4": ".mp4", "audio/aac": ".aac", "audio/wav": ".wav",
	"video/quicktime": ".mov", "application/pdf": ".pdf",
}

var extRe = regexp.MustCompile(`^\.[a-z0-9]{1,10}$`)

func uploadCategory(ext string) string {
	switch ext {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp":
		return "image"
	case ".ogg", ".oga", ".opus", ".mp3", ".m4a", ".aac", ".wav", ".webm":
		return "audio"
	case ".mp4", ".m4v", ".mov":
		return "video"
	}
	return "file"
}

func (s *Server) uploadDir() string { return filepath.Join(s.cfg.DataDir, "uploads") }

func (s *Server) upload(w http.ResponseWriter, r *http.Request, me UserRec) {
	st := s.settings.Get()
	limit := int64(st.MaxUploadMB) << 20
	r.Body = http.MaxBytesReader(w, r.Body, limit+1<<20)
	file, header, err := r.FormFile("file")
	if err != nil {
		httpError(w, http.StatusBadRequest, "file is missing or larger than "+strconv.Itoa(st.MaxUploadMB)+" MB")
		return
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !extRe.MatchString(ext) {
		ct := strings.TrimSpace(strings.Split(header.Header.Get("Content-Type"), ";")[0])
		ext = mimeExt[ct]
		if ext == "" {
			head := make([]byte, 512)
			n, _ := io.ReadFull(file, head)
			ext = mimeExt[http.DetectContentType(head[:n])]
			file.Seek(0, io.SeekStart)
		}
		if ext == "" {
			ext = ".bin"
		}
	}
	f := st.Features
	switch cat := uploadCategory(ext); {
	case cat == "image" && !f.Photos && !f.Files,
		cat == "audio" && !f.VoiceMessages && !f.Files,
		(cat == "video" || cat == "file") && !f.Files:
		disabled(w)
		return
	}

	dir := s.uploadDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		serverError(w, err)
		return
	}
	name := randomHex(12) + ext
	out, err := os.Create(filepath.Join(dir, name))
	if err != nil {
		serverError(w, err)
		return
	}
	defer out.Close()
	size, err := io.Copy(out, file)
	if err != nil {
		os.Remove(out.Name())
		httpError(w, http.StatusBadRequest, "upload failed or file is too large")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"url": "/uploads/" + name, "name": header.Filename, "size": size})
}

var uploadNameRe = regexp.MustCompile(`^[a-f0-9]{24}\.[a-z0-9]{1,10}$`)

func uploadsHandler(dir string) http.Handler {
	fs := http.StripPrefix("/uploads/", http.FileServer(http.Dir(dir)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/uploads/")
		if !uploadNameRe.MatchString(name) {
			http.NotFound(w, r)
			return
		}
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
		if ct, ok := inlineTypes[filepath.Ext(name)]; ok {
			h.Set("Content-Type", ct)
		} else {
			download := r.URL.Query().Get("name")
			if download == "" {
				download = name
			}
			h.Set("Content-Type", "application/octet-stream")
			h.Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(download))
		}
		fs.ServeHTTP(w, r)
	})
}

// spaHandler serves the built web: the landing page at /, the app at /app/
// (index.html, also what the Android app opens), and static files.
func spaHandler(dir string) http.Handler {
	if dir == "" {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				httpError(w, http.StatusNotFound, "not found")
				return
			}
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			io.WriteString(w, "Chaty server is running.\nThe web app isn't built yet: run `npm run build` in the project root, or use the dev server (npm run dev).\n")
		})
	}
	fs := http.FileServer(http.Dir(dir))
	app := filepath.Join(dir, "index.html")
	landing := filepath.Join(dir, "landing.html")
	if _, err := os.Stat(landing); err != nil {
		landing = app // older builds without a landing page
	}
	page := func(w http.ResponseWriter, r *http.Request, file string) {
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, file)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.HasPrefix(path, "/api/"):
			httpError(w, http.StatusNotFound, "not found")
			return
		case path == "/app":
			http.Redirect(w, r, "/app/", http.StatusMovedPermanently)
			return
		case strings.HasPrefix(path, "/app/"):
			page(w, r, app)
			return
		case path == "/":
			page(w, r, landing)
			return
		}
		p := filepath.Join(dir, filepath.FromSlash(filepath.Clean("/"+path)))
		if st, err := os.Stat(p); err != nil || st.IsDir() {
			page(w, r, landing)
			return
		}
		switch {
		case strings.HasPrefix(path, "/assets/"):
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		case path == "/sw.js" || path == "/manifest.webmanifest" || strings.HasSuffix(path, ".html"):
			w.Header().Set("Cache-Control", "no-cache")
		}
		fs.ServeHTTP(w, r)
	})
}
