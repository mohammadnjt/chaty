package main

import (
	"encoding/json"
	"log"
	"time"
)

// Call signaling. Media flows peer-to-peer over WebRTC; the server only
// relays SDP/ICE between the two connections that took part in the call.
//
//	caller → call:invite   → callee gets call:incoming (on every device)
//	callee → call:accept   → caller gets call:accepted, callee's other devices stop ringing
//	either → call:signal   → relayed to the other side ({sdp} / {candidate} / {media})
//	either → call:end / callee → call:reject → other side gets call:ended
//
// Phones drop their socket now and then (network switch, screen lock). An
// answered call survives that: the other side gets call:peer-reconnecting,
// and the call waits reconnectGrace for call:resume from a new connection.

const (
	ringTimeout    = 45 * time.Second
	reconnectGrace = 30 * time.Second
)

type activeCall struct {
	id         string
	convID     int64
	caller     int64
	callee     int64
	kind       string
	callerConn *Client // nil while the caller is reconnecting
	calleeConn *Client // set once answered; nil while the callee is reconnecting
	answeredAt int64
	timer      *time.Timer // ring timeout
	grace      *time.Timer // running while one side is reconnecting
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

type callRef struct {
	CallID string `json:"callId"`
}

func (h *Hub) callInvite(c *Client, raw json.RawMessage) {
	var d struct {
		CallID         string `json:"callId"`
		ConversationID int64  `json:"conversationId"`
		Kind           string `json:"kind"`
	}
	if json.Unmarshal(raw, &d) != nil || d.CallID == "" || len(d.CallID) > 64 {
		return
	}
	if d.Kind != "video" {
		d.Kind = "audio"
	}
	fail := func(reason string) {
		c.emit("call:ended", map[string]any{"callId": d.CallID, "reason": reason})
	}

	features := h.settings.Get().Features
	if (d.Kind == "video" && !features.VideoCalls) || (d.Kind == "audio" && !features.VoiceCalls) {
		fail("disabled")
		return
	}
	if t, ok := h.store.ConvType(d.ConversationID); !ok || t != "direct" || !h.store.IsMember(d.ConversationID, c.userID) {
		fail("invalid")
		return
	}
	var callee int64
	for _, id := range h.store.MemberIDs(d.ConversationID) {
		if id != c.userID {
			callee = id
		}
	}
	caller, ok := h.store.ViewUser(c.userID, callee)
	if callee == 0 || !ok {
		fail("invalid")
		return
	}
	if h.store.Blocked(c.userID, callee) || h.store.Blocked(callee, c.userID) {
		fail("blocked")
		return
	}

	h.mu.Lock()
	if _, exists := h.calls[d.CallID]; exists {
		h.mu.Unlock()
		return
	}
	if _, busy := h.inCall[c.userID]; busy {
		h.mu.Unlock()
		fail("already_in_call")
		return
	}
	_, calleeBusy := h.inCall[callee]
	calleeOnline := len(h.clients[callee]) > 0
	if calleeBusy || !calleeOnline {
		h.mu.Unlock()
		status, reason := "missed", "unavailable"
		if calleeBusy {
			status, reason = "busy", "busy"
		}
		h.store.InsertCall(CallRec{ID: d.CallID, ConvID: d.ConversationID, CallerID: c.userID, CalleeID: callee, Kind: d.Kind, Status: status, EndedAt: nowMs()})
		log.Printf("call %s: %d → %d not placed (%s)", shortID(d.CallID), c.userID, callee, reason)
		fail(reason)
		return
	}
	call := &activeCall{id: d.CallID, convID: d.ConversationID, caller: c.userID, callee: callee, kind: d.Kind, callerConn: c}
	h.calls[call.id] = call
	h.inCall[c.userID] = call.id
	h.inCall[callee] = call.id
	call.timer = time.AfterFunc(ringTimeout, func() { h.finishCall(call.id, nil, "timeout") })
	h.mu.Unlock()

	log.Printf("call %s: %s call %d → %d", shortID(call.id), call.kind, call.caller, callee)
	h.store.InsertCall(CallRec{ID: call.id, ConvID: call.convID, CallerID: call.caller, CalleeID: callee, Kind: call.kind, Status: "ringing"})
	c.emit("call:ringing", callRef{call.id})
	h.refreshConfig(callee)
	h.sendToUsers([]int64{callee}, "call:incoming", map[string]any{
		"callId":         call.id,
		"conversationId": call.convID,
		"kind":           call.kind,
		"from":           caller,
	})
}

func (h *Hub) callAccept(c *Client, raw json.RawMessage) {
	var d callRef
	if json.Unmarshal(raw, &d) != nil {
		return
	}
	h.mu.Lock()
	call := h.calls[d.CallID]
	if call == nil || call.callee != c.userID || call.answeredAt > 0 {
		h.mu.Unlock()
		if call == nil {
			c.emit("call:ended", map[string]any{"callId": d.CallID, "reason": "gone"})
		}
		return
	}
	call.calleeConn = c
	call.answeredAt = nowMs()
	call.timer.Stop()
	var others []*Client
	for o := range h.clients[call.callee] {
		if o != c {
			others = append(others, o)
		}
	}
	callerConn := call.callerConn
	h.mu.Unlock()

	log.Printf("call %s: answered by %d", shortID(call.id), call.callee)
	h.store.SetCallStatus(call.id, "ongoing", call.answeredAt, 0)
	if callerConn != nil {
		h.refreshConfig(call.caller)
		callerConn.emit("call:accepted", callRef{call.id})
	}
	for _, o := range others {
		o.emit("call:ended", map[string]any{"callId": call.id, "reason": "answered_elsewhere"})
	}
}

func (h *Hub) callReject(c *Client, raw json.RawMessage) {
	var d struct {
		CallID string `json:"callId"`
		Reason string `json:"reason"`
	}
	if json.Unmarshal(raw, &d) != nil {
		return
	}
	h.mu.Lock()
	call := h.calls[d.CallID]
	ok := call != nil && call.callee == c.userID && call.answeredAt == 0
	h.mu.Unlock()
	if ok {
		if len(d.Reason) > 120 {
			d.Reason = d.Reason[:120]
		}
		log.Printf("call %s: rejected by %d (%s)", shortID(d.CallID), c.userID, d.Reason)
		h.finishCall(d.CallID, c, "rejected")
	}
}

func (h *Hub) callEnd(c *Client, raw json.RawMessage) {
	var d callRef
	if json.Unmarshal(raw, &d) != nil {
		return
	}
	h.mu.Lock()
	call := h.calls[d.CallID]
	ok := call != nil && (c.userID == call.caller || c.userID == call.callee)
	h.mu.Unlock()
	if ok {
		log.Printf("call %s: hung up by %d", shortID(d.CallID), c.userID)
		h.finishCall(d.CallID, c, "ended")
	}
}

func (h *Hub) callSignal(c *Client, raw json.RawMessage) {
	var d struct {
		CallID  string          `json:"callId"`
		Payload json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(raw, &d) != nil {
		return
	}
	var target *Client
	h.mu.Lock()
	if call := h.calls[d.CallID]; call != nil && call.answeredAt > 0 {
		switch c {
		case call.callerConn:
			target = call.calleeConn
		case call.calleeConn:
			target = call.callerConn
		}
	}
	h.mu.Unlock()
	if target != nil {
		target.emit("call:signal", map[string]any{"callId": d.CallID, "payload": d.Payload})
	}
}

// callDiag logs a participant's short report on how their call is going (how
// media travels, whether the other side's audio arrives and plays), so a
// "can't hear" report can be traced from the server log.
func (h *Hub) callDiag(c *Client, raw json.RawMessage) {
	var d struct {
		CallID string `json:"callId"`
	}
	if json.Unmarshal(raw, &d) != nil {
		return
	}
	h.mu.Lock()
	call := h.calls[d.CallID]
	ok := call != nil && (call.caller == c.userID || call.callee == c.userID)
	h.mu.Unlock()
	if !ok {
		return
	}
	if len(raw) > 600 {
		raw = raw[:600]
	}
	log.Printf("call %s: report from %d: %s", shortID(d.CallID), c.userID, raw)
}

// finishCall tears a call down and tells everyone still involved. by is the
// connection that caused it (nil for timeouts) and is not notified.
func (h *Hub) finishCall(id string, by *Client, reason string) {
	h.mu.Lock()
	call := h.calls[id]
	if call == nil {
		h.mu.Unlock()
		return
	}
	delete(h.calls, id)
	for _, uid := range []int64{call.caller, call.callee} {
		if h.inCall[uid] == id {
			delete(h.inCall, uid)
		}
	}
	call.timer.Stop()
	if call.grace != nil {
		call.grace.Stop()
	}
	var notify []*Client
	if call.answeredAt > 0 {
		notify = []*Client{call.callerConn, call.calleeConn}
	} else {
		notify = append(notify, call.callerConn)
		for o := range h.clients[call.callee] {
			notify = append(notify, o)
		}
	}
	h.mu.Unlock()
	if call.answeredAt > 0 {
		log.Printf("call %s: ended (%s) after %ds", shortID(id), reason, (nowMs()-call.answeredAt)/1000)
	} else {
		log.Printf("call %s: ended before answer (%s)", shortID(id), reason)
	}

	status := "missed"
	switch {
	case call.answeredAt > 0:
		status = "completed"
	case reason == "rejected":
		status = "rejected"
	}
	h.store.SetCallStatus(id, status, 0, nowMs())

	for _, o := range notify {
		if o != nil && o != by {
			o.emit("call:ended", map[string]any{"callId": id, "reason": reason})
		}
	}
}

// dropCallsOf handles a closed connection: a ringing call it started ends;
// an answered call waits reconnectGrace for that side to resume.
func (h *Hub) dropCallsOf(c *Client) {
	h.mu.Lock()
	var finish []string
	type notice struct {
		to *Client
		id string
	}
	var notices []notice
	for id, call := range h.calls {
		if call.callerConn != c && call.calleeConn != c {
			continue
		}
		if call.answeredAt == 0 {
			if call.callerConn == c {
				finish = append(finish, id)
			}
			continue
		}
		var other *Client
		if call.callerConn == c {
			call.callerConn, other = nil, call.calleeConn
		} else {
			call.calleeConn, other = nil, call.callerConn
		}
		log.Printf("call %s: user %d lost connection, waiting %s to resume", shortID(id), c.userID, reconnectGrace)
		if call.grace == nil {
			call.grace = time.AfterFunc(reconnectGrace, func() { h.finishCall(id, nil, "disconnected") })
		}
		if other != nil {
			notices = append(notices, notice{other, id})
		}
	}
	h.mu.Unlock()
	for _, n := range notices {
		n.to.emit("call:peer-reconnecting", callRef{n.id})
	}
	for _, id := range finish {
		h.finishCall(id, c, "disconnected")
	}
}

// callResume reattaches a reconnected device to the call it was in.
func (h *Hub) callResume(c *Client, raw json.RawMessage) {
	var d callRef
	if json.Unmarshal(raw, &d) != nil {
		return
	}
	h.mu.Lock()
	call := h.calls[d.CallID]
	if call == nil || call.answeredAt == 0 || (c.userID != call.caller && c.userID != call.callee) {
		h.mu.Unlock()
		c.emit("call:ended", map[string]any{"callId": d.CallID, "reason": "gone"})
		return
	}
	var other *Client
	if c.userID == call.caller {
		call.callerConn, other = c, call.calleeConn
	} else {
		call.calleeConn, other = c, call.callerConn
	}
	if call.callerConn != nil && call.calleeConn != nil && call.grace != nil {
		call.grace.Stop()
		call.grace = nil
	}
	h.mu.Unlock()
	log.Printf("call %s: user %d resumed", shortID(d.CallID), c.userID)
	c.emit("call:resumed", map[string]any{"callId": d.CallID, "peerConnected": other != nil})
	if other != nil {
		other.emit("call:peer-back", callRef{d.CallID})
	}
}
