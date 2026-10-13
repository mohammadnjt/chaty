package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"
)

// Group voice calls. A group has at most one call at a time: any member
// starts it, members join and leave as they like, and it ends when the last
// one leaves. Audio goes through the server, like the relay 1:1 calls fall
// back to, so it works on any network where chatting does: each participant
// streams their microphone as WebM/Opus chunks and the server passes every
// chunk on to the others, prefixed with who sent it.
//
//	gcall:join   {conversationId}               → gcall:joined to the joiner, gcall:state to the group's members;
//	                                              when it starts, the members who are online get gcall:ring
//	                                              and the others a push notification
//	gcall:leave  {conversationId}               → gcall:state
//	gcall:signal {conversationId, to?, payload} → the other participants (or just `to`) get it with "from"
//	binary frame from a participant             → the other participants get [sender id, 4 bytes][frame]
//
// A participant whose connection drops leaves the call; the app joins again
// once it's back.

type groupCall struct {
	convID    int64
	startedBy int64
	startedAt int64
	conns     map[int64]*Client // participant -> the connection they joined from
}

func groupCallID(conv int64) string { return fmt.Sprintf("group-%d", conv) }

func (g *groupCall) state() map[string]any {
	ids := make([]int64, 0, len(g.conns))
	for uid := range g.conns {
		ids = append(ids, uid)
	}
	return map[string]any{"conversationId": g.convID, "participants": ids, "startedBy": g.startedBy, "startedAt": g.startedAt}
}

func (h *Hub) groupCallJoin(c *Client, raw json.RawMessage) {
	var d struct {
		ConversationID int64 `json:"conversationId"`
	}
	if json.Unmarshal(raw, &d) != nil {
		return
	}
	fail := func(reason string) {
		c.emit("gcall:ended", map[string]any{"conversationId": d.ConversationID, "reason": reason})
	}
	if !h.settings.Get().Features.VoiceCalls {
		fail("disabled")
		return
	}
	if t, ok := h.store.ConvType(d.ConversationID); !ok || t != "group" || !h.store.IsMember(d.ConversationID, c.userID) {
		fail("invalid")
		return
	}

	id := groupCallID(d.ConversationID)
	h.mu.Lock()
	if cur, busy := h.inCall[c.userID]; busy && cur != id {
		h.mu.Unlock()
		fail("already_in_call")
		return
	}
	g := h.groupCalls[d.ConversationID]
	started := g == nil
	if started {
		g = &groupCall{convID: d.ConversationID, startedBy: c.userID, startedAt: nowMs(), conns: map[int64]*Client{}}
		h.groupCalls[g.convID] = g
	}
	replaced := g.conns[c.userID]
	g.conns[c.userID] = c
	h.inCall[c.userID] = id
	state := g.state()
	h.mu.Unlock()

	if replaced != nil && replaced != c {
		replaced.emit("gcall:ended", map[string]any{"conversationId": g.convID, "reason": "elsewhere"})
	}
	log.Printf("group call %d: %d joined (%d in the call)", g.convID, c.userID, len(state["participants"].([]int64)))
	c.emit("gcall:joined", state)
	h.sendToUsers(h.store.MemberIDs(g.convID), "gcall:state", state)
	if started {
		h.announceGroupCall(g.convID, c.userID)
	}
}

// announceGroupCall rings the members who have the app open and sends the
// others a notification (not those who muted the group or blocked the caller).
func (h *Hub) announceGroupCall(conv, starter int64) {
	title := h.store.ConvTitle(conv)
	for _, uid := range h.store.PushRecipients(conv, starter) {
		from, ok := h.store.ViewUser(starter, uid)
		if !ok {
			continue
		}
		if h.isActive(uid) {
			h.sendToUsers([]int64{uid}, "gcall:ring", map[string]any{"conversationId": conv, "from": from})
			continue
		}
		h.push.Notify(uid, map[string]string{
			"type": "message", "title": title, "body": from.Name + " started a group call",
			"tag": fmt.Sprintf("gcall-%d", conv), "url": fmt.Sprintf("/app/#/chat/%d", conv),
		}, time.Hour)
	}
}

