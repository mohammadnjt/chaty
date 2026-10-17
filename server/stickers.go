package main

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Sticker packs: the admin uploads stickers (files, or a pack exported from
// Telegram as a .zip), keeps the ones they want and sorts them into packs.
// People add the packs they like from Saved Messages and send them in any
// chat. A sticker is a picture (WebP, PNG, GIF), a video sticker (WebM) or an
// animated one (.tgs: gzipped Lottie JSON). The files live in the uploads
// folder like any upload, so a sticker someone sent stays in the chat after
// the admin takes it out of the packs.

const (
	maxStickerBytes  = 5 << 20  // one sticker file
	maxLottieBytes   = 16 << 20 // an animated sticker, unpacked
	maxStickerUpload = 1000     // stickers taken from one upload
)

type StickerPackRec struct {
	ID        int64  `json:"id"`
	Title     string `json:"title"`
	Order     int    `json:"order"` // where it shows among the packs
	CreatedAt int64  `json:"createdAt"`
}

type StickerRec struct {
	ID        int64  `json:"id"`
	PackID    int64  `json:"packId"` // 0: uploaded, not in a pack yet
	Pos       int64  `json:"pos"`    // its place in the pack
	URL       string `json:"url"`
	CreatedAt int64  `json:"createdAt"`
}

type Sticker struct {
	ID  int64  `json:"id"`
	URL string `json:"url"`
}

type StickerPack struct {
	ID       int64     `json:"id"`
	Title    string    `json:"title"`
	Stickers []Sticker `json:"stickers"`
	Users    int       `json:"users,omitempty"` // admins: how many people added it
}

// ---------- store ----------

func (s *Store) addStickerPackL(p *StickerPackRec) {
	s.packs[p.ID] = p
	s.nextPack = max(s.nextPack, p.ID)
}

func (s *Store) addStickerL(st *StickerRec) {
	s.stickers[st.ID] = st
	s.nextSticker = max(s.nextSticker, st.ID)
}

func (s *Store) putStickerPack(p *StickerPackRec) {
	s.put("stickerpack", strconv.FormatInt(p.ID, 10), p)
}

func (s *Store) putSticker(st *StickerRec) {
	s.put("sticker", strconv.FormatInt(st.ID, 10), st)
}

// orderedPacksL lists the packs in the order the admin set.
func (s *Store) orderedPacksL() []*StickerPackRec {
	out := make([]*StickerPackRec, 0, len(s.packs))
	for _, p := range s.packs {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// stickersByPackL gives each pack's stickers in their order (0: the unsorted ones).
func (s *Store) stickersByPackL() map[int64][]Sticker {
	recs := make([]*StickerRec, 0, len(s.stickers))
	for _, st := range s.stickers {
		recs = append(recs, st)
	}
	sort.Slice(recs, func(i, j int) bool {
		if recs[i].Pos != recs[j].Pos {
			return recs[i].Pos < recs[j].Pos
		}
		return recs[i].ID < recs[j].ID
	})
	out := map[int64][]Sticker{}
	for _, st := range recs {
		out[st.PackID] = append(out[st.PackID], Sticker{ID: st.ID, URL: st.URL})
	}
	return out
}

// lastPosL is where the last sticker of a pack is (0 if it has none).
func (s *Store) lastPosL(pack int64) int64 {
	var last int64
	for _, st := range s.stickers {
		if st.PackID == pack {
			last = max(last, st.Pos)
		}
	}
	return last
}

// StickerPacks is what people pick from: every pack with stickers in it, and
// the ones uid added, the latest first.
func (s *Store) StickerPacks(uid int64) (packs []StickerPack, mine []int64) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	byPack := s.stickersByPackL()
	packs = []StickerPack{}
	for _, p := range s.orderedPacksL() {
		if list := byPack[p.ID]; len(list) > 0 {
			packs = append(packs, StickerPack{ID: p.ID, Title: p.Title, Stickers: list})
		}
	}
	mine = []int64{}
	if u := s.users[uid]; u != nil {
		for _, id := range u.StickerPacks {
			if s.packs[id] != nil && len(byPack[id]) > 0 {
				mine = append(mine, id)
			}
		}
	}
	return packs, mine
}

// AdminStickers is the admin's view: every pack (empty ones too) and the
// stickers not in a pack yet.
func (s *Store) AdminStickers() (packs []StickerPack, unsorted []Sticker) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	byPack := s.stickersByPackL()
	users := map[int64]int{}
	for _, u := range s.users {
		for _, id := range u.StickerPacks {
			users[id]++
		}
	}
	packs = []StickerPack{}
	for _, p := range s.orderedPacksL() {
		list := byPack[p.ID]
		if list == nil {
			list = []Sticker{}
		}
		packs = append(packs, StickerPack{ID: p.ID, Title: p.Title, Stickers: list, Users: users[p.ID]})
	}
	unsorted = byPack[0]
	if unsorted == nil {
		unsorted = []Sticker{}
	}
	return packs, unsorted
}

// StickerByID finds a sticker people can send (one that's in a pack).
func (s *Store) StickerByID(id int64) (StickerRec, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st := s.stickers[id]
	if st == nil || s.packs[st.PackID] == nil {
		return StickerRec{}, false
	}
	return *st, true
}

func (s *Store) CreateStickerPack(title string) StickerPack {
	s.mu.Lock()
	defer s.mu.Unlock()
	order := 0
	for _, p := range s.packs {
		order = max(order, p.Order+1)
	}
	s.nextPack++
	p := &StickerPackRec{ID: s.nextPack, Title: title, Order: order, CreatedAt: nowMs()}
	s.addStickerPackL(p)
	s.putStickerPack(p)
	return StickerPack{ID: p.ID, Title: p.Title, Stickers: []Sticker{}}
}

func (s *Store) RenameStickerPack(id int64, title string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.packs[id]
	if p == nil {
		return errNotFound
	}
	p.Title = title
	s.putStickerPack(p)
	return nil
}

// DeleteStickerPack removes a pack, its stickers, and it from everyone's packs.
func (s *Store) DeleteStickerPack(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.packs[id] == nil {
		return errNotFound
	}
	delete(s.packs, id)
	s.w.del("stickerpack", strconv.FormatInt(id, 10))
	for sid, st := range s.stickers {
		if st.PackID == id {
			delete(s.stickers, sid)
			s.w.del("sticker", strconv.FormatInt(sid, 10))
		}
	}
	for _, u := range s.users {
		if slices.Contains(u.StickerPacks, id) {
			u.StickerPacks = slices.DeleteFunc(slices.Clone(u.StickerPacks), func(x int64) bool { return x == id })
			s.putUser(u)
		}
	}
	return nil
}

// OrderStickerPacks puts the packs in the order of ids.
func (s *Store) OrderStickerPacks(ids []int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, id := range ids {
		if p := s.packs[id]; p != nil && p.Order != i {
			p.Order = i
			s.putStickerPack(p)
		}
	}
}

// AddStickers files new stickers at the end of pack (0: unsorted).
func (s *Store) AddStickers(pack int64, urls []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if pack != 0 && s.packs[pack] == nil {
		return errNotFound
	}
	pos, now := s.lastPosL(pack), nowMs()
	for _, url := range urls {
		s.nextSticker++
		pos++
		st := &StickerRec{ID: s.nextSticker, PackID: pack, Pos: pos, URL: url, CreatedAt: now}
		s.addStickerL(st)
		s.putSticker(st)
	}
	return nil
}

// MoveStickers puts stickers at the end of another pack (0: unsorted),
// keeping their order.
func (s *Store) MoveStickers(ids []int64, pack int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if pack != 0 && s.packs[pack] == nil {
		return errNotFound
	}
	var moving []*StickerRec
	for _, id := range ids {
		if st := s.stickers[id]; st != nil && st.PackID != pack {
			moving = append(moving, st)
		}
	}
	sort.Slice(moving, func(i, j int) bool {
		if moving[i].PackID != moving[j].PackID {
			return moving[i].PackID < moving[j].PackID
		}
		return moving[i].Pos < moving[j].Pos
	})
	pos := s.lastPosL(pack)
	for _, st := range moving {
		pos++
		st.PackID, st.Pos = pack, pos
		s.putSticker(st)
	}
	return nil
}

func (s *Store) DeleteStickers(ids []int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range ids {
		if s.stickers[id] != nil {
			delete(s.stickers, id)
			s.w.del("sticker", strconv.FormatInt(id, 10))
		}
	}
}

// SetStickerPackAdded adds a pack to uid's stickers (first in line) or takes it away.
func (s *Store) SetStickerPackAdded(uid, pack int64, on bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.users[uid]
	if u == nil || (on && s.packs[pack] == nil) {
		return errNotFound
	}
	list := slices.DeleteFunc(slices.Clone(u.StickerPacks), func(x int64) bool { return x == pack })
	if on {
		list = append([]int64{pack}, list...)
	}
	u.StickerPacks = list
	s.putUser(u)
	return nil
}

// ---------- API ----------

func (s *Server) stickerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/stickers", s.authed(s.listStickers))
	mux.HandleFunc("POST /api/stickers/packs/{id}", s.authed(s.addStickerPack))
	mux.HandleFunc("DELETE /api/stickers/packs/{id}", s.authed(s.removeStickerPack))
	mux.HandleFunc("GET /api/admin/stickers", s.admin(s.adminStickers))
	mux.HandleFunc("POST /api/admin/stickers", s.admin(s.adminUploadStickers))
	mux.HandleFunc("POST /api/admin/stickers/move", s.admin(s.adminMoveStickers))
	mux.HandleFunc("POST /api/admin/stickers/delete", s.admin(s.adminDeleteStickers))
	mux.HandleFunc("POST /api/admin/sticker-packs", s.admin(s.adminCreateStickerPack))
	mux.HandleFunc("PUT /api/admin/sticker-packs/order", s.admin(s.adminOrderStickerPacks))
	mux.HandleFunc("PATCH /api/admin/sticker-packs/{id}", s.admin(s.adminRenameStickerPack))
	mux.HandleFunc("DELETE /api/admin/sticker-packs/{id}", s.admin(s.adminDeleteStickerPack))
}

