import { LIMITS, type ClientMessage, type MediaState, type SignalData } from "../../shared/protocol.js";

/**
 * Hand-rolled validation for incoming frames. Anything that fails returns
 * null and the connection gets a `bad_request` error; we never trust the
 * shape of client JSON.
 */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : null;
};

const ROOM_ID = /^[a-zA-Z0-9_-]+$/;

function media(v: unknown): MediaState | null {
  if (!isObj(v)) return null;
  const { audio, video, screen } = v;
  if (typeof audio !== "boolean" || typeof video !== "boolean" || typeof screen !== "boolean") {
    return null;
  }
  return { audio, video, screen };
}

function signal(v: unknown): SignalData | null {
  if (!isObj(v)) return null;
  if (v.kind === "description" && isObj(v.description)) {
    const d = v.description;
    const types = ["offer", "answer", "rollback", "pranswer"] as const;
    if (!types.includes(d.type as (typeof types)[number])) return null;
    if (d.sdp !== undefined && (typeof d.sdp !== "string" || d.sdp.length > 100_000)) return null;
    return {
      kind: "description",
      description: { type: d.type as (typeof types)[number], sdp: d.sdp as string | undefined },
    };
  }
  if (v.kind === "ice" && isObj(v.candidate)) {
    const c = v.candidate;
    if (typeof c.candidate !== "string" || c.candidate.length > 2000) return null;
    return {
      kind: "ice",
      candidate: {
        candidate: c.candidate,
        sdpMid: typeof c.sdpMid === "string" ? c.sdpMid : null,
        sdpMLineIndex: typeof c.sdpMLineIndex === "number" ? c.sdpMLineIndex : null,
        usernameFragment: typeof c.usernameFragment === "string" ? c.usernameFragment : null,
      },
    };
  }
  return null;
}

export function parseClientMessage(raw: string): ClientMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v) || typeof v.type !== "string") return null;

  switch (v.type) {
    case "join": {
      const roomId = str(v.roomId, LIMITS.roomIdMax);
      const name = str(v.name, LIMITS.nameMax);
      if (!roomId || !ROOM_ID.test(roomId) || !name) return null;
      const participantId =
        typeof v.participantId === "string" && v.participantId.length <= 64
          ? v.participantId
          : undefined;
      const lastSeq =
        typeof v.lastSeq === "number" && Number.isInteger(v.lastSeq) && v.lastSeq >= 0
          ? v.lastSeq
          : undefined;
      return { type: "join", roomId, name, participantId, lastSeq };
    }
    case "chat_send": {
      const clientMsgId = str(v.clientMsgId, 64);
      const text = str(v.text, LIMITS.chatMax);
      return clientMsgId && text ? { type: "chat_send", clientMsgId, text } : null;
    }
    case "media_update": {
      const m = media(v.media);
      return m ? { type: "media_update", media: m } : null;
    }
    case "session_schedule": {
      const title = str(v.title, LIMITS.titleMax);
      const { startsAt, durationMin } = v;
      if (!title) return null;
      if (typeof startsAt !== "number" || !Number.isFinite(startsAt)) return null;
      if (typeof durationMin !== "number" || !Number.isInteger(durationMin)) return null;
      if (durationMin < 5 || durationMin > 480) return null;
      return { type: "session_schedule", title, startsAt, durationMin };
    }
    case "session_cancel": {
      const sessionId = str(v.sessionId, 64);
      return sessionId ? { type: "session_cancel", sessionId } : null;
    }
    case "signal": {
      const to = str(v.to, 64);
      const data = signal(v.data);
      return to && data ? { type: "signal", to, data } : null;
    }
    case "ping":
      return typeof v.t === "number" ? { type: "ping", t: v.t } : null;
    default:
      return null;
  }
}
