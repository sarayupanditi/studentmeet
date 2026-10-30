import { describe, expect, it } from "vitest";
import type { ChatMessage, Participant, SequencedEvent } from "../../../shared/protocol";
import { initialRoomState, roomReducer, type RoomState } from "./roomState";

const person = (id: string, name = id): Participant => ({
  id,
  name,
  joinedAt: 0,
  media: { audio: false, video: false, screen: false },
});

const chat = (seq: number, authorId: string, clientMsgId: string, text = "hi"): ChatMessage => ({
  id: `m${seq}`,
  clientMsgId,
  authorId,
  authorName: authorId,
  text,
  sentAt: seq,
  seq,
});

function joinedAs(selfId: string): RoomState {
  return roomReducer(initialRoomState, {
    type: "snapshot",
    selfId,
    snapshot: { roomId: "r", seq: 1, participants: [person(selfId)], messages: [], sessions: [] },
  });
}

describe("roomReducer", () => {
  it("applies events in sequence", () => {
    let s = joinedAs("a");
    s = roomReducer(s, { type: "event", event: { type: "participant_joined", participant: person("b"), seq: 2 } });
    s = roomReducer(s, { type: "event", event: { type: "chat_message", message: chat(3, "b", "x"), seq: 3 } });
    expect(s.seq).toBe(3);
    expect(Object.keys(s.participants).sort()).toEqual(["a", "b"]);
    expect(s.messages).toHaveLength(1);
  });

  it("ignores duplicate deliveries of an already applied event", () => {
    let s = joinedAs("a");
    const ev: SequencedEvent = { type: "chat_message", message: chat(2, "a", "x"), seq: 2 };
    s = roomReducer(s, { type: "event", event: ev });
    const again = roomReducer(s, { type: "event", event: ev });
    expect(again).toBe(s);
    expect(again.messages).toHaveLength(1);
  });

  it("flags a resync instead of applying an event after a gap", () => {
    const s = roomReducer(joinedAs("a"), {
      type: "event",
      event: { type: "chat_message", message: chat(5, "b", "x"), seq: 5 },
    });
    expect(s.needsResync).toBe(true);
    expect(s.seq).toBe(1);
    expect(s.messages).toHaveLength(0);
  });

  it("clears a pending message when our own message comes back, even without an ack", () => {
    let s = joinedAs("a");
    s = roomReducer(s, { type: "chat_queued", clientMsgId: "c1", text: "hello", at: 0 });
    expect(s.pending).toHaveLength(1);
    s = roomReducer(s, { type: "event", event: { type: "chat_message", message: chat(2, "a", "c1", "hello"), seq: 2 } });
    expect(s.pending).toHaveLength(0);
    expect(s.messages[0].text).toBe("hello");
  });

  it("replays missed events on resume and clears the resync flag", () => {
    let s = { ...joinedAs("a"), needsResync: true };
    s = roomReducer(s, {
      type: "replay",
      selfId: "a",
      events: [
        { type: "participant_joined", participant: person("b"), seq: 2 },
        { type: "chat_message", message: chat(3, "b", "x"), seq: 3 },
      ],
    });
    expect(s.needsResync).toBe(false);
    expect(s.seq).toBe(3);
    expect(s.status).toBe("open");
  });

  it("keeps unconfirmed pending messages across a snapshot resync", () => {
    let s = joinedAs("a");
    s = roomReducer(s, { type: "chat_queued", clientMsgId: "c1", text: "sent", at: 0 });
    s = roomReducer(s, { type: "chat_queued", clientMsgId: "c2", text: "lost", at: 0 });
    s = roomReducer(s, {
      type: "snapshot",
      selfId: "a",
      snapshot: { roomId: "r", seq: 9, participants: [person("a")], messages: [chat(9, "a", "c1", "sent")], sessions: [] },
    });
    expect(s.pending.map((p) => p.clientMsgId)).toEqual(["c2"]);
  });

  it("removes a participant who left", () => {
    let s = joinedAs("a");
    s = roomReducer(s, { type: "event", event: { type: "participant_joined", participant: person("b"), seq: 2 } });
    s = roomReducer(s, { type: "event", event: { type: "participant_left", participantId: "b", seq: 3 } });
    expect(Object.keys(s.participants)).toEqual(["a"]);
  });
});