func (s *Server) listStickers(w http.ResponseWriter, r *http.Request, me UserRec) {
	if !s.features().Stickers {
		writeJSON(w, http.StatusOK, map[string]any{"packs": []StickerPack{}, "mine": []int64{}})
		return
	}
	packs, mine := s.store.StickerPacks(me.ID)
	writeJSON(w, http.StatusOK, map[string]any{"packs": packs, "mine": mine})
}

func (s *Server) addStickerPack(w http.ResponseWriter, r *http.Request, me UserRec) {
	s.setStickerPack(w, r, me, true)
}

func (s *Server) removeStickerPack(w http.ResponseWriter, r *http.Request, me UserRec) {
	s.setStickerPack(w, r, me, false)
}

func (s *Server) setStickerPack(w http.ResponseWriter, r *http.Request, me UserRec, on bool) {
	if !s.features().Stickers {
		disabled(w)
		return
	}
	if err := s.store.SetStickerPackAdded(me.ID, pathID(r), on); err != nil {
		httpError(w, http.StatusNotFound, "this sticker pack is no longer available")
		return
	}
	_, mine := s.store.StickerPacks(me.ID)
	s.hub.sendToUsers([]int64{me.ID}, "stickers", map[string]any{}) // their other devices
	writeJSON(w, http.StatusOK, map[string]any{"mine": mine})
}

