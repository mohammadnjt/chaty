package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Stories: a photo or video people share with everyone they have a direct
// chat with. Each one disappears after 24 hours.

const storyLifetime = 24 * time.Hour

type StoryRec struct {
	ID        int64           `json:"id"`
	UserID    int64           `json:"userId"`
	Type      string          `json:"type"` // image | video
	URL       string          `json:"url"`
	Caption   string          `json:"caption,omitempty"`
	CreatedAt int64           `json:"createdAt"`
	ExpiresAt int64           `json:"expiresAt"`
	Views     map[int64]int64 `json:"views,omitempty"` // viewer -> when
}

type Story struct {
	ID        int64  `json:"id"`
	UserID    int64  `json:"userId"`
	Type      string `json:"type"`
	URL       string `json:"url"`
	Caption   string `json:"caption,omitempty"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
	Seen      bool   `json:"seen"`
	Views     int    `json:"views,omitempty"` // only on your own stories
}

// StoryGroup is one person's current stories, oldest first.
type StoryGroup struct {
	User    User    `json:"user"`
	Stories []Story `json:"stories"`
	Unseen  bool    `json:"unseen"`
}

type StoryViewer struct {
	User User  `json:"user"`
	At   int64 `json:"at"`
}

// ---------- store ----------

func (s *Store) addStoryL(st *StoryRec) {
	s.stories[st.ID] = st
	if st.ID > s.nextStory {
		s.nextStory = st.ID
	}
}

func (s *Store) AddStory(uid int64, typ, url, caption string) Story {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextStory++
	now := nowMs()
	st := &StoryRec{ID: s.nextStory, UserID: uid, Type: typ, URL: url, Caption: caption,
		CreatedAt: now, ExpiresAt: now + storyLifetime.Milliseconds()}
	s.addStoryL(st)
	s.w.put("story", strconv.FormatInt(st.ID, 10), st)
	return s.storyViewL(st, uid)
}

// directPeersL is who sees uid's stories: people uid has a direct chat with,
// minus blocks either way.
func (s *Store) directPeersL(uid int64) map[int64]bool {
	out := map[int64]bool{}
	for cid := range s.userConvs[uid] {
		if c := s.convs[cid]; c == nil || c.Type != "direct" {
			continue
		}
		for mid := range s.members[cid] {
			if mid != uid && !s.blocks[uid][mid] && !s.blocks[mid][uid] {
				out[mid] = true
			}
		}
	}
	return out
}

func (s *Store) StoryAudience(uid int64) []int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []int64
	for id := range s.directPeersL(uid) {
		out = append(out, id)
	}
	return out
}

func (s *Store) storyVisibleL(st *StoryRec, viewer int64) bool {
	if st.ExpiresAt <= nowMs() {
		return false
	}
	if st.UserID == viewer {
		return true
	}
	owner := s.users[st.UserID]
	return owner != nil && owner.Status == "active" && s.directPeersL(st.UserID)[viewer]
}

func (s *Store) storyViewL(st *StoryRec, viewer int64) Story {
	v := Story{ID: st.ID, UserID: st.UserID, Type: st.Type, URL: st.URL, Caption: st.Caption,
		CreatedAt: st.CreatedAt, ExpiresAt: st.ExpiresAt}
	if st.UserID == viewer {
		v.Seen, v.Views = true, len(st.Views)
	} else {
		_, v.Seen = st.Views[viewer]
	}
	return v
}

// Stories returns the viewer's own stories and their contacts' (people with
// unseen stories first, then the most recent).
func (s *Store) Stories(viewer int64) (mine []Story, feed []StoryGroup) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := nowMs()
	peers := s.directPeersL(viewer)
	groups := map[int64]*StoryGroup{}
	mine = []Story{}
	for _, st := range s.stories {
		if st.ExpiresAt <= now {
			continue
		}
		if st.UserID == viewer {
			mine = append(mine, s.storyViewL(st, viewer))
			continue
		}
		owner := s.users[st.UserID]
		if owner == nil || owner.Status != "active" || !peers[st.UserID] {
			continue
		}
		g := groups[st.UserID]
		if g == nil {
			g = &StoryGroup{User: s.viewUserL(owner, viewer)}
			groups[st.UserID] = g
		}
		v := s.storyViewL(st, viewer)
		g.Stories = append(g.Stories, v)
		g.Unseen = g.Unseen || !v.Seen
	}
	byTime := func(list []Story) {
		sort.Slice(list, func(i, j int) bool { return list[i].CreatedAt < list[j].CreatedAt })
	}
	byTime(mine)
	feed = []StoryGroup{}
	for _, g := range groups {
		byTime(g.Stories)
		feed = append(feed, *g)
	}
	sort.Slice(feed, func(i, j int) bool {
		if feed[i].Unseen != feed[j].Unseen {
			return feed[i].Unseen
		}
		return feed[i].Stories[len(feed[i].Stories)-1].CreatedAt > feed[j].Stories[len(feed[j].Stories)-1].CreatedAt
	})
	return mine, feed
}

// ViewStory records that viewer has seen the story.
func (s *Store) ViewStory(id, viewer int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.stories[id]
	if st == nil || !s.storyVisibleL(st, viewer) {
		return false
	}
	if st.UserID == viewer {
		return true
	}
	if _, seen := st.Views[viewer]; !seen {
		if st.Views == nil {
			st.Views = map[int64]int64{}
		}
		st.Views[viewer] = nowMs()
		s.w.put("story", strconv.FormatInt(st.ID, 10), st)
	}
	return true
}

func (s *Store) StoryViewers(id, owner int64) ([]StoryViewer, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st := s.stories[id]
	if st == nil || st.UserID != owner {
		return nil, errNotFound
	}
	out := []StoryViewer{}
	for uid, at := range st.Views {
		if u := s.users[uid]; u != nil {
			out = append(out, StoryViewer{User: s.viewUserL(u, owner), At: at})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At > out[j].At })
	return out, nil
}

// DeleteStory removes a story; its owner or an admin may do that.
func (s *Store) DeleteStory(id, by int64) (StoryRec, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.stories[id]
	if st == nil || (st.UserID != by && !s.isAdminL(by)) {
		return StoryRec{}, errNotFound
	}
	delete(s.stories, id)
	s.w.del("story", strconv.FormatInt(id, 10))
	return *st, nil
}

// ExpireStories removes stories older than 24 hours and returns them.
func (s *Store) ExpireStories() []StoryRec {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := nowMs()
	var gone []StoryRec
	for id, st := range s.stories {
		if st.ExpiresAt <= now {
			gone = append(gone, *st)
			delete(s.stories, id)
			s.w.del("story", strconv.FormatInt(id, 10))
		}
	}
	return gone
}

// ---------- API ----------

func (s *Server) storyRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/stories", s.authed(s.listStories))
	mux.HandleFunc("POST /api/stories", s.authed(s.postStory))
	mux.HandleFunc("POST /api/stories/{id}/view", s.authed(s.viewStory))
	mux.HandleFunc("GET /api/stories/{id}/views", s.authed(s.storyViews))
	mux.HandleFunc("DELETE /api/stories/{id}", s.authed(s.deleteStory))
}

func (s *Server) listStories(w http.ResponseWriter, r *http.Request, me UserRec) {
	if !s.features().Stories {
		writeJSON(w, http.StatusOK, map[string]any{"mine": []Story{}, "feed": []StoryGroup{}})
		return
	}
	mine, feed := s.store.Stories(me.ID)
	writeJSON(w, http.StatusOK, map[string]any{"mine": mine, "feed": feed})
}

func (s *Server) postStory(w http.ResponseWriter, r *http.Request, me UserRec) {
	if !s.features().Stories {
		disabled(w)
		return
	}
	saved, ok := s.receiveFile(w, r, func(ext string) (int, string) {
		if storyType(ext) == "" {
			return http.StatusBadRequest, "a story can be a photo or a video"
		}
		return 0, ""
	})
	if !ok {
		return
	}
	caption := strings.TrimSpace(r.FormValue("caption"))
	if utf8.RuneCountInString(caption) > 300 {
		caption = string([]rune(caption)[:300])
	}
	st := s.store.AddStory(me.ID, storyType(saved.Ext), saved.URL, caption)
	s.notifyStories(me.ID)
	writeJSON(w, http.StatusOK, st)
}

func storyType(ext string) string {
	switch cat := uploadCategory(ext); {
	case cat == "image":
		return "image"
	case cat == "video" || ext == ".webm":
		return "video"
	}
	return ""
}

func (s *Server) viewStory(w http.ResponseWriter, r *http.Request, me UserRec) {
	if !s.store.ViewStory(pathID(r), me.ID) {
		httpError(w, http.StatusNotFound, "this story is no longer available")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) storyViews(w http.ResponseWriter, r *http.Request, me UserRec) {
	viewers, err := s.store.StoryViewers(pathID(r), me.ID)
	if err != nil {
		httpError(w, http.StatusNotFound, "story not found")
		return
	}
	writeJSON(w, http.StatusOK, viewers)
}

func (s *Server) deleteStory(w http.ResponseWriter, r *http.Request, me UserRec) {
	st, err := s.store.DeleteStory(pathID(r), me.ID)
	if err != nil {
		httpError(w, http.StatusNotFound, "story not found")
		return
	}
	s.removeStoryFile(st)
	s.notifyStories(st.UserID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// notifyStories tells the owner's devices and their audience to refresh.
func (s *Server) notifyStories(owner int64) {
	s.hub.sendToUsers(append(s.store.StoryAudience(owner), owner), "stories", map[string]any{"userId": owner})
}

func (s *Server) removeStoryFile(st StoryRec) {
	name := strings.TrimPrefix(st.URL, "/uploads/")
	if uploadNameRe.MatchString(name) {
		os.Remove(filepath.Join(s.uploadDir(), name))
	}
}

// expireStories runs for the life of the server, clearing out old stories
// and their files.
func (s *Server) expireStories() {
	for {
		gone := s.store.ExpireStories()
		owners := map[int64]bool{}
		for _, st := range gone {
			s.removeStoryFile(st)
			owners[st.UserID] = true
		}
		for id := range owners {
			s.notifyStories(id)
		}
		if len(gone) > 0 {
			log.Printf("stories: %d expired", len(gone))
		}
		time.Sleep(5 * time.Minute)
	}
}
