import { randomUUID } from "node:crypto";
import {
  LIMITS,
  type ChatMessage,
  type MediaState,
  type Participant,
  type RoomEvent,
  type RoomSnapshot,
  type SequencedEvent,
  type StudySession,
} from "../../shared/protocol.js";

/**
 * Authoritative state for one room.
 *
 * All mutations go through `apply`, which assigns the next sequence number,
 * updates state, and appends to a bounded event log. The log is what lets a
 * client that dropped off for a few seconds catch up with a small replay
 * instead of a full snapshot.
 *
 * This class is pure state: no sockets, no timers. That keeps it trivially
 * unit-testable and makes the ordering guarantees easy to reason about.
 */
export class Room {
  readonly id: string;
  private seq = 0;
  private participants = new Map<string, Participant>();
  private messages: ChatMessage[] = [];
  private sessions = new Map<string, StudySession>();
  private log: SequencedEvent[] = [];
  /** authorId -> (clientMsgId -> message). Makes chat sends idempotent. */
  private sentByClient = new Map<string, Map<string, ChatMessage>>();

  constructor(id: string, private now: () => number = Date.now) {
    this.id = id;
  }

  get currentSeq(): number {
    return this.seq;
  }

  get size(): number {
    return this.participants.size;
  }

  hasParticipant(id: string): boolean {
    return this.participants.has(id);
  }

  getParticipant(id: string): Participant | undefined {
    return this.participants.get(id);
  }

  snapshot(): RoomSnapshot {
    return {
      roomId: this.id,
      seq: this.seq,
      participants: [...this.participants.values()],
      messages: [...this.messages],
      sessions: [...this.sessions.values()].sort((a, b) => a.startsAt - b.startsAt),
    };
  }

  /**
   * Events strictly after `lastSeq`, or null if the log no longer reaches
   * back that far (caller should fall back to a snapshot).
   */
  eventsSince(lastSeq: number): SequencedEvent[] | null {
    if (lastSeq > this.seq) return null; // client is ahead of us: server restarted
    if (lastSeq === this.seq) return [];
    const oldest = this.log[0]?.seq;
    if (oldest === undefined || lastSeq < oldest - 1) return null;
    return this.log.filter((e) => e.seq > lastSeq);
  }

  addParticipant(id: string, name: string): SequencedEvent {
    const participant: Participant = {
      id,
      name,
      joinedAt: this.now(),
      media: { audio: false, video: false, screen: false },
    };
    return this.apply({ type: "participant_joined", participant });
  }

  removeParticipant(id: string): SequencedEvent | null {
    if (!this.participants.has(id)) return null;
    return this.apply({ type: "participant_left", participantId: id });
  }

  setMedia(id: string, media: MediaState): SequencedEvent | null {
    const p = this.participants.get(id);
    if (!p) return null;
    const same =
      p.media.audio === media.audio &&
      p.media.video === media.video &&
      p.media.screen === media.screen;
    if (same) return null;
    return this.apply({ type: "media_changed", participantId: id, media: { ...media } });
  }

  /**
   * Returns the stored message and whether it was newly created. A retry with
   * the same clientMsgId (e.g. resent after a reconnect) returns the original
   * message instead of producing a duplicate.
   */
  postMessage(
    authorId: string,
    clientMsgId: string,
    text: string,
  ): { message: ChatMessage; event: SequencedEvent | null } {
    const author = this.participants.get(authorId);
    if (!author) throw new Error("author not in room");

    const byClient = this.sentByClient.get(authorId) ?? new Map<string, ChatMessage>();
    this.sentByClient.set(authorId, byClient);
    const existing = byClient.get(clientMsgId);
    if (existing) return { message: existing, event: null };

    const message: ChatMessage = {
      id: randomUUID(),
      clientMsgId,
      authorId,
      authorName: author.name,
      text,
      sentAt: this.now(),
      seq: this.seq + 1, // apply() assigns exactly this seq
    };
    const event = this.apply({ type: "chat_message", message });
    byClient.set(clientMsgId, message);
    if (byClient.size > LIMITS.messageHistory) {
      const oldestKey = byClient.keys().next().value;
      if (oldestKey !== undefined) byClient.delete(oldestKey);
    }
    return { message, event };
  }

  scheduleSession(
    createdBy: string,
    title: string,
    startsAt: number,
    durationMin: number,
  ): SequencedEvent {
    const creator = this.participants.get(createdBy);
    if (!creator) throw new Error("creator not in room");
    const session: StudySession = {
      id: randomUUID(),
      title,
      startsAt,
      durationMin,
      createdBy,
      createdByName: creator.name,
    };
    return this.apply({ type: "session_scheduled", session });
  }

  /** Only the creator may cancel. Returns "not_found" / "forbidden" on failure. */
  cancelSession(by: string, sessionId: string): SequencedEvent | "not_found" | "forbidden" {
    const s = this.sessions.get(sessionId);
    if (!s) return "not_found";
    if (s.createdBy !== by) return "forbidden";
    return this.apply({ type: "session_cancelled", sessionId });
  }

  private apply(event: RoomEvent): SequencedEvent {
    this.seq += 1;
    const sequenced = { ...event, seq: this.seq } as SequencedEvent;

    switch (event.type) {
      case "participant_joined":
        this.participants.set(event.participant.id, event.participant);
        break;
      case "participant_left":
        this.participants.delete(event.participantId);
        this.sentByClient.delete(event.participantId);
        break;
      case "media_changed": {
        const p = this.participants.get(event.participantId);
        if (p) p.media = event.media;
        break;
      }
      case "chat_message":
        this.messages.push(event.message);
        if (this.messages.length > LIMITS.messageHistory) this.messages.shift();
        break;
      case "session_scheduled":
        this.sessions.set(event.session.id, event.session);
        break;
      case "session_cancelled":
        this.sessions.delete(event.sessionId);
        break;
    }

    this.log.push(sequenced);
    if (this.log.length > LIMITS.eventLog) this.log.shift();
    return sequenced;
  }
}