// stickersChanged tells everyone online to reload the packs.
func (s *Server) stickersChanged() {
	s.hub.sendToUsers(s.hub.onlineUsers(), "stickers", map[string]any{})
}

func (s *Server) adminStickers(w http.ResponseWriter, r *http.Request, me UserRec) {
	packs, unsorted := s.store.AdminStickers()
	writeJSON(w, http.StatusOK, map[string]any{"packs": packs, "unsorted": unsorted})
}

func packTitle(w http.ResponseWriter, r *http.Request) (string, bool) {
	var in struct{ Title string }
	if !readJSON(w, r, &in) {
		return "", false
	}
	title := strings.TrimSpace(in.Title)
	if title == "" || utf8.RuneCountInString(title) > 64 {
		httpError(w, http.StatusBadRequest, "pack name must be 1-64 characters")
		return "", false
	}
	return title, true
}

func (s *Server) adminCreateStickerPack(w http.ResponseWriter, r *http.Request, me UserRec) {
	title, ok := packTitle(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, s.store.CreateStickerPack(title))
}

func (s *Server) adminRenameStickerPack(w http.ResponseWriter, r *http.Request, me UserRec) {
	title, ok := packTitle(w, r)
	if !ok {
		return
	}
	if err := s.store.RenameStickerPack(pathID(r), title); err != nil {
		httpError(w, http.StatusNotFound, "sticker pack not found")
		return
	}
	s.stickersChanged()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) adminDeleteStickerPack(w http.ResponseWriter, r *http.Request, me UserRec) {
	if err := s.store.DeleteStickerPack(pathID(r)); err != nil {
		httpError(w, http.StatusNotFound, "sticker pack not found")
		return
	}
	s.stickersChanged()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) adminOrderStickerPacks(w http.ResponseWriter, r *http.Request, me UserRec) {
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	s.store.OrderStickerPacks(in.IDs)
	s.stickersChanged()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) adminMoveStickers(w http.ResponseWriter, r *http.Request, me UserRec) {
	var in struct {
		IDs    []int64 `json:"ids"`
		PackID int64   `json:"packId"` // 0: back to the unsorted ones
	}
	if !readJSON(w, r, &in) {
		return
	}
	if err := s.store.MoveStickers(in.IDs, in.PackID); err != nil {
		httpError(w, http.StatusNotFound, "sticker pack not found")
		return
	}
	s.stickersChanged()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) adminDeleteStickers(w http.ResponseWriter, r *http.Request, me UserRec) {
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	s.store.DeleteStickers(in.IDs)
	s.stickersChanged()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// stickerSource is one file of an upload: sent as it is, or inside a .zip.
type stickerSource struct {
	name string
	open func() (io.ReadCloser, error)
}

// adminUploadStickers takes sticker files and .zip packs (in the "file"
// fields) and files every sticker found in them under packId (0: unsorted),
// in the order of their names. Anything that isn't a sticker is skipped.
func (s *Server) adminUploadStickers(w http.ResponseWriter, r *http.Request, me UserRec) {
	r.Body = http.MaxBytesReader(w, r.Body, 300<<20)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		httpError(w, http.StatusBadRequest, "choose sticker files or a .zip (up to 300 MB in all)")
		return
	}
	defer r.MultipartForm.RemoveAll()
	pack, _ := strconv.ParseInt(r.FormValue("packId"), 10, 64)

	var sources []stickerSource
	for _, h := range r.MultipartForm.File["file"] {
		f, err := h.Open()
		if err != nil {
			continue
		}
		defer f.Close()
		if zr, err := zip.NewReader(f, h.Size); err == nil {
			for _, e := range zr.File {
				base := path.Base(e.Name)
				if e.FileInfo().IsDir() || strings.HasPrefix(base, ".") || strings.HasPrefix(e.Name, "__MACOSX/") {
					continue
				}
				sources = append(sources, stickerSource{name: h.Filename + "/" + e.Name, open: e.Open})
			}
			continue
		}
		sources = append(sources, stickerSource{name: h.Filename, open: func() (io.ReadCloser, error) {
			return io.NopCloser(io.NewSectionReader(f, 0, h.Size)), nil
		}})
	}
	sort.SliceStable(sources, func(i, j int) bool { return naturalLess(sources[i].name, sources[j].name) })

	dir := s.uploadDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		serverError(w, err)
		return
	}
	var urls []string
	skipped := 0
	for _, src := range sources {
		if len(urls) == maxStickerUpload {
			skipped++
			continue
		}
		data, ext := readSticker(src)
		if ext == "" {
			skipped++
			continue
		}
		name := randomHex(12) + ext
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
			serverError(w, err)
			return
		}
		queueAVIF(name)
		urls = append(urls, "/uploads/"+name)
	}
	if len(urls) == 0 {
		httpError(w, http.StatusBadRequest, "no stickers found: use WebP, PNG, GIF, WebM or .tgs files, or a .zip of them")
		return
	}
	if err := s.store.AddStickers(pack, urls); err != nil {
		httpError(w, http.StatusNotFound, "sticker pack not found")
		return
	}
	if pack != 0 {
		s.stickersChanged()
	}
	writeJSON(w, http.StatusOK, map[string]any{"added": len(urls), "skipped": skipped})
}

