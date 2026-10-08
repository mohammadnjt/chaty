package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

// Admin panel API. The admin account comes from ADMIN_PHONE / ADMIN_PASSWORD in .env.

func (s *Server) adminRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/admin/overview", s.admin(s.adminOverview))
	mux.HandleFunc("GET /api/admin/users", s.admin(s.adminUsers))
	mux.HandleFunc("POST /api/admin/users/{id}/{action}", s.admin(s.adminUserAction))
	mux.HandleFunc("PUT /api/admin/settings", s.admin(s.adminSettings))
	mux.HandleFunc("POST /api/admin/storage/test", s.admin(s.adminStorageTest))
	mux.HandleFunc("POST /api/admin/storage/switch", s.admin(s.adminStorageSwitch))
	mux.HandleFunc("POST /api/admin/android", s.admin(s.adminUploadAPK))
}

func (s *Server) admin(h authedHandler) http.HandlerFunc {
	return s.authed(func(w http.ResponseWriter, r *http.Request, me UserRec) {
		if me.Role != "admin" {
			httpError(w, http.StatusForbidden, "admins only")
			return
		}
		h(w, r, me)
	})
}

func (s *Server) adminOverview(w http.ResponseWriter, r *http.Request, me UserRec) {
	storage, storageErr := s.store.w.Status()
	turnRunning, turnErr := s.turn.Status()
	writeJSON(w, http.StatusOK, map[string]any{
		"stats":    s.store.Stats(),
		"online":   s.hub.onlineCount(),
		"storage":  map[string]any{"describe": storage, "error": storageErr},
		"turn":     map[string]any{"running": turnRunning, "error": turnErr},
		"settings": s.settings.Get(),
	})
}

func (s *Server) adminUsers(w http.ResponseWriter, r *http.Request, me UserRec) {
	recs := s.store.Users()
	out := make([]User, len(recs))
	for i := range recs {
		out[i] = fullUser(&recs[i])
	}
	writeJSON(w, http.StatusOK, s.hub.withOnline(out))
}

func (s *Server) adminUserAction(w http.ResponseWriter, r *http.Request, me UserRec) {
	id := pathID(r)
	target, ok := s.store.UserByID(id)
	if !ok {
		httpError(w, http.StatusNotFound, "user not found")
		return
	}
	action := r.PathValue("action")
	envAdmin, _ := normalizePhone(s.cfg.AdminPhone)
	protected := target.ID == me.ID || target.Phone == envAdmin
	if protected && (action == "block" || action == "reject" || action == "role") {
		httpError(w, http.StatusBadRequest, "you can't do that to the main admin account")
		return
	}

	var err error
	switch action {
	case "approve", "unblock":
		target, err = s.store.UpdateUser(id, func(u *UserRec) { u.Status = "active" })
	case "block":
		target, err = s.store.UpdateUser(id, func(u *UserRec) { u.Status = "blocked" })
		s.store.DeleteUserSessions(id)
		s.hub.disconnectUser(id)
	case "reject":
		if target.Status != "pending" {
			httpError(w, http.StatusBadRequest, "only pending sign-ups can be rejected; block active users instead")
			return
		}
		if err := s.store.DeleteUser(id); err != nil {
			httpError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
		return
	case "role":
		var in struct{ Role string }
		if !readJSON(w, r, &in) {
			return
		}
		if in.Role != "admin" && in.Role != "user" {
			httpError(w, http.StatusBadRequest, "role must be admin or user")
			return
		}
		target, err = s.store.UpdateUser(id, func(u *UserRec) { u.Role = in.Role })
	case "password":
		var in struct{ Password string }
		if !readJSON(w, r, &in) {
			return
		}
		if len(in.Password) < 6 {
			httpError(w, http.StatusBadRequest, "password must be at least 6 characters")
			return
		}
		hash, _ := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
		target, err = s.store.UpdateUser(id, func(u *UserRec) { u.PasswordHash = string(hash) })
		s.store.DeleteUserSessions(id)
		s.hub.disconnectUser(id)
	default:
		httpError(w, http.StatusNotFound, "unknown action")
		return
	}
	if err != nil {
		serverError(w, err)
		return
	}
	v := fullUser(&target)
	v.Online = s.hub.isOnline(id)
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) adminSettings(w http.ResponseWriter, r *http.Request, me UserRec) {
	var in Settings
	if !readJSON(w, r, &in) {
		return
	}
	next, err := s.settings.Update(func(cur *Settings) {
		storage := cur.Storage // storage changes go through the switch endpoint
		*cur = in
		cur.Storage = storage
	})
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	turnErr := ""
	if err := s.turn.Apply(next.Calls); err != nil {
		turnErr = err.Error()
	}
	s.hub.broadcast("config", s.clientConfigData())
	writeJSON(w, http.StatusOK, map[string]any{"settings": next, "turnError": turnErr})
}

type storageReq struct {
	Driver string `json:"driver"`
	DSN    string `json:"dsn"`
}

func (s *Server) adminStorageTest(w http.ResponseWriter, r *http.Request, me UserRec) {
	var in storageReq
	if !readJSON(w, r, &in) {
		return
	}
	in.DSN = strings.TrimSpace(in.DSN)
	if in.Driver == "file" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "describe": "JSON Lines file in the data folder"})
		return
	}
	p, err := openPersister(StorageSettings(in), s.cfg.DataDir)
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer p.Close()
	n := 0
	if err := p.Load(func(record) { n++ }); err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "describe": p.Describe(), "records": n})
}

