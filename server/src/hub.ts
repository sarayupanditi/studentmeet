import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  LIMITS,
  type ClientMessage,
  type ErrorCode,
  type SequencedEvent,
  type ServerMessage,
} from "../../shared/protocol.js";
import { Room } from "./room.js";
import { parseClientMessage } from "./validate.js";

export interface HubOptions {
  /**
   * How long a participant's seat is held after their socket drops. If they
   * reconnect within this window (flaky Wi-Fi, laptop sleep, tab reload) the
   * rest of the room never sees them leave and rejoin.
   */
  reconnectGraceMs?: number;
  /** Max chat messages per participant per 10s window. */
  chatRateLimit?: number;
}

interface Seat {
  participantId: string;
  roomId: string;
  socket: WebSocket | null;
  leaveTimer: NodeJS.Timeout | null;
  chatWindowStart: number;
  chatCount: number;
}

/**
 * Connection layer: maps sockets to seats in rooms, validates frames, and
 * fans sequenced room events out to everyone in the room. Rooms themselves
 * hold no networking code.
 */
export class Hub {
  private rooms = new Map<string, Room>();
  private seats = new Map<string, Seat>(); // participantId -> seat
  private socketSeat = new WeakMap<WebSocket, Seat>();
  private readonly graceMs: number;
  private readonly chatRateLimit: number;

  constructor(opts: HubOptions = {}) {
    this.graceMs = opts.reconnectGraceMs ?? 10_000;
    this.chatRateLimit = opts.chatRateLimit ?? 20;
  }

  /** Exposed for health checks and tests. */
  stats() {
    return {
      rooms: this.rooms.size,
      participants: [...this.rooms.values()].reduce((n, r) => n + r.size, 0),
    };
  }