// readSticker reads one file of an upload and tells by its content whether
// it's a sticker, returning what to store and its extension ("" if it isn't
// one). Lottie JSON is stored gzipped, as .tgs.
func readSticker(src stickerSource) ([]byte, string) {
	rc, err := src.open()
	if err != nil {
		return nil, ""
	}
	defer rc.Close()
	data, err := io.ReadAll(io.LimitReader(rc, maxStickerBytes+1))
	if err != nil || len(data) == 0 || len(data) > maxStickerBytes {
		return nil, ""
	}
	switch {
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return data, ".webp"
	case bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")):
		return data, ".png"
	case bytes.HasPrefix(data, []byte("GIF8")):
		return data, ".gif"
	case bytes.HasPrefix(data, []byte{0xFF, 0xD8, 0xFF}):
		return data, ".jpg"
	case bytes.HasPrefix(data, []byte{0x1A, 0x45, 0xDF, 0xA3}): // WebM (Matroska)
		return data, ".webm"
	case bytes.HasPrefix(data, []byte{0x1F, 0x8B}): // .tgs
		zr, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, ""
		}
		raw, err := io.ReadAll(io.LimitReader(zr, maxLottieBytes+1))
		if err == nil && len(raw) <= maxLottieBytes && isLottie(raw) {
			return data, ".tgs"
		}
	case isLottie(data):
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		zw.Write(data)
		zw.Close()
		return buf.Bytes(), ".tgs"
	}
	return nil, ""
}

// isLottie reports whether data is a Lottie animation (and not, say, the
// pack's own description that came along in the .zip).
func isLottie(data []byte) bool {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || data[0] != '{' {
		return false
	}
	var l struct {
		W      float64           `json:"w"`
		Layers []json.RawMessage `json:"layers"`
	}
	return json.Unmarshal(data, &l) == nil && l.W > 0 && len(l.Layers) > 0
}

// naturalLess orders names the way people number files: 2.webp before 10.webp.
func naturalLess(a, b string) bool {
	for a != "" && b != "" {
		da, db := leadingDigits(a), leadingDigits(b)
		if da != "" && db != "" {
			na, nb := strings.TrimLeft(da, "0"), strings.TrimLeft(db, "0")
			if len(na) != len(nb) {
				return len(na) < len(nb)
			}
			if na != nb {
				return na < nb
			}
			a, b = a[len(da):], b[len(db):]
			continue
		}
		ra, sa := utf8.DecodeRuneInString(a)
		rb, sb := utf8.DecodeRuneInString(b)
		if ra != rb {
			return ra < rb
		}
		a, b = a[sa:], b[sb:]
	}
	return len(a) < len(b)
}

func leadingDigits(s string) string {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	return s[:i]
}