func (s *Server) adminStorageSwitch(w http.ResponseWriter, r *http.Request, me UserRec) {
	var in storageReq
	if !readJSON(w, r, &in) {
		return
	}
	in.DSN = strings.TrimSpace(in.DSN)
	cur := s.settings.Get().Storage
	if in.Driver == cur.Driver && in.DSN == cur.DSN {
		httpError(w, http.StatusBadRequest, "that storage is already in use")
		return
	}
	p, err := openPersister(StorageSettings(in), s.cfg.DataDir)
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	driver := in.Driver
	if driver == "" {
		driver = "file"
	}
	// Copies every record into the new backend, then routes new writes there.
	if err := s.store.SwitchPersister(p, driver); err != nil {
		p.Close()
		httpError(w, http.StatusBadRequest, "couldn't copy data: "+err.Error())
		return
	}
	next, err := s.settings.Update(func(st *Settings) { st.Storage = StorageSettings{Driver: driver, DSN: in.DSN} })
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "storage": next.Storage, "describe": p.Describe()})
}

// adminUploadAPK replaces the Android app offered on the landing page.
func (s *Server) adminUploadAPK(w http.ResponseWriter, r *http.Request, me UserRec) {
	r.Body = http.MaxBytesReader(w, r.Body, 300<<20)
	file, _, err := r.FormFile("file")
	if err != nil {
		httpError(w, http.StatusBadRequest, "choose an .apk file (up to 300 MB)")
		return
	}
	defer file.Close()
	head := make([]byte, 4)
	if _, err := io.ReadFull(file, head); err != nil || string(head) != "PK\x03\x04" {
		httpError(w, http.StatusBadRequest, "that isn't an APK file")
		return
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		serverError(w, err)
		return
	}
	dst := s.apkPath()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		serverError(w, err)
		return
	}
	tmp := dst + ".upload"
	out, err := os.Create(tmp)
	if err != nil {
		serverError(w, err)
		return
	}
	if _, err := io.Copy(out, file); err != nil {
		out.Close()
		os.Remove(tmp)
		httpError(w, http.StatusBadRequest, "upload failed")
		return
	}
	out.Close()
	if err := os.Rename(tmp, dst); err != nil {
		serverError(w, err)
		return
	}
	version := strings.TrimSpace(r.FormValue("version"))
	if len(version) > 32 {
		version = version[:32]
	}
	meta, _ := json.Marshal(map[string]string{"version": version})
	os.WriteFile(dst+".json", meta, 0o644)
	writeJSON(w, http.StatusOK, s.apkInfo())
}
