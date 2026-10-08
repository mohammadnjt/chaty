package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

// Store keeps the whole dataset in memory (fast, simple queries) and writes
// every change through the ordered writer to the configured Persister.

var (
	errNotFound      = errors.New("not found")
	errPhoneTaken    = errors.New("this phone number is already registered")
	errUsernameTaken = errors.New("this ID is already taken")
)

// ---------- persisted records ----------

type UserRec struct {
	ID           int64  `json:"id"`
	Phone        string `json:"phone"`
	Name         string `json:"name"`
	PasswordHash string `json:"passwordHash"`
	Avatar       string `json:"avatar"`
	About        string `json:"about"`
	Role         string `json:"role"`   // user | admin
	Status       string `json:"status"` // pending | active | blocked
	CreatedAt    int64  `json:"createdAt"`
	LastSeen     int64  `json:"lastSeen"`
	Username     string `json:"username,omitempty"` // public ID people can search for
	// Privacy (zero values = visible, so older records keep the defaults)
	HidePhoneSearch bool `json:"hidePhoneSearch,omitempty"`
	HideLastSeen    bool `json:"hideLastSeen,omitempty"`
}

// BlockRec: By no longer wants anything from User.
type BlockRec struct {
	By   int64 `json:"by"`
	User int64 `json:"user"`
	At   int64 `json:"at"`
}

type SessionRec struct {
	Token     string `json:"token"`
	UserID    int64  `json:"userId"`
	CreatedAt int64  `json:"createdAt"`
}

type ConvRec struct {
	ID        int64  `json:"id"`
	Type      string `json:"type"` // direct | group
	Title     string `json:"title"`
	Avatar    string `json:"avatar"`
	DirectKey string `json:"directKey,omitempty"`
	CreatedBy int64  `json:"createdBy"`
	CreatedAt int64  `json:"createdAt"`
	PinnedID  int64  `json:"pinnedId,omitempty"`
}

type MemberRec struct {
	ConvID     int64 `json:"convId"`
	UserID     int64 `json:"userId"`
	LastReadID int64 `json:"lastReadId"`
	JoinedAt   int64 `json:"joinedAt"`
	ClearedID  int64 `json:"clearedId,omitempty"` // history up to here is hidden for this member
	Muted      bool  `json:"muted,omitempty"`
}

type MsgRec struct {
	ID            int64              `json:"id"`
	ConvID        int64              `json:"convId"`
	SenderID      int64              `json:"senderId"`
	Type          string             `json:"type"` // text | image | audio | video | file | deleted
	Body          string             `json:"body"`
	MediaURL      string             `json:"mediaUrl,omitempty"`
	FileName      string             `json:"fileName,omitempty"`
	FileSize      int64              `json:"fileSize,omitempty"`
	Duration      int64              `json:"duration,omitempty"`
	ClientID      string             `json:"clientId,omitempty"`
	ReplyTo       int64              `json:"replyTo,omitempty"`
	ForwardedFrom string             `json:"forwardedFrom,omitempty"`
	Reactions     map[string][]int64 `json:"reactions,omitempty"`
	HiddenFor     []int64            `json:"hiddenFor,omitempty"`
	EditedAt      int64              `json:"editedAt,omitempty"`
	CreatedAt     int64              `json:"createdAt"`
}

type CallRec struct {
	ID         string `json:"id"`
	ConvID     int64  `json:"convId"`
	CallerID   int64  `json:"callerId"`
	CalleeID   int64  `json:"calleeId"`
	Kind       string `json:"kind"`
	Status     string `json:"status"` // ringing | ongoing | completed | missed | rejected | busy
	StartedAt  int64  `json:"startedAt"`
	AnsweredAt int64  `json:"answeredAt"`
	EndedAt    int64  `json:"endedAt"`
}

// ---------- API views ----------

type User struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Username  string `json:"username,omitempty"`
	Phone     string `json:"phone"`
	Avatar    string `json:"avatar"`
	About     string `json:"about"`
	LastSeen  int64  `json:"lastSeen"`
	Online    bool   `json:"online"`
	Role      string `json:"role,omitempty"`
	Status    string `json:"status,omitempty"`
	CreatedAt int64  `json:"createdAt,omitempty"`
	// only in your own profile
	HidePhoneSearch bool `json:"hidePhoneSearch,omitempty"`
	HideLastSeen    bool `json:"hideLastSeen,omitempty"`

	hidePresence bool // the viewer may not see online / last seen
}

type ReplyPreview struct {
	ID       int64  `json:"id"`
	SenderID int64  `json:"senderId"`
	Type     string `json:"type"`
	Body     string `json:"body"`
}

type Message struct {
	ID             int64              `json:"id"`
	ConversationID int64              `json:"conversationId"`
	SenderID       int64              `json:"senderId"`
	Type           string             `json:"type"`
	Body           string             `json:"body"`
	MediaURL       string             `json:"mediaUrl,omitempty"`
	FileName       string             `json:"fileName,omitempty"`
	FileSize       int64              `json:"fileSize,omitempty"`
	Duration       int64              `json:"duration,omitempty"`
	ClientID       string             `json:"clientId,omitempty"`
	Reply          *ReplyPreview      `json:"reply,omitempty"`
	ForwardedFrom  string             `json:"forwardedFrom,omitempty"`
	Reactions      map[string][]int64 `json:"reactions,omitempty"`
	EditedAt       int64              `json:"editedAt,omitempty"`
	CreatedAt      int64              `json:"createdAt"`
}

