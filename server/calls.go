package main

import (
	"encoding/json"
	"time"
)

// Call signaling. Media flows peer-to-peer over WebRTC; the server only
// relays SDP/ICE between the two connections that took part in the call.
//
//	caller → call:invite   → callee gets call:incoming (on every device)
//	callee → call:accept   → caller gets call:accepted, callee's other devices stop ringing
//	either → call:signal   → relayed to the other side ({sdp} / {candidate} / {media})
//	either → call:end / callee → call:reject → other side gets call:ended

const ringTimeout = 45 * time.Second

type activeCall struct {
	id         string
	convID     int64
	caller     int64
	callee     int64
	kind       string
	callerConn *Client
	calleeConn *Client // set once answered
	answeredAt int64
	timer      *time.Timer
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
		fail(reason)
		return
	}
	call := &activeCall{id: d.CallID, convID: d.ConversationID, caller: c.userID, callee: callee, kind: d.Kind, callerConn: c}
	h.calls[call.id] = call
	h.inCall[c.userID] = call.id
	h.inCall[callee] = call.id
	call.timer = time.AfterFunc(ringTimeout, func() { h.finishCall(call.id, nil, "timeout") })
	h.mu.Unlock()

	h.store.InsertCall(CallRec{ID: call.id, ConvID: call.convID, CallerID: call.caller, CalleeID: callee, Kind: call.kind, Status: "ringing"})
	c.emit("call:ringing", callRef{call.id})
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
	if call == nil || call.callee != c.userID || call.calleeConn != nil {
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

	h.store.SetCallStatus(call.id, "ongoing", call.answeredAt, 0)
	callerConn.emit("call:accepted", callRef{call.id})
	for _, o := range others {
		o.emit("call:ended", map[string]any{"callId": call.id, "reason": "answered_elsewhere"})
	}
}

func (h *Hub) callReject(c *Client, raw json.RawMessage) {
	var d callRef
	if json.Unmarshal(raw, &d) != nil {
		return
	}
	h.mu.Lock()
	call := h.calls[d.CallID]
	ok := call != nil && call.callee == c.userID && call.calleeConn == nil
	h.mu.Unlock()
	if ok {
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
	ok := call != nil && (c == call.callerConn || c == call.calleeConn || (call.calleeConn == nil && c.userID == call.callee))
	h.mu.Unlock()
	if ok {
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
	if call := h.calls[d.CallID]; call != nil && call.calleeConn != nil {
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
	var notify []*Client
	if call.calleeConn != nil {
		notify = []*Client{call.callerConn, call.calleeConn}
	} else {
		notify = append(notify, call.callerConn)
		for o := range h.clients[call.callee] {
			notify = append(notify, o)
		}
	}
	h.mu.Unlock()

	status := "missed"
	switch {
	case call.answeredAt > 0:
		status = "completed"
	case reason == "rejected":
		status = "rejected"
	}
	h.store.SetCallStatus(id, status, 0, nowMs())

	for _, o := range notify {
		if o != by {
			o.emit("call:ended", map[string]any{"callId": id, "reason": reason})
		}
	}
}

// dropCallsOf ends the calls a closed connection was part of.
func (h *Hub) dropCallsOf(c *Client) {
	h.mu.Lock()
	var ids []string
	for id, call := range h.calls {
		if call.callerConn == c || call.calleeConn == c {
			ids = append(ids, id)
		}
	}
	h.mu.Unlock()
	for _, id := range ids {
		h.finishCall(id, c, "disconnected")
	}
}
