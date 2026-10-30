import type {
  ClientMessage,
  MediaState,
  ServerMessage,
  SignalData,
} from "../../../shared/protocol";
import {
  initialRoomState,
  roomReducer,
  type RoomAction,
  type RoomState,
} from "../state/roomState";

export interface RoomClientOptions {
  url: string;
  roomId: string;
  name: string;
  /** Injected for tests. */
  WebSocketImpl?: typeof WebSocket;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

type SignalHandler = (from: string, data: SignalData) => void;

const PING_EVERY_MS = 15_000;
const PONG_TIMEOUT_MS = 10_000;
const PENDING_FAIL_MS = 15_000;
const MAX_BACKOFF_MS = 10_000;

/**
 * Owns the WebSocket and the room state.
 *
 * - Holds state as an external store (subscribe/getState) for React's
 *   useSyncExternalStore, so components re-render from one source of truth.
 * - Reconnects with exponential backoff + jitter, resuming with the same
 *   participant id and the last applied seq so the server can replay only
 *   what was missed.
 * - Keeps unacknowledged chat messages in an outbox and resends them after
 *   reconnecting; the server dedupes by clientMsgId, so nothing doubles up.
 */
export class RoomClient {
  private state: RoomState = initialRoomState;
  private listeners = new Set<() => void>();
  private signalHandlers = new Set<SignalHandler>();
  private ws: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongDeadline: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastMedia: MediaState | null = null;
  private readonly WS: typeof WebSocket;
  private readonly storage: RoomClientOptions["storage"];
  private readonly storageKey: string;

  constructor(private opts: RoomClientOptions) {
    this.WS = opts.WebSocketImpl ?? WebSocket;
    this.storage = opts.storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : undefined);
    this.storageKey = `studentmeet:participant:${opts.roomId}`;
  }

  // ---- external store ------------------------------------------------------

  getState = (): RoomState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  onSignal(fn: SignalHandler): () => void {
    this.signalHandlers.add(fn);
    return () => this.signalHandlers.delete(fn);
  }

  private dispatch(action: RoomAction) {
    const next = roomReducer(this.state, action);
    if (next === this.state) return;
    this.state = next;
    this.listeners.forEach((l) => l());
  }

  // ---- lifecycle -----------------------------------------------------------

  connect(): void {
    this.stopped = false;
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.reconnectNow);
    }
    this.open();
  }

  /** Leave on purpose: no reconnect, seat released by server after grace. */
  leave(): void {
    this.stopped = true;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.reconnectNow);
    }
    this.clearTimers();
    this.storage?.removeItem(this.storageKey);
    this.ws?.close(1000, "left");
    this.ws = null;
    this.dispatch({ type: "status", status: "closed" });
  }

  private open() {
    this.dispatch({ type: "status", status: this.attempt === 0 ? "connecting" : "reconnecting" });
    const ws = new this.WS(this.opts.url);
    this.ws = ws;

    ws.onopen = () => {
      const participantId = this.state.selfId ?? this.storage?.getItem(this.storageKey) ?? undefined;
      this.rawSend({
        type: "join",
        roomId: this.opts.roomId,
        name: this.opts.name,
        participantId,
        // Only ask for a replay if our local state belongs to that identity.
        lastSeq: this.state.selfId ? this.state.seq : undefined,
      });
      this.startHeartbeat();
    };

    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.handle(msg);
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      // 4000 = server replaced us with a newer tab; don't fight it.
      if (this.stopped || ev.code === 4000) {
        this.dispatch({ type: "status", status: "closed" });
        if (ev.code === 4000) this.dispatch({ type: "error", message: "Opened in another tab." });
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => ws.close();
  }

  private handle(msg: ServerMessage) {
    switch (msg.type) {
      case "welcome": {
        this.attempt = 0;
        this.storage?.setItem(this.storageKey, msg.selfId);
        if (msg.resume === "snapshot") {
          this.dispatch({ type: "snapshot", selfId: msg.selfId, snapshot: msg.snapshot });
        } else {
          this.dispatch({ type: "replay", selfId: msg.selfId, events: msg.events });
        }
        this.flushOutbox();
        if (this.lastMedia) this.rawSend({ type: "media_update", media: this.lastMedia });
        return;
      }
      case "event":
        this.dispatch({ type: "event", event: msg.event });
        if (this.state.needsResync) this.forceResync();
        return;
      case "chat_ack":
        this.dispatch({ type: "chat_acked", clientMsgId: msg.clientMsgId });
        return;
      case "signal":
        this.signalHandlers.forEach((h) => h(msg.from, msg.data));
        return;
      case "pong":
        if (this.pongDeadline) clearTimeout(this.pongDeadline);
        this.pongDeadline = null;
        return;
      case "error":
        this.dispatch({ type: "error", message: msg.message });
        return;
    }
  }

  /** A gap in seq means our view may be wrong: reconnect and replay. */
  private forceResync() {
    this.ws?.close(4001, "resync");
  }

  private scheduleReconnect() {
    this.dispatch({ type: "status", status: "reconnecting" });
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt);
    const delay = base / 2 + Math.random() * (base / 2); // jitter avoids thundering herd
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private reconnectNow = () => {
    if (this.stopped || this.ws) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.open();
  };

  private startHeartbeat() {
    this.pingTimer = setInterval(() => {
      this.rawSend({ type: "ping", t: Date.now() });
      if (!this.pongDeadline) {
        this.pongDeadline = setTimeout(() => this.ws?.close(4002, "heartbeat timeout"), PONG_TIMEOUT_MS);
      }
      this.markStalePending();
    }, PING_EVERY_MS);
  }

  private clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongDeadline) clearTimeout(this.pongDeadline);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = this.pongDeadline = this.reconnectTimer = null;
  }

  // ---- outgoing ------------------------------------------------------------

  private get isOpen() {
    return this.ws?.readyState === this.WS.OPEN && this.state.status === "open";
  }

  private rawSend(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== this.WS.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  sendChat(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const clientMsgId = crypto.randomUUID();
    this.dispatch({ type: "chat_queued", clientMsgId, text: trimmed, at: Date.now() });
    if (this.isOpen) this.rawSend({ type: "chat_send", clientMsgId, text: trimmed });
  }

  retryChat(clientMsgId: string): void {
    const p = this.state.pending.find((x) => x.clientMsgId === clientMsgId);
    if (!p) return;
    this.dispatch({ type: "chat_retry", clientMsgId });
    if (this.isOpen) this.rawSend({ type: "chat_send", clientMsgId, text: p.text });
  }

  private flushOutbox() {
    for (const p of this.state.pending) {
      this.rawSend({ type: "chat_send", clientMsgId: p.clientMsgId, text: p.text });
    }
  }

  private markStalePending() {
    const now = Date.now();
    for (const p of this.state.pending) {
      if (p.status === "sending" && now - p.createdAt > PENDING_FAIL_MS) {
        this.dispatch({ type: "chat_failed", clientMsgId: p.clientMsgId });
      }
    }
  }

  updateMedia(media: MediaState): void {
    this.lastMedia = media;
    this.rawSend({ type: "media_update", media });
  }

  scheduleSession(title: string, startsAt: number, durationMin: number): void {
    this.rawSend({ type: "session_schedule", title, startsAt, durationMin });
  }

  cancelSession(sessionId: string): void {
    this.rawSend({ type: "session_cancel", sessionId });
  }

  sendSignal(to: string, data: SignalData): void {
    this.rawSend({ type: "signal", to, data });
  }
}