type Conversation struct {
	ID          int64            `json:"id"`
	Type        string           `json:"type"`
	Title       string           `json:"title"`
	Avatar      string           `json:"avatar"`
	Members     []User           `json:"members"`
	LastMessage *Message         `json:"lastMessage"`
	Pinned      *Message         `json:"pinned"`
	Unread      int              `json:"unread"`
	Reads       map[string]int64 `json:"reads"`
	CreatedAt   int64            `json:"createdAt"`
	Muted       bool             `json:"muted"`
	Blocked     bool             `json:"blocked"` // you blocked the other person (1:1 chats)
}

type CallRecord struct {
	ID             string `json:"id"`
	ConversationID int64  `json:"conversationId"`
	Kind           string `json:"kind"`
	Status         string `json:"status"`
	Direction      string `json:"direction"`
	Peer           User   `json:"peer"`
	StartedAt      int64  `json:"startedAt"`
	AnsweredAt     int64  `json:"answeredAt"`
	EndedAt        int64  `json:"endedAt"`
}

func nowMs() int64 { return time.Now().UnixMilli() }

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// normalizePhone turns "+98 913 089 5830", "۰۹۱۳…" or "9130895830" into "09130895830".
func normalizePhone(in string) (string, bool) {
	var b strings.Builder
	for _, r := range in {
		switch {
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r >= '۰' && r <= '۹':
			b.WriteRune('0' + (r - '۰'))
		case r >= '٠' && r <= '٩':
			b.WriteRune('0' + (r - '٠'))
		case unicode.IsSpace(r) || r == '-' || r == '+' || r == '(' || r == ')':
		default:
			return "", false
		}
	}
	d := b.String()
	switch {
	case strings.HasPrefix(d, "0098") && len(d) == 14:
		d = "0" + d[4:]
	case strings.HasPrefix(d, "98") && len(d) == 12:
		d = "0" + d[2:]
	case strings.HasPrefix(d, "9") && len(d) == 10:
		d = "0" + d
	}
	return d, len(d) >= 10 && len(d) <= 15
}

func maskPhone(p string) string {
	if len(p) < 8 {
		return p
	}
	return p[:4] + "•••" + p[len(p)-4:]
}

func publicUser(u *UserRec) User {
	v := User{ID: u.ID, Name: u.Name, Username: u.Username, Phone: maskPhone(u.Phone), Avatar: u.Avatar, About: u.About, LastSeen: u.LastSeen}
	if u.Role == "admin" {
		v.Role = u.Role // shown as "Admin" so people know who they're talking to
	}
	if u.HideLastSeen {
		v.LastSeen, v.hidePresence = 0, true
	}
	return v
}

func fullUser(u *UserRec) User {
	v := User{ID: u.ID, Name: u.Name, Username: u.Username, Phone: u.Phone, Avatar: u.Avatar, About: u.About,
		LastSeen: u.LastSeen, Role: u.Role, Status: u.Status, CreatedAt: u.CreatedAt,
		HidePhoneSearch: u.HidePhoneSearch, HideLastSeen: u.HideLastSeen}
	return v
}

var usernameRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_]{3,31}$`)

// normalizeUsername accepts "@Name" or "name"; returns the lookup key.
func normalizeUsername(in string) (string, bool) {
	u := strings.TrimPrefix(strings.TrimSpace(in), "@")
	return strings.ToLower(u), usernameRe.MatchString(u)
}

func directKey(a, b int64) string {
	if a > b {
		a, b = b, a
	}
	return strconv.FormatInt(a, 10) + ":" + strconv.FormatInt(b, 10)
}

func memberKey(conv, user int64) string {
	return strconv.FormatInt(conv, 10) + ":" + strconv.FormatInt(user, 10)
}

func containsID(list []int64, id int64) bool {
	for _, v := range list {
		if v == id {
			return true
		}
	}
	return false
}

// ---------- store ----------

type Store struct {
	mu sync.RWMutex

	users     map[int64]*UserRec
	byPhone   map[string]*UserRec
	sessions  map[string]*SessionRec
	convs     map[int64]*ConvRec
	direct    map[string]int64
	members   map[int64]map[int64]*MemberRec
	userConvs map[int64]map[int64]bool
	msgs      map[int64][]*MsgRec
	msgByID   map[int64]*MsgRec
	clientIdx map[string]*MsgRec
	calls     map[string]*CallRec
	userCalls map[int64][]*CallRec
	usernames map[string]*UserRec      // lower-case username -> user
	blocks    map[int64]map[int64]bool // blocker -> blocked users

	nextUser, nextConv, nextMsg int64

	w             *writer
	driver        string
	writesSinceGC int
}

func newStore(p Persister, driver string) (*Store, error) {
	s := &Store{
		users: map[int64]*UserRec{}, byPhone: map[string]*UserRec{}, sessions: map[string]*SessionRec{},
		convs: map[int64]*ConvRec{}, direct: map[string]int64{}, members: map[int64]map[int64]*MemberRec{},
		userConvs: map[int64]map[int64]bool{}, msgs: map[int64][]*MsgRec{}, msgByID: map[int64]*MsgRec{},
		clientIdx: map[string]*MsgRec{}, calls: map[string]*CallRec{}, userCalls: map[int64][]*CallRec{},
		usernames: map[string]*UserRec{}, blocks: map[int64]map[int64]bool{},
		driver: driver,
	}
	raw := map[string]map[string]json.RawMessage{}
	lines := 0
	err := p.Load(func(r record) {
		lines++
		m := raw[r.Kind]
		if m == nil {
			m = map[string]json.RawMessage{}
			raw[r.Kind] = m
		}
		if r.Data == nil {
			delete(m, r.ID)
		} else {
			m[r.ID] = r.Data
		}
	})
	if err != nil {
		return nil, err
	}
	decode := func(kind string, fn func([]byte) error) {
		for id, d := range raw[kind] {
			if err := fn(d); err != nil {
				log.Printf("storage: skipping broken %s/%s: %v", kind, id, err)
			}
		}
	}
	decode("user", func(d []byte) error {
		var u UserRec
		err := json.Unmarshal(d, &u)
		if err == nil {
			s.addUserL(&u)
		}
		return err
	})
	decode("session", func(d []byte) error {
		var x SessionRec
		err := json.Unmarshal(d, &x)
		if err == nil && s.users[x.UserID] != nil {
			s.sessions[x.Token] = &x
		}
		return err
	})
	decode("conv", func(d []byte) error {
		var c ConvRec
		err := json.Unmarshal(d, &c)
		if err == nil {
			s.addConvL(&c)
		}
		return err
	})
	decode("member", func(d []byte) error {
		var m MemberRec
		err := json.Unmarshal(d, &m)
		if err == nil && s.convs[m.ConvID] != nil {
			s.addMemberL(&m)
		}
		return err
	})
	decode("msg", func(d []byte) error {
		var m MsgRec
		err := json.Unmarshal(d, &m)
		if err == nil && s.convs[m.ConvID] != nil {
			s.addMsgL(&m)
		}
		return err
	})
	decode("block", func(d []byte) error {
		var b BlockRec
		err := json.Unmarshal(d, &b)
		if err == nil && s.users[b.By] != nil && s.users[b.User] != nil {
			s.setBlockL(b.By, b.User, true)
		}
		return err
	})
	decode("call", func(d []byte) error {
		var c CallRec
		err := json.Unmarshal(d, &c)
		if err == nil {
			s.addCallL(&c)
		}
		return err
	})
	for id := range s.msgs {
		list := s.msgs[id]
		sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	}
	for _, list := range s.userCalls {
		sort.Slice(list, func(i, j int) bool { return list[i].StartedAt < list[j].StartedAt })
	}

	s.w = newWriter(p)

	// Calls left ringing/ongoing by a previous run can't finish anymore.
	for _, c := range s.calls {
		if c.Status == "ringing" || c.Status == "ongoing" {
			c.Status = "missed"
			if c.AnsweredAt > 0 {
				c.Status = "completed"
			}
			if c.EndedAt == 0 {
				c.EndedAt = nowMs()
			}
			s.w.put("call", c.ID, c)
		}
	}

	if fp, ok := p.(*filePersister); ok && lines > 2*s.liveCountL()+1000 {
		log.Printf("storage: compacting %s (%d lines → %d records)", fp.path, lines, s.liveCountL())
		s.w.ops <- writeOp{replace: s.allRecordsL()}
	}
	return s, nil
}

func (s *Store) addUserL(u *UserRec) {
	s.users[u.ID] = u
	s.byPhone[u.Phone] = u
	if u.Username != "" {
		s.usernames[strings.ToLower(u.Username)] = u
	}
	s.nextUser = max(s.nextUser, u.ID)
}

func (s *Store) addConvL(c *ConvRec) {
	s.convs[c.ID] = c
	if c.DirectKey != "" {
		s.direct[c.DirectKey] = c.ID
	}
	s.nextConv = max(s.nextConv, c.ID)
}

func (s *Store) addMemberL(m *MemberRec) {
	if s.members[m.ConvID] == nil {
		s.members[m.ConvID] = map[int64]*MemberRec{}
	}
	s.members[m.ConvID][m.UserID] = m
	if s.userConvs[m.UserID] == nil {
		s.userConvs[m.UserID] = map[int64]bool{}
	}
	s.userConvs[m.UserID][m.ConvID] = true
}

func (s *Store) addMsgL(m *MsgRec) {
	s.msgs[m.ConvID] = append(s.msgs[m.ConvID], m)
	s.msgByID[m.ID] = m
	if m.ClientID != "" {
		s.clientIdx[strconv.FormatInt(m.SenderID, 10)+":"+m.ClientID] = m
	}
	s.nextMsg = max(s.nextMsg, m.ID)
}

func (s *Store) addCallL(c *CallRec) {
	s.calls[c.ID] = c
	s.userCalls[c.CallerID] = append(s.userCalls[c.CallerID], c)
	s.userCalls[c.CalleeID] = append(s.userCalls[c.CalleeID], c)
}

func (s *Store) liveCountL() int {
	n := len(s.users) + len(s.sessions) + len(s.convs) + len(s.msgByID) + len(s.calls)
	for _, m := range s.members {
		n += len(m)
	}
	for _, b := range s.blocks {
		n += len(b)
	}
	return n
}

func (s *Store) allRecordsL() []record {
	out := make([]record, 0, s.liveCountL())
	add := func(kind, id string, v any) {
		b, _ := json.Marshal(v)
		out = append(out, record{Kind: kind, ID: id, Data: b})
	}
	for _, u := range s.users {
		add("user", strconv.FormatInt(u.ID, 10), u)
	}
	for _, x := range s.sessions {
		add("session", x.Token, x)
	}
	for _, c := range s.convs {
		add("conv", strconv.FormatInt(c.ID, 10), c)
	}
	for _, mm := range s.members {
		for _, m := range mm {
			add("member", memberKey(m.ConvID, m.UserID), m)
		}
	}
	for _, list := range s.msgs {
		for _, m := range list {
			add("msg", strconv.FormatInt(m.ID, 10), m)
		}
	}
	for _, c := range s.calls {
		add("call", c.ID, c)
	}
	for by, set := range s.blocks {
		for user := range set {
			add("block", memberKey(by, user), BlockRec{By: by, User: user, At: nowMs()})
		}
	}
	return out
}

// persist helpers (caller holds the write lock)

func (s *Store) put(kind, id string, v any) {
	s.w.put(kind, id, v)
	s.writesSinceGC++
	if s.driver == "file" && s.writesSinceGC > max(20000, 2*s.liveCountL()) {
		s.writesSinceGC = 0
		s.w.ops <- writeOp{replace: s.allRecordsL()}
	}
}

func (s *Store) putUser(u *UserRec)     { s.put("user", strconv.FormatInt(u.ID, 10), u) }
func (s *Store) putMsg(m *MsgRec)       { s.put("msg", strconv.FormatInt(m.ID, 10), m) }
func (s *Store) putMember(m *MemberRec) { s.put("member", memberKey(m.ConvID, m.UserID), m) }
func (s *Store) putConv(c *ConvRec)     { s.put("conv", strconv.FormatInt(c.ID, 10), c) }

// SwitchPersister copies everything into p and makes it the active backend.
func (s *Store) SwitchPersister(p Persister, driver string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := p.Replace(s.allRecordsL()); err != nil {
		return err
	}
	s.w.ops <- writeOp{swap: p}
	s.driver = driver
	s.writesSinceGC = 0
	return nil
}

func (s *Store) Close() {
	s.w.Close()
}

// ---------- users & sessions ----------

func (s *Store) CreateUser(phone, name, hash, role, status string) (UserRec, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.byPhone[phone]; ok {
		return UserRec{}, errPhoneTaken
	}
	now := nowMs()
	s.nextUser++
	u := &UserRec{
		ID: s.nextUser, Phone: phone, Name: name, PasswordHash: hash, About: "Hey there! I'm using Chaty.",
		Role: role, Status: status, CreatedAt: now, LastSeen: now,
	}
	s.addUserL(u)
	s.putUser(u)
	return *u, nil
}

func (s *Store) UserByID(id int64) (UserRec, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u := s.users[id]
	if u == nil {
		return UserRec{}, false
	}
	return *u, true
}

func (s *Store) UserByPhone(phone string) (UserRec, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u := s.byPhone[phone]
	if u == nil {
		return UserRec{}, false
	}
	return *u, true
}

func (s *Store) UpdateUser(id int64, fn func(u *UserRec)) (UserRec, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.users[id]
	if u == nil {
		return UserRec{}, errNotFound
	}
	fn(u)
	s.putUser(u)
	return *u, nil
}

func (s *Store) Users() []UserRec {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]UserRec, 0, len(s.users))
	for _, u := range s.users {
		out = append(out, *u)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out
}

// DeleteUser removes an account that never joined a conversation (a rejected sign-up).
func (s *Store) DeleteUser(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.users[id]
	if u == nil {
		return errNotFound
	}
	if len(s.userConvs[id]) > 0 {
		return errors.New("this user already has conversations; block them instead")
	}
	for t, x := range s.sessions {
		if x.UserID == id {
			delete(s.sessions, t)
			s.w.del("session", t)
		}
	}
	delete(s.users, id)
	delete(s.byPhone, u.Phone)
	if u.Username != "" {
		delete(s.usernames, strings.ToLower(u.Username))
	}
	s.w.del("user", strconv.FormatInt(id, 10))
	return nil
}

// FindUsers is how people discover each other: your existing contacts and the
// admins (matching by name or ID), plus a stranger only on an exact phone
// number or exact ID. Nobody can browse the full user list, except admins, who
// can look anyone up by part of their phone number, name or ID.
func (s *Store) FindUsers(q string, viewer int64) []User {
	s.mu.RLock()
	defer s.mu.RUnlock()
	q = strings.TrimSpace(q)
	lq := strings.ToLower(strings.TrimPrefix(q, "@"))
	out := []User{}
	seen := map[int64]bool{}
	add := func(u *UserRec) {
		if !seen[u.ID] {
			seen[u.ID] = true
			out = append(out, s.viewUserL(u, viewer))
		}
	}
	matches := func(u *UserRec) bool {
		return strings.Contains(strings.ToLower(u.Name), lq) || strings.Contains(strings.ToLower(u.Username), lq)
	}
	byName := func(list []*UserRec) {
		sort.Slice(list, func(i, j int) bool { return strings.ToLower(list[i].Name) < strings.ToLower(list[j].Name) })
	}
	if q != "" {
		if u := s.findExactL(q, viewer); u != nil {
			add(u)
		}
	}
	if q != "" && s.isAdminL(viewer) {
		digits, _ := normalizePhone(q)
		var found []*UserRec
		for _, u := range s.users {
			if u.ID != viewer && u.Status == "active" && ((len(digits) >= 3 && strings.Contains(u.Phone, digits)) || matches(u)) {
				found = append(found, u)
			}
		}
		byName(found)
		for i, u := range found {
			if i == 50 {
				break
			}
			add(u)
		}
	}
	known := append(s.contactsL(viewer), s.adminsL(viewer)...)
	byName(known)
	for _, u := range known {
		if u.Status == "active" && (q == "" || matches(u)) {
			add(u)
		}
	}
	return out
}

func (s *Store) isAdminL(uid int64) bool {
	u := s.users[uid]
	return u != nil && u.Role == "admin"
}

// adminsL lists the admins viewer can see: anyone may find and message them.
func (s *Store) adminsL(viewer int64) []*UserRec {
	var out []*UserRec
	for _, u := range s.users {
		if u.Role == "admin" && u.ID != viewer && u.Status == "active" && !s.blocks[u.ID][viewer] {
			out = append(out, u)
		}
	}
	return out
}

// findExactL resolves a full phone number or an exact ID to a user the viewer may contact.
func (s *Store) findExactL(q string, viewer int64) *UserRec {
	var u *UserRec
	if key, ok := normalizeUsername(q); ok {
		u = s.usernames[key]
	}
	if u == nil && !strings.HasPrefix(q, "@") {
		if phone, ok := normalizePhone(q); ok {
			if p := s.byPhone[phone]; p != nil && (!p.HidePhoneSearch || s.isAdminL(viewer)) {
				u = p
			}
		}
	}
	if u == nil || u.ID == viewer || u.Status != "active" || s.blocks[u.ID][viewer] {
		return nil
	}
	return u
}

// CanReach reports whether viewer may start a chat with target: they already
// share a conversation, one of them is an admin, or query is the target's
// exact phone number / ID.
func (s *Store) CanReach(viewer, target int64, query string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.isContactL(viewer, target) {
		return true
	}
	if t := s.users[target]; t != nil && t.ID != viewer && t.Status == "active" && !s.blocks[target][viewer] &&
		(t.Role == "admin" || s.isAdminL(viewer)) {
		return true
	}
	u := s.findExactL(query, viewer)
	return u != nil && u.ID == target
}

func (s *Store) isContactL(a, b int64) bool {
	for cid := range s.userConvs[a] {
		if s.members[cid][b] != nil {
			return true
		}
	}
	return false
}

func (s *Store) contactsL(uid int64) []*UserRec {
	seen := map[int64]bool{}
	var out []*UserRec
	for cid := range s.userConvs[uid] {
		for mid := range s.members[cid] {
			if mid != uid && !seen[mid] {
				seen[mid] = true
				if u := s.users[mid]; u != nil {
					out = append(out, u)
				}
			}
		}
	}
	return out
}

// viewUserL is how viewer sees u: someone who blocked you shows no photo,
// status or presence; hidden "last seen" stays hidden.
func (s *Store) viewUserL(u *UserRec, viewer int64) User {
	if u.ID == viewer {
		return fullUser(u)
	}
	v := publicUser(u)
	if s.isAdminL(viewer) {
		v.Phone = u.Phone // admins see full numbers
	}
	if s.blocks[u.ID][viewer] {
		v.Avatar, v.About, v.LastSeen, v.hidePresence = "", "", 0, true
	}
	return v
}

func (s *Store) ViewUser(id, viewer int64) (User, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u := s.users[id]
	if u == nil {
		return User{}, false
	}
	return s.viewUserL(u, viewer), true
}

// PresenceAudience lists who may see uid come online / go offline.
func (s *Store) PresenceAudience(uid int64) []int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u := s.users[uid]
	if u == nil || u.HideLastSeen {
		return nil
	}
	var out []int64
	for _, c := range s.contactsL(uid) {
		if !s.blocks[uid][c.ID] {
			out = append(out, c.ID)
		}
	}
	return out
}

// PresenceVisible reports whether viewer may see target's online status.
func (s *Store) PresenceVisible(target, viewer int64) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u := s.users[target]
	return u != nil && !u.HideLastSeen && !s.blocks[target][viewer]
}

// SetUsername sets (or clears, with "") a user's public ID.
func (s *Store) SetUsername(uid int64, name string) (UserRec, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.users[uid]
	if u == nil {
		return UserRec{}, errNotFound
	}
	key := strings.ToLower(name)
	if name != "" {
		if other := s.usernames[key]; other != nil && other.ID != uid {
			return UserRec{}, errUsernameTaken
		}
	}
	if u.Username != "" {
		delete(s.usernames, strings.ToLower(u.Username))
	}
	u.Username = name
	if name != "" {
		s.usernames[key] = u
	}
	s.putUser(u)
	return *u, nil
}

// ---------- blocking ----------

func (s *Store) setBlockL(by, user int64, on bool) {
	if on {
		if s.blocks[by] == nil {
			s.blocks[by] = map[int64]bool{}
		}
		s.blocks[by][user] = true
	} else {
		delete(s.blocks[by], user)
	}
}

func (s *Store) SetBlocked(by, user int64, on bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.users[user] == nil || by == user {
		return errNotFound
	}
	s.setBlockL(by, user, on)
	if on {
		s.put("block", memberKey(by, user), BlockRec{By: by, User: user, At: nowMs()})
	} else {
		s.w.del("block", memberKey(by, user))
	}
	return nil
}

// Blocked reports whether by has blocked user.
func (s *Store) Blocked(by, user int64) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.blocks[by][user]
}

func (s *Store) BlockedUsers(by int64) []User {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []User{}
	for id := range s.blocks[by] {
		if u := s.users[id]; u != nil {
			out = append(out, s.viewUserL(u, by))
		}
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out
}

// DirectPeer returns the other member of a 1:1 conversation (0 for groups).
func (s *Store) DirectPeer(conv, me int64) int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c := s.convs[conv]
	if c == nil || c.Type != "direct" {
		return 0
	}
	for id := range s.members[conv] {
		if id != me {
			return id
		}
	}
	return 0
}

// ---------- per-member chat settings ----------

func (s *Store) SetMuted(conv, uid int64, muted bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.members[conv][uid]
	if m == nil {
		return errNotFound
	}
	m.Muted = muted
	s.putMember(m)
	return nil
}

// ClearHistory hides everything sent so far from uid. A cleared 1:1 chat
// leaves the chat list until a new message arrives.
func (s *Store) ClearHistory(conv, uid int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.members[conv][uid]
	if m == nil {
		return errNotFound
	}
	if list := s.msgs[conv]; len(list) > 0 {
		m.ClearedID = list[len(list)-1].ID
		m.LastReadID = max(m.LastReadID, m.ClearedID)
	}
	s.putMember(m)
	return nil
}

// Leave removes uid from a group.
func (s *Store) Leave(conv, uid int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.convs[conv]
	if c == nil || c.Type != "group" || s.members[conv][uid] == nil {
		return errNotFound
	}
	delete(s.members[conv], uid)
	delete(s.userConvs[uid], conv)
	s.w.del("member", memberKey(conv, uid))
	return nil
}

func (s *Store) ContactIDs(uid int64) []int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	seen := map[int64]bool{}
	var out []int64
	for cid := range s.userConvs[uid] {
		for mid := range s.members[cid] {
			if mid != uid && !seen[mid] {
				seen[mid] = true
				out = append(out, mid)
			}
		}
	}
	return out
}

func (s *Store) AdminIDs() []int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []int64
	for _, u := range s.users {
		if u.Role == "admin" && u.Status == "active" {
			out = append(out, u.ID)
		}
	}
	return out
}

func (s *Store) CreateSession(uid int64) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	x := &SessionRec{Token: randomHex(32), UserID: uid, CreatedAt: nowMs()}
	s.sessions[x.Token] = x
	s.put("session", x.Token, x)
	return x.Token
}

func (s *Store) UserByToken(token string) (UserRec, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	x := s.sessions[token]
	if x == nil {
		return UserRec{}, false
	}
	u := s.users[x.UserID]
	if u == nil || u.Status != "active" {
		return UserRec{}, false
	}
	return *u, true
}

func (s *Store) DeleteSession(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.sessions[token]; ok {
		delete(s.sessions, token)
		s.w.del("session", token)
	}
}

func (s *Store) DeleteUserSessions(uid int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for t, x := range s.sessions {
		if x.UserID == uid {
			delete(s.sessions, t)
			s.w.del("session", t)
		}
	}
}

func (s *Store) TouchLastSeen(uid int64) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := nowMs()
	if u := s.users[uid]; u != nil {
		u.LastSeen = now
		s.putUser(u)
	}
	return now
}

// ---------- conversations ----------

func (s *Store) addMemberNowL(conv, uid, at int64) {
	m := &MemberRec{ConvID: conv, UserID: uid, JoinedAt: at}
	s.addMemberL(m)
	s.putMember(m)
}

func (s *Store) DirectConversation(a, b int64) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := directKey(a, b)
	if id, ok := s.direct[key]; ok {
		return id, nil
	}
	if s.users[b] == nil || s.users[b].Status != "active" {
		return 0, errNotFound
	}
	now := nowMs()
	s.nextConv++
	c := &ConvRec{ID: s.nextConv, Type: "direct", DirectKey: key, CreatedBy: a, CreatedAt: now}
	s.addConvL(c)
	s.putConv(c)
	s.addMemberNowL(c.ID, a, now)
	s.addMemberNowL(c.ID, b, now)
	return c.ID, nil
}

func (s *Store) CreateGroup(title string, creator int64, memberIDs []int64) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := nowMs()
	s.nextConv++
	c := &ConvRec{ID: s.nextConv, Type: "group", Title: title, CreatedBy: creator, CreatedAt: now}
	s.addConvL(c)
	s.putConv(c)
	seen := map[int64]bool{}
	for i, uid := range append([]int64{creator}, memberIDs...) {
		u := s.users[uid]
		if seen[uid] || u == nil || u.Status != "active" {
			continue
		}
		seen[uid] = true
		s.addMemberNowL(c.ID, uid, now+int64(i)) // keeps the creator first
	}
	return c.ID, nil
}

func (s *Store) IsMember(conv, uid int64) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.members[conv][uid] != nil
}

func (s *Store) MemberIDs(conv int64) []int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]int64, 0, len(s.members[conv]))
	for id := range s.members[conv] {
		out = append(out, id)
	}
	return out
}

func (s *Store) ConvType(conv int64) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c := s.convs[conv]
	if c == nil {
		return "", false
	}
	return c.Type, true
}

// ConversationIDs lists a user's conversations, hiding 1:1 chats with no messages yet.
func (s *Store) ConversationIDs(uid int64) []int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []int64
	for cid := range s.userConvs[uid] {
		c := s.convs[cid]
		if c == nil {
			continue
		}
		mem := s.members[cid][uid]
		if mem == nil {
			continue
		}
		list := s.msgs[cid]
		cleared := mem.ClearedID
		if c.Type == "group" || (len(list) > 0 && list[len(list)-1].ID > cleared) {
			out = append(out, cid)
		}
	}
	return out
}

func (s *Store) Conversation(conv, viewer int64) (*Conversation, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c := s.convs[conv]
	if c == nil {
		return nil, errNotFound
	}
	v := &Conversation{ID: c.ID, Type: c.Type, Title: c.Title, Avatar: c.Avatar, CreatedAt: c.CreatedAt,
		Members: []User{}, Reads: map[string]int64{}}
	members := make([]*MemberRec, 0, len(s.members[conv]))
	for _, m := range s.members[conv] {
		members = append(members, m)
	}
	sort.Slice(members, func(i, j int) bool { return members[i].JoinedAt < members[j].JoinedAt })
	var myRead, cleared int64
	for _, m := range members {
		if u := s.users[m.UserID]; u != nil {
			v.Members = append(v.Members, s.viewUserL(u, viewer))
		}
		v.Reads[strconv.FormatInt(m.UserID, 10)] = m.LastReadID
		if m.UserID == viewer {
			myRead, cleared, v.Muted = m.LastReadID, m.ClearedID, m.Muted
		} else if c.Type == "direct" {
			v.Blocked = s.blocks[viewer][m.UserID]
		}
	}
	list := s.msgs[conv]
	for i := len(list) - 1; i >= 0; i-- {
		m := list[i]
		if m.ID <= cleared {
			break
		}
		if containsID(m.HiddenFor, viewer) {
			continue
		}
		if v.LastMessage == nil {
			view := s.viewL(m)
			v.LastMessage = &view
		}
		if m.ID <= myRead {
			break
		}
		if m.SenderID != viewer && m.Type != "deleted" {
			v.Unread++
		}
	}
	if p := s.msgByID[c.PinnedID]; p != nil && p.Type != "deleted" && p.ID > cleared {
		view := s.viewL(p)
		v.Pinned = &view
	}
	return v, nil
}

func (s *Store) SetPinned(conv, msgID int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.convs[conv]
	if c == nil {
		return errNotFound
	}
	if msgID != 0 {
		if m := s.msgByID[msgID]; m == nil || m.ConvID != conv || m.Type == "deleted" {
			return errNotFound
		}
	}
	c.PinnedID = msgID
	s.putConv(c)
	return nil
}

// UnpinIf clears the pinned message when it is msgID.
func (s *Store) UnpinIf(conv, msgID int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.convs[conv]
	if c == nil || c.PinnedID != msgID {
		return false
	}
	c.PinnedID = 0
	s.putConv(c)
	return true
}

// ---------- messages ----------

func snippet(m *MsgRec) string {
	r := []rune(m.Body)
	if len(r) > 120 {
		return string(r[:120]) + "…"
	}
	return string(r)
}

func (s *Store) viewL(m *MsgRec) Message {
	v := Message{
		ID: m.ID, ConversationID: m.ConvID, SenderID: m.SenderID, Type: m.Type, Body: m.Body,
		MediaURL: m.MediaURL, FileName: m.FileName, FileSize: m.FileSize, Duration: m.Duration,
		ClientID: m.ClientID, ForwardedFrom: m.ForwardedFrom, EditedAt: m.EditedAt, CreatedAt: m.CreatedAt,
	}
	if len(m.Reactions) > 0 {
		v.Reactions = m.Reactions
	}
	if m.ReplyTo != 0 {
		if r := s.msgByID[m.ReplyTo]; r != nil {
			v.Reply = &ReplyPreview{ID: r.ID, SenderID: r.SenderID, Type: r.Type, Body: snippet(r)}
		}
	}
	return v
}

func (s *Store) MessageView(id int64) (Message, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m := s.msgByID[id]
	if m == nil {
		return Message{}, false
	}
	return s.viewL(m), true
}

func (s *Store) Message(id int64) (MsgRec, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m := s.msgByID[id]
	if m == nil {
		return MsgRec{}, false
	}
	return *m, true
}

// InsertMessage stores m. A retried send with the same clientId returns the stored copy (created = false).
func (s *Store) InsertMessage(m MsgRec) (Message, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if m.ClientID != "" {
		if old := s.clientIdx[strconv.FormatInt(m.SenderID, 10)+":"+m.ClientID]; old != nil {
			return s.viewL(old), false
		}
	}
	if r := s.msgByID[m.ReplyTo]; r == nil || r.ConvID != m.ConvID {
		m.ReplyTo = 0
	}
	s.nextMsg++
	m.ID = s.nextMsg
	m.CreatedAt = nowMs()
	rec := &m
	s.addMsgL(rec)
	s.putMsg(rec)
	if mem := s.members[m.ConvID][m.SenderID]; mem != nil {
		mem.LastReadID = m.ID // your own message counts as read
		s.putMember(mem)
	}
	return s.viewL(rec), true
}

func (s *Store) Messages(conv, viewer, before int64, limit int) []Message {
	s.mu.RLock()
	defer s.mu.RUnlock()
	list := s.msgs[conv]
	out := []Message{}
	var cleared int64
	if mem := s.members[conv][viewer]; mem != nil {
		cleared = mem.ClearedID
	}
	for i := len(list) - 1; i >= 0 && len(out) < limit; i-- {
		m := list[i]
		if m.ID <= cleared {
			break
		}
		if (before > 0 && m.ID >= before) || containsID(m.HiddenFor, viewer) {
			continue
		}
		out = append(out, s.viewL(m))
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

func (s *Store) UpdateMessage(id int64, fn func(m *MsgRec) error) (Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.msgByID[id]
	if m == nil {
		return Message{}, errNotFound
	}
	cp := *m
	if err := fn(&cp); err != nil {
		return Message{}, err
	}
	*m = cp
	s.putMsg(m)
	return s.viewL(m), nil
}

func (s *Store) MarkRead(conv, uid, msgID int64) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	mem := s.members[conv][uid]
	if mem == nil {
		return 0
	}
	if list := s.msgs[conv]; len(list) > 0 {
		msgID = min(msgID, list[len(list)-1].ID)
	}
	if msgID > mem.LastReadID {
		mem.LastReadID = msgID
		s.putMember(mem)
	}
	return mem.LastReadID
}

// ---------- calls ----------

func (s *Store) InsertCall(c CallRec) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c.StartedAt = nowMs()
	rec := &c
	s.addCallL(rec)
	s.put("call", c.ID, rec)
}

func (s *Store) SetCallStatus(id, status string, answeredAt, endedAt int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.calls[id]
	if c == nil {
		return
	}
	c.Status = status
	if answeredAt > 0 {
		c.AnsweredAt = answeredAt
	}
	if endedAt > 0 {
		c.EndedAt = endedAt
	}
	s.put("call", c.ID, c)
}

func (s *Store) CallHistory(uid int64) []CallRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	list := s.userCalls[uid]
	out := []CallRecord{}
	for i := len(list) - 1; i >= 0 && len(out) < 200; i-- {
		c := list[i]
		peerID, dir := c.CallerID, "incoming"
		if c.CallerID == uid {
			peerID, dir = c.CalleeID, "outgoing"
		}
		peer := s.users[peerID]
		if peer == nil {
			continue
		}
		out = append(out, CallRecord{ID: c.ID, ConversationID: c.ConvID, Kind: c.Kind, Status: c.Status, Direction: dir,
			Peer: s.viewUserL(peer, uid), StartedAt: c.StartedAt, AnsweredAt: c.AnsweredAt, EndedAt: c.EndedAt})
	}
	return out
}

// ---------- stats ----------

type Stats struct {
	Users         int `json:"users"`
	Pending       int `json:"pending"`
	Blocked       int `json:"blocked"`
	Conversations int `json:"conversations"`
	Groups        int `json:"groups"`
	Messages      int `json:"messages"`
	Calls         int `json:"calls"`
}

func (s *Store) Stats() Stats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st := Stats{Users: len(s.users), Conversations: len(s.convs), Messages: len(s.msgByID), Calls: len(s.calls)}
	for _, u := range s.users {
		switch u.Status {
		case "pending":
			st.Pending++
		case "blocked":
			st.Blocked++
		}
	}
	for _, c := range s.convs {
		if c.Type == "group" {
			st.Groups++
		}
	}
	return st
}
