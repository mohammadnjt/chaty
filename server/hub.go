package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = 25 * time.Second
	maxInbound = 4 << 20 // relayed media chunks (keyframes) can be large
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  16 << 10,
	WriteBufferSize: 16 << 10,
	// Auth is the session token; the app is served from several origins
	// (dev server, the Go server itself, the Android WebView).
	CheckOrigin: func(r *http.Request) bool { return true },
}

type envelope struct {
	Type string `json:"type"`
	Data any    `json:"data,omitempty"`
}

type inbound struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type Client struct {
	hub      *Hub
	conn     *websocket.Conn
	userID   int64
	send     chan []byte // JSON events
	media    chan []byte // relayed call media (binary), dropped when the peer can't keep up
	done     chan struct{}
	stopOnce sync.Once
	hidden   atomic.Bool // the app is in the background on this device
}

func (c *Client) stop() {
	c.stopOnce.Do(func() {
		close(c.done)
		c.conn.Close()
	})
}

func (c *Client) sendRaw(b []byte) {
	select {
	case c.send <- b:
	case <-c.done:
	default:
		log.Printf("ws: user %d is not reading, dropping connection", c.userID)
		c.stop()
	}
}

func (c *Client) sendMedia(b []byte) {
	select {
	case c.media <- b:
	default: // a slow link loses frames instead of the whole connection
	}
}

func (c *Client) emit(typ string, data any) {
	b, err := json.Marshal(envelope{typ, data})
	if err != nil {
		log.Printf("ws: marshal %s: %v", typ, err)
		return
	}
	c.sendRaw(b)
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.stop()
	}()
	write := func(kind int, b []byte) bool {
		c.conn.SetWriteDeadline(time.Now().Add(writeWait))
		return c.conn.WriteMessage(kind, b) == nil
	}
	for {
		select {
		case b := <-c.send:
			if !write(websocket.TextMessage, b) {
				return
			}
		case b := <-c.media:
			if !write(websocket.BinaryMessage, b) {
				return
			}
		case <-ticker.C:
			if !write(websocket.PingMessage, nil) {
				return
			}
		case <-c.done:
			return
		}
	}
}

func (c *Client) readPump() {
	defer func() {
		c.hub.unregister(c)
		c.stop()
	}()
	c.conn.SetReadLimit(maxInbound)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})
	for {
		kind, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		if kind == websocket.BinaryMessage {
			c.hub.relayMedia(c, data)
			continue
		}
		var in inbound
		if err := json.Unmarshal(data, &in); err != nil {
			continue
		}
		c.hub.handle(c, in)
	}
}

// Hub tracks live connections (a user may have several devices) and active calls.
type Hub struct {
	store    *Store
	settings *SettingsStore
	// configFor builds a user's client config (set by the server).
	configFor func(userID int64) map[string]any
	push      *Pusher

	mu      sync.Mutex
	clients map[int64]map[*Client]struct{}
	calls   map[string]*activeCall
	inCall  map[int64]string // userID -> callID
}

func newHub(store *Store, settings *SettingsStore) *Hub {
	return &Hub{
		store:    store,
		settings: settings,
		clients:  map[int64]map[*Client]struct{}{},
		calls:    map[string]*activeCall{},
		inCall:   map[int64]string{},
	}
}

func (h *Hub) serve(w http.ResponseWriter, r *http.Request, user UserRec) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &Client{hub: h, conn: conn, userID: user.ID, send: make(chan []byte, 512), media: make(chan []byte, 192), done: make(chan struct{})}

	h.mu.Lock()
	set := h.clients[user.ID]
	first := set == nil
	if first {
		set = map[*Client]struct{}{}
		h.clients[user.ID] = set
	}
	set[c] = struct{}{}
	h.mu.Unlock()

	go c.writePump()

	online := []int64{}
	for _, id := range h.store.ContactIDs(user.ID) {
		if h.isOnline(id) && h.store.PresenceVisible(id, user.ID) {
			online = append(online, id)
		}
	}
	c.emit("hello", map[string]any{"online": online})
	h.resendRinging(c)
	if first {
		h.sendToUsers(h.store.PresenceAudience(user.ID), "presence", map[string]any{"userId": user.ID, "online": true})
	}

	c.readPump()
}