  getRoom(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  attach(ws: WebSocket): void {
    ws.on("message", (data) => {
      const raw = data.toString();
      if (raw.length > 200_000) return this.sendError(ws, "bad_request", "frame too large");
      const msg = parseClientMessage(raw);
      if (!msg) return this.sendError(ws, "bad_request", "invalid message");
      this.handle(ws, msg);
    });
    ws.on("close", () => this.onSocketClosed(ws));
    ws.on("error", () => ws.terminate());
  }

  private handle(ws: WebSocket, msg: ClientMessage): void {
    if (msg.type === "ping") return this.send(ws, { type: "pong", t: msg.t });
    if (msg.type === "join") return this.join(ws, msg);

    const seat = this.socketSeat.get(ws);
    const room = seat && this.rooms.get(seat.roomId);
    if (!seat || !room) return this.sendError(ws, "not_joined", "join a room first");
    const me = seat.participantId;

    switch (msg.type) {
      case "chat_send": {
        if (!this.allowChat(seat)) {
          return this.sendError(ws, "rate_limited", "slow down");
        }
        const { message, event } = room.postMessage(me, msg.clientMsgId, msg.text);
        // Ack first so the sender can clear its pending entry, then broadcast.
        this.send(ws, {
          type: "chat_ack",
          clientMsgId: msg.clientMsgId,
          messageId: message.id,
          seq: message.seq,
        });
        if (event) this.broadcast(room, event);
        return;
      }
      case "media_update": {
        const event = room.setMedia(me, msg.media);
        if (event) this.broadcast(room, event);
        return;
      }
      case "session_schedule": {
        this.broadcast(room, room.scheduleSession(me, msg.title, msg.startsAt, msg.durationMin));
        return;
      }
      case "session_cancel": {
        const result = room.cancelSession(me, msg.sessionId);
        if (result === "not_found") return this.sendError(ws, "not_found", "no such session");
        if (result === "forbidden") {
          return this.sendError(ws, "forbidden", "only the organizer can cancel");
        }
        this.broadcast(room, result);
        return;
      }
      case "signal": {
        // Relay WebRTC negotiation only between members of the same room.
        const target = this.seats.get(msg.to);
        if (!target || target.roomId !== seat.roomId || !target.socket) return;
        this.send(target.socket, { type: "signal", from: me, data: msg.data });
        return;
      }
    }
  }

  private join(ws: WebSocket, msg: Extract<ClientMessage, { type: "join" }>): void {
    if (this.socketSeat.has(ws)) {
      return this.sendError(ws, "bad_request", "already joined on this connection");
    }

    // Resume path: same participant, same room, seat still held.
    const existing = msg.participantId ? this.seats.get(msg.participantId) : undefined;
    if (existing && existing.roomId === msg.roomId) {
      const room = this.rooms.get(existing.roomId);
      if (room?.hasParticipant(existing.participantId)) {
        this.resume(ws, existing, room, msg.lastSeq);
        return;
      }
    }

    const room = this.rooms.get(msg.roomId) ?? new Room(msg.roomId);
    if (room.size >= LIMITS.maxParticipants) {
      return this.sendError(ws, "forbidden", "room is full");
    }
    this.rooms.set(room.id, room);

    const participantId = randomUUID();
    const seat: Seat = {
      participantId,
      roomId: room.id,
      socket: ws,
      leaveTimer: null,
      chatWindowStart: 0,
      chatCount: 0,
    };
    this.seats.set(participantId, seat);
    this.socketSeat.set(ws, seat);

    const joined = room.addParticipant(participantId, msg.name);
    // New joiner gets a full snapshot (which already includes their join)...
    this.send(ws, { type: "welcome", selfId: participantId, resume: "snapshot", snapshot: room.snapshot() });
    // ...everyone else gets the incremental event.
    this.broadcast(room, joined, participantId);
  }

  private resume(ws: WebSocket, seat: Seat, room: Room, lastSeq: number | undefined): void {
    if (seat.leaveTimer) {
      clearTimeout(seat.leaveTimer);
      seat.leaveTimer = null;
    }
    // A second tab or a stale socket for the same identity: newest wins.
    if (seat.socket && seat.socket !== ws) {
      this.socketSeat.delete(seat.socket);
      seat.socket.close(4000, "replaced by a newer connection");
    }
    seat.socket = ws;
    this.socketSeat.set(ws, seat);

    const events = lastSeq === undefined ? null : room.eventsSince(lastSeq);
    if (events) {
      this.send(ws, { type: "welcome", selfId: seat.participantId, resume: "replay", events });
    } else {
      this.send(ws, {
        type: "welcome",
        selfId: seat.participantId,
        resume: "snapshot",
        snapshot: room.snapshot(),
      });
    }
  }

  private onSocketClosed(ws: WebSocket): void {
    const seat = this.socketSeat.get(ws);
    if (!seat || seat.socket !== ws) return; // already replaced
    this.socketSeat.delete(ws);
    seat.socket = null;
    seat.leaveTimer = setTimeout(() => this.evict(seat), this.graceMs);
  }

  private evict(seat: Seat): void {
    this.seats.delete(seat.participantId);
    const room = this.rooms.get(seat.roomId);
    if (!room) return;
    const event = room.removeParticipant(seat.participantId);
    if (event) this.broadcast(room, event);
    if (room.size === 0) this.rooms.delete(room.id);
  }

  private allowChat(seat: Seat): boolean {
    const now = Date.now();
    if (now - seat.chatWindowStart > 10_000) {
      seat.chatWindowStart = now;
      seat.chatCount = 0;
    }
    seat.chatCount += 1;
    return seat.chatCount <= this.chatRateLimit;
  }

  private broadcast(room: Room, event: SequencedEvent, exceptId?: string): void {
    const frame = JSON.stringify({ type: "event", event } satisfies ServerMessage);
    for (const seat of this.seats.values()) {
      if (seat.roomId !== room.id || seat.participantId === exceptId) continue;
      // Disconnected seats miss the frame on purpose; they replay on resume.
      if (seat.socket?.readyState === WebSocket.OPEN) seat.socket.send(frame);
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private sendError(ws: WebSocket, code: ErrorCode, message: string): void {
    this.send(ws, { type: "error", code, message });
  }

  /** Clears timers so tests and graceful shutdown don't hang. */
  dispose(): void {
    for (const seat of this.seats.values()) {
      if (seat.leaveTimer) clearTimeout(seat.leaveTimer);
    }
  }
}
