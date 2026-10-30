import type {
  ChatMessage,
  Participant,
  RoomSnapshot,
  SequencedEvent,
  StudySession,
} from "../../../shared/protocol";

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface PendingMessage {
  clientMsgId: string;
  text: string;
  createdAt: number;
  status: "sending" | "failed";
}

export interface RoomState {
  status: ConnectionStatus;
  selfId: string | null;
  /** Highest seq applied. Used for gap detection and replay on reconnect. */
  seq: number;
  participants: Record<string, Participant>;
  messages: ChatMessage[];
  /** Messages sent by this client that the server hasn't confirmed yet. */
  pending: PendingMessage[];
  sessions: StudySession[];
  /** Set when an event arrives out of order; client must resync. */
  needsResync: boolean;
  lastError: string | null;
}

export type RoomAction =
  | { type: "status"; status: ConnectionStatus }
  | { type: "snapshot"; selfId: string; snapshot: RoomSnapshot }
  | { type: "replay"; selfId: string; events: SequencedEvent[] }
  | { type: "event"; event: SequencedEvent }
  | { type: "chat_queued"; clientMsgId: string; text: string; at: number }
  | { type: "chat_acked"; clientMsgId: string }
  | { type: "chat_failed"; clientMsgId: string }
  | { type: "chat_retry"; clientMsgId: string }
  | { type: "error"; message: string };

export const initialRoomState: RoomState = {
  status: "idle",
  selfId: null,
  seq: 0,
  participants: {},
  messages: [],
  pending: [],
  sessions: [],
  needsResync: false,
  lastError: null,
};

const bySeq = (a: ChatMessage, b: ChatMessage) => a.seq - b.seq;
const byStart = (a: StudySession, b: StudySession) => a.startsAt - b.startsAt;

/**
 * Applies one server event. Idempotent and order-checked:
 *  - seq <= state.seq  -> already applied (duplicate delivery), ignore
 *  - seq >  state.seq+1 -> we missed something, flag a resync, don't apply
 * This is what keeps every client's view identical to the server's.
 */
function applyEvent(state: RoomState, event: SequencedEvent): RoomState {
  if (event.seq <= state.seq) return state;
  if (event.seq !== state.seq + 1) return { ...state, needsResync: true };

  const next: RoomState = { ...state, seq: event.seq };
  switch (event.type) {
    case "participant_joined":
      next.participants = { ...state.participants, [event.participant.id]: event.participant };
      break;
    case "participant_left": {
      const { [event.participantId]: _gone, ...rest } = state.participants;
      next.participants = rest;
      break;
    }
    case "media_changed": {
      const p = state.participants[event.participantId];
      if (p) {
        next.participants = { ...state.participants, [p.id]: { ...p, media: event.media } };
      }
      break;
    }
    case "chat_message": {
      const m = event.message;
      if (!state.messages.some((x) => x.id === m.id)) {
        next.messages = [...state.messages, m].sort(bySeq);
      }
      // Our own message coming back confirms it even if the ack was lost.
      if (m.authorId === state.selfId) {
        next.pending = state.pending.filter((p) => p.clientMsgId !== m.clientMsgId);
      }
      break;
    }
    case "session_scheduled":
      next.sessions = [...state.sessions.filter((s) => s.id !== event.session.id), event.session].sort(byStart);
      break;
    case "session_cancelled":
      next.sessions = state.sessions.filter((s) => s.id !== event.sessionId);
      break;
  }
  return next;
}

export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case "status":
      return { ...state, status: action.status };

    case "snapshot": {
      const s = action.snapshot;
      const confirmed = new Set(
        s.messages.filter((m) => m.authorId === action.selfId).map((m) => m.clientMsgId),
      );
      return {
        ...state,
        status: "open",
        selfId: action.selfId,
        seq: s.seq,
        participants: Object.fromEntries(s.participants.map((p) => [p.id, p])),
        messages: [...s.messages].sort(bySeq),
        sessions: [...s.sessions].sort(byStart),
        pending: state.pending.filter((p) => !confirmed.has(p.clientMsgId)),
        needsResync: false,
        lastError: null,
      };
    }

    case "replay": {
      let next: RoomState = {
        ...state,
        status: "open",
        selfId: action.selfId,
        needsResync: false,
        lastError: null,
      };
      for (const e of action.events) next = applyEvent(next, e);
      return next;
    }

    case "event":
      return applyEvent(state, action.event);

    case "chat_queued":
      return {
        ...state,
        pending: [
          ...state.pending,
          { clientMsgId: action.clientMsgId, text: action.text, createdAt: action.at, status: "sending" },
        ],
      };

    case "chat_acked":
      return { ...state, pending: state.pending.filter((p) => p.clientMsgId !== action.clientMsgId) };

    case "chat_failed":
    case "chat_retry": {
      const status = action.type === "chat_failed" ? "failed" : "sending";
      return {
        ...state,
        pending: state.pending.map((p) =>
          p.clientMsgId === action.clientMsgId ? { ...p, status } : p,
        ),
      };
    }

    case "error":
      return { ...state, lastError: action.message };
  }
}