func (h *Hub) unregister(c *Client) {
	h.mu.Lock()
	set := h.clients[c.userID]
	delete(set, c)
	last := len(set) == 0
	if last {
		delete(h.clients, c.userID)
	}
	h.mu.Unlock()

	h.dropCallsOf(c)

	if last {
		seen := h.store.TouchLastSeen(c.userID)
		h.sendToUsers(h.store.PresenceAudience(c.userID), "presence", map[string]any{"userId": c.userID, "online": false, "lastSeen": seen})
	}
}

// disconnectUser closes every connection of a user (blocked accounts).
func (h *Hub) disconnectUser(uid int64) {
	for _, c := range h.connsOf(uid) {
		c.stop()
	}
}

func (h *Hub) isOnline(userID int64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients[userID]) > 0
}

func (h *Hub) onlineCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

func (h *Hub) withOnline(users []User) []User {
	h.mu.Lock()
	defer h.mu.Unlock()
	for i := range users {
		users[i].Online = !users[i].hidePresence && len(h.clients[users[i].ID]) > 0
	}
	return users
}

func (h *Hub) connsOf(userID int64) []*Client {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]*Client, 0, len(h.clients[userID]))
	for c := range h.clients[userID] {
		out = append(out, c)
	}
	return out
}

func (h *Hub) sendToUsers(userIDs []int64, typ string, data any) {
	b, err := json.Marshal(envelope{typ, data})
	if err != nil {
		return
	}
	for _, id := range userIDs {
		for _, c := range h.connsOf(id) {
			c.sendRaw(b)
		}
	}
}

// isActive reports whether the user has the app open in front of them on
// some device; if not, they get push notifications.
func (h *Hub) isActive(uid int64) bool {
	for _, c := range h.connsOf(uid) {
		if !c.hidden.Load() {
			return true
		}
	}
	return false
}

func (h *Hub) onlineUsers() []int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	ids := make([]int64, 0, len(h.clients))
	for id := range h.clients {
		ids = append(ids, id)
	}
	return ids
}

// refreshConfig sends a user their current config (with a fresh TURN login)
// right before they set up a call, so long-open apps never dial with an
// expired one.
func (h *Hub) refreshConfig(userID int64) {
	if h.configFor != nil && h.settings.Get().Calls.TurnEnabled {
		h.sendToUsers([]int64{userID}, "config", h.configFor(userID))
	}
}

func (h *Hub) handle(c *Client, in inbound) {
	switch in.Type {
	case "ping":
		c.emit("pong", nil)
	case "typing":
		var d struct {
			ConversationID int64  `json:"conversationId"`
			Kind           string `json:"kind"` // typing | recording
		}
		if json.Unmarshal(in.Data, &d) != nil || !h.store.IsMember(d.ConversationID, c.userID) {
			return
		}
		if peer := h.store.DirectPeer(d.ConversationID, c.userID); peer != 0 &&
			(h.store.Blocked(peer, c.userID) || h.store.Blocked(c.userID, peer)) {
			return
		}
		var others []int64
		for _, id := range h.store.MemberIDs(d.ConversationID) {
			if id != c.userID {
				others = append(others, id)
			}
		}
		h.sendToUsers(others, "typing", map[string]any{"conversationId": d.ConversationID, "userId": c.userID, "kind": d.Kind})
	case "call:invite":
		h.callInvite(c, in.Data)
	case "call:accept":
		h.callAccept(c, in.Data)
	case "call:reject":
		h.callReject(c, in.Data)
	case "call:end":
		h.callEnd(c, in.Data)
	case "call:signal":
		h.callSignal(c, in.Data)
	case "call:resume":
		h.callResume(c, in.Data)
	case "call:diag":
		h.callDiag(c, in.Data)
	case "visibility":
		var d struct {
			Hidden bool `json:"hidden"`
		}
		if json.Unmarshal(in.Data, &d) == nil {
			c.hidden.Store(d.Hidden)
		}
	}
}

// relayMedia forwards a binary media chunk to the other side of the caller's
// active call. This is the fallback path when WebRTC can't get through.
func (h *Hub) relayMedia(c *Client, data []byte) {
	var target *Client
	h.mu.Lock()
	if id, ok := h.inCall[c.userID]; ok {
		if call := h.calls[id]; call != nil && call.answeredAt > 0 {
			switch c {
			case call.callerConn:
				target = call.calleeConn
			case call.calleeConn:
				target = call.callerConn
			}
		}
	}
	h.mu.Unlock()
	if target != nil {
		target.sendMedia(data)
	}
}