func (h *Hub) groupCallLeave(c *Client, raw json.RawMessage) {
	var d struct {
		ConversationID int64 `json:"conversationId"`
	}
	if json.Unmarshal(raw, &d) == nil {
		h.removeFromGroupCall(d.ConversationID, c.userID, c)
	}
}

// leaveGroupCall takes a user out of a group's call (they left the group, or were removed).
func (h *Hub) leaveGroupCall(conv, uid int64) {
	h.removeFromGroupCall(conv, uid, nil)
}

// removeFromGroupCall takes uid out of the group's call; with conn set, only
// if that's the connection they're in it from.
func (h *Hub) removeFromGroupCall(conv, uid int64, conn *Client) {
	h.mu.Lock()
	g := h.groupCalls[conv]
	cur := (*Client)(nil)
	if g != nil {
		cur = g.conns[uid]
	}
	if cur == nil || (conn != nil && cur != conn) {
		h.mu.Unlock()
		return
	}
	delete(g.conns, uid)
	if h.inCall[uid] == groupCallID(conv) {
		delete(h.inCall, uid)
	}
	ended := len(g.conns) == 0
	if ended {
		delete(h.groupCalls, conv)
	}
	state := g.state()
	h.mu.Unlock()

	if conn == nil {
		cur.emit("gcall:ended", map[string]any{"conversationId": conv, "reason": "removed"})
	}
	if ended {
		log.Printf("group call %d: ended after %ds", conv, (nowMs()-g.startedAt)/1000)
	} else {
		log.Printf("group call %d: %d left", conv, uid)
	}
	h.sendToUsers(h.store.MemberIDs(conv), "gcall:state", state)
}

func (h *Hub) groupCallSignal(c *Client, raw json.RawMessage) {
	var d struct {
		ConversationID int64           `json:"conversationId"`
		To             int64           `json:"to"`
		Payload        json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(raw, &d) != nil {
		return
	}
	var targets []*Client
	h.mu.Lock()
	if g := h.groupCalls[d.ConversationID]; g != nil && g.conns[c.userID] == c {
		for uid, o := range g.conns {
			if uid != c.userID && (d.To == 0 || d.To == uid) {
				targets = append(targets, o)
			}
		}
	}
	h.mu.Unlock()
	for _, o := range targets {
		o.emit("gcall:signal", map[string]any{"conversationId": d.ConversationID, "from": c.userID, "payload": d.Payload})
	}
}

// relayGroupMedia passes a participant's audio chunk to the others in their
// group call; false if they aren't in one.
func (h *Hub) relayGroupMedia(c *Client, data []byte) bool {
	var targets []*Client
	h.mu.Lock()
	rest, isGroup := strings.CutPrefix(h.inCall[c.userID], "group-")
	if !isGroup {
		h.mu.Unlock()
		return false
	}
	conv, _ := strconv.ParseInt(rest, 10, 64)
	if g := h.groupCalls[conv]; g != nil && g.conns[c.userID] == c {
		for uid, o := range g.conns {
			if uid != c.userID {
				targets = append(targets, o)
			}
		}
	}
	h.mu.Unlock()
	if len(targets) == 0 {
		return true
	}
	frame := make([]byte, 4+len(data))
	binary.BigEndian.PutUint32(frame, uint32(c.userID))
	copy(frame[4:], data)
	for _, o := range targets {
		o.sendMedia(frame)
	}
	return true
}

// dropGroupCallsOf takes a closed connection out of the group call it was in.
func (h *Hub) dropGroupCallsOf(c *Client) {
	h.mu.Lock()
	var convs []int64
	for conv, g := range h.groupCalls {
		if g.conns[c.userID] == c {
			convs = append(convs, conv)
		}
	}
	h.mu.Unlock()
	for _, conv := range convs {
		h.removeFromGroupCall(conv, c.userID, c)
	}
}

// sendGroupCalls tells a newly connected device about the calls going on in its groups.
func (h *Hub) sendGroupCalls(c *Client) {
	h.mu.Lock()
	states := map[int64]map[string]any{}
	for conv, g := range h.groupCalls {
		states[conv] = g.state()
	}
	h.mu.Unlock()
	for conv, st := range states {
		if h.store.IsMember(conv, c.userID) {
			c.emit("gcall:state", st)
		}
	}
}
