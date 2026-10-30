/**
 * Wire protocol shared by the client and the server.
 *
 * Design rule: every change to shared room state is a RoomEvent that the
 * server stamps with a monotonically increasing `seq`. Clients never mutate
 * shared state locally; they send intents (ClientMessage) and apply the
 * sequenced events the server broadcasts back. That gives every client the
 * same order of changes, and lets a reconnecting client ask for "everything
 * after seq N" instead of re-downloading the whole room.
 */

export interface MediaState {
  audio: boolean;
  video: boolean;
  screen: boolean;
}

export interface Participant {
  id: string;
  name: string;
  joinedAt: number;
  media: MediaState;
}

export interface ChatMessage {
  id: string;
  /** Client-generated id, used to dedupe retries and match acks. */
  clientMsgId: string;
  authorId: string;
  authorName: string;
  text: string;
  sentAt: number;
  seq: number;
}

export interface StudySession {
  id: string;
  title: string;
  startsAt: number;
  durationMin: number;
  createdBy: string;
  createdByName: string;
}

export interface RoomSnapshot {
  roomId: string;
  seq: number;
  participants: Participant[];
  messages: ChatMessage[];
  sessions: StudySession[];
}

export type RoomEvent =
  | { type: "participant_joined"; participant: Participant }
  | { type: "participant_left"; participantId: string }
  | { type: "media_changed"; participantId: string; media: MediaState }
  | { type: "chat_message"; message: ChatMessage }
  | { type: "session_scheduled"; session: StudySession }
  | { type: "session_cancelled"; sessionId: string };

export type SequencedEvent = RoomEvent & { seq: number };

/** Plain ICE candidate shape (avoids depending on DOM types on the server). */
export interface IceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type SignalData =
  | { kind: "description"; description: { type: "offer" | "answer" | "rollback" | "pranswer"; sdp?: string } }
  | { kind: "ice"; candidate: IceCandidate };

export type ClientMessage =
  | {
      type: "join";
      roomId: string;
      name: string;
      /** Present when resuming: lets the server keep the same identity. */
      participantId?: string;
      /** Last seq this client applied; server replays anything newer. */
      lastSeq?: number;
    }
  | { type: "chat_send"; clientMsgId: string; text: string }
  | { type: "media_update"; media: MediaState }
  | { type: "session_schedule"; title: string; startsAt: number; durationMin: number }
  | { type: "session_cancel"; sessionId: string }
  | { type: "signal"; to: string; data: SignalData }
  | { type: "ping"; t: number };

export type ServerMessage =
  | { type: "welcome"; selfId: string; resume: "snapshot"; snapshot: RoomSnapshot }
  | { type: "welcome"; selfId: string; resume: "replay"; events: SequencedEvent[] }
  | { type: "event"; event: SequencedEvent }
  | { type: "chat_ack"; clientMsgId: string; messageId: string; seq: number }
  | { type: "signal"; from: string; data: SignalData }
  | { type: "error"; code: ErrorCode; message: string }
  | { type: "pong"; t: number };

export type ErrorCode =
  | "bad_request"
  | "not_joined"
  | "rate_limited"
  | "forbidden"
  | "not_found";

export const LIMITS = {
  nameMax: 40,
  chatMax: 2000,
  titleMax: 80,
  roomIdMax: 64,
  maxParticipants: 8,
  messageHistory: 500,
  eventLog: 1000,
} as const;
