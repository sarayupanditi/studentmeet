import { describe, expect, it } from "vitest";
import { LIMITS } from "../../shared/protocol.js";
import { Room } from "./room.js";

describe("Room", () => {
  it("assigns strictly increasing seq numbers to every event", () => {
    const room = new Room("r1");
    const a = room.addParticipant("a", "Ana");
    const b = room.addParticipant("b", "Ben");
    const m = room.postMessage("a", "c1", "hi").event!;
    expect([a.seq, b.seq, m.seq]).toEqual([1, 2, 3]);
    expect(room.currentSeq).toBe(3);
  });

  it("stamps chat messages with the same seq as their event", () => {
    const room = new Room("r1");
    room.addParticipant("a", "Ana");
    const { message, event } = room.postMessage("a", "c1", "hello");
    expect(event?.seq).toBe(message.seq);
  });

  it("dedupes retried chat sends by clientMsgId", () => {
    const room = new Room("r1");
    room.addParticipant("a", "Ana");
    const first = room.postMessage("a", "c1", "hello");
    const retry = room.postMessage("a", "c1", "hello");
    expect(retry.event).toBeNull();
    expect(retry.message.id).toBe(first.message.id);
    expect(room.snapshot().messages).toHaveLength(1);
    expect(room.currentSeq).toBe(2);
  });

  it("treats the same clientMsgId from different authors as distinct", () => {
    const room = new Room("r1");
    room.addParticipant("a", "Ana");
    room.addParticipant("b", "Ben");
    room.postMessage("a", "c1", "from a");
    room.postMessage("b", "c1", "from b");
    expect(room.snapshot().messages).toHaveLength(2);
  });

  it("replays only the events after lastSeq", () => {
    const room = new Room("r1");
    room.addParticipant("a", "Ana");
    room.addParticipant("b", "Ben");
    room.postMessage("a", "c1", "one");
    room.postMessage("b", "c2", "two");
    const missed = room.eventsSince(2)!;
    expect(missed.map((e) => e.seq)).toEqual([3, 4]);
    expect(room.eventsSince(4)).toEqual([]);
  });

  it("returns null when the log no longer reaches back far enough", () => {
    const room = new Room("r1");
    room.addParticipant("a", "Ana");
    for (let i = 0; i < LIMITS.eventLog + 10; i++) room.postMessage("a", `c${i}`, `m${i}`);
    expect(room.eventsSince(0)).toBeNull();
    expect(room.eventsSince(room.currentSeq - 5)).toHaveLength(5);
  });

  it("returns null when the client claims a seq the server never issued", () => {
    const room = new Room("r1");
    room.addParticipant("a", "Ana");
    expect(room.eventsSince(50)).toBeNull();
  });

  it("skips no-op media updates", () => {
    const room = new Room("r1");
    room.addParticipant("a", "Ana");
    expect(room.setMedia("a", { audio: false, video: false, screen: false })).toBeNull();
    expect(room.setMedia("a", { audio: true, video: false, screen: false })?.seq).toBe(2);
    expect(room.getParticipant("a")?.media.audio).toBe(true);
  });

  it("only lets the organizer cancel a session", () => {
    const room = new Room("r1");
    room.addParticipant("a", "Ana");
    room.addParticipant("b", "Ben");
    const ev = room.scheduleSession("a", "Graphs review", Date.now() + 3_600_000, 60);
    if (ev.type !== "session_scheduled") throw new Error("unexpected event");
    expect(room.cancelSession("b", ev.session.id)).toBe("forbidden");
    expect(room.cancelSession("a", "nope")).toBe("not_found");
    const cancelled = room.cancelSession("a", ev.session.id);
    expect(typeof cancelled).toBe("object");
    expect(room.snapshot().sessions).toHaveLength(0);
  });

  it("keeps a bounded message history", () => {
    const room = new Room("r1");
    room.addParticipant("a", "Ana");
    for (let i = 0; i < LIMITS.messageHistory + 5; i++) room.postMessage("a", `c${i}`, `m${i}`);
    const msgs = room.snapshot().messages;
    expect(msgs).toHaveLength(LIMITS.messageHistory);
    expect(msgs[0].text).toBe("m5");
  });
});
