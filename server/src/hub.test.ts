import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";
import { Hub } from "./hub.js";

/**
 * Integration tests over real sockets: these exercise the reconnect and
 * ordering behaviour end to end, which is where real-time bugs actually live.
 */

let http: Server;
let wss: WebSocketServer;
let hub: Hub;
let url: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  hub = new Hub({ reconnectGraceMs: 150, chatRateLimit: 5 });
  http = createServer();
  wss = new WebSocketServer({ server: http, path: "/ws" });
  wss.on("connection", (ws) => hub.attach(ws));
  await new Promise<void>((r) => http.listen(0, r));
  url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws`;
});

afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets.length = 0;
  hub.dispose();
  await new Promise<void>((r) => wss.close(() => http.close(() => r())));
});

class TestClient {
  inbox: ServerMessage[] = [];
  private waiters: Array<() => void> = [];
  constructor(public ws: WebSocket) {
    ws.on("message", (d) => {
      this.inbox.push(JSON.parse(d.toString()));
      this.waiters.splice(0).forEach((w) => w());
    });
  }
  static async connect(): Promise<TestClient> {
    const ws = new WebSocket(url);
    sockets.push(ws);
    await new Promise((r, j) => {
      ws.once("open", r);
      ws.once("error", j);
    });
    return new TestClient(ws);
  }
  send(msg: ClientMessage) {
    this.ws.send(JSON.stringify(msg));
  }
  async next<T extends ServerMessage["type"]>(
    type: T,
    pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + 2000;
    for (;;) {
      const i = this.inbox.findIndex(
        (m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>),
      );
      if (i >= 0) return this.inbox.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
  close() {
    return new Promise<void>((r) => {
      this.ws.once("close", () => r());
      this.ws.close();
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function joined(name: string, roomId = "algo-study") {
  const c = await TestClient.connect();
  c.send({ type: "join", roomId, name });
  const welcome = await c.next("welcome");
  if (welcome.resume !== "snapshot") throw new Error("expected snapshot");
  return { client: c, id: welcome.selfId, snapshot: welcome.snapshot };
}

describe("Hub", () => {
  it("gives a joiner a snapshot and tells others with a sequenced event", async () => {
    const ana = await joined("Ana");
    const ben = await joined("Ben");
    expect(ben.snapshot.participants.map((p) => p.name).sort()).toEqual(["Ana", "Ben"]);
    const ev = await ana.client.next("event");
    expect(ev.event).toMatchObject({ type: "participant_joined", seq: 2 });
  });

  it("acks the sender and broadcasts chat to everyone in the same order", async () => {
    const ana = await joined("Ana");
    const ben = await joined("Ben");
    await ana.client.next("event"); // Ben joined

    ana.client.send({ type: "chat_send", clientMsgId: "m1", text: "first" });
    ben.client.send({ type: "chat_send", clientMsgId: "m2", text: "second" });

    const ack = await ana.client.next("chat_ack");
    expect(ack.clientMsgId).toBe("m1");

    const seenByAna = [
      await ana.client.next("event"),
      await ana.client.next("event"),
    ].map((e) => e.event.seq);
    const seenByBen = [
      await ben.client.next("event"),
      await ben.client.next("event"),
    ].map((e) => e.event.seq);
    expect(seenByAna).toEqual(seenByBen);
  });

  it("does not create a duplicate when a chat send is retried", async () => {
    const ana = await joined("Ana");
    ana.client.send({ type: "chat_send", clientMsgId: "m1", text: "hi" });
    ana.client.send({ type: "chat_send", clientMsgId: "m1", text: "hi" });
    const a1 = await ana.client.next("chat_ack");
    const a2 = await ana.client.next("chat_ack");
    expect(a1.messageId).toBe(a2.messageId);
    expect(hub.getRoom("algo-study")!.snapshot().messages).toHaveLength(1);
  });

  it("resumes within the grace window with a replay and no leave/join churn", async () => {
    const ana = await joined("Ana");
    const ben = await joined("Ben");
    await ana.client.next("event"); // Ben joined (seq 2)

    await ben.client.close();
    ana.client.send({ type: "chat_send", clientMsgId: "m1", text: "you there?" });
    await ana.client.next("event"); // chat (seq 3)

    const ben2 = await TestClient.connect();
    ben2.send({ type: "join", roomId: "algo-study", name: "Ben", participantId: ben.id, lastSeq: 2 });
    const welcome = await ben2.next("welcome");
    expect(welcome.selfId).toBe(ben.id);
    expect(welcome.resume).toBe("replay");
    if (welcome.resume === "replay") {
      expect(welcome.events.map((e) => e.type)).toEqual(["chat_message"]);
    }

    await sleep(250); // past the grace window
    expect(ana.client.inbox.some((m) => m.type === "event" && m.event.type === "participant_left")).toBe(false);
    expect(hub.getRoom("algo-study")!.size).toBe(2);
  });

  it("evicts a participant who does not come back within the grace window", async () => {
    const ana = await joined("Ana");
    const ben = await joined("Ben");
    await ana.client.next("event");
    await ben.client.close();
    const left = await ana.client.next("event", (m) => m.event.type === "participant_left");
    expect(left.event).toMatchObject({ type: "participant_left", participantId: ben.id });
  });

  it("replaces an older socket when the same participant connects again", async () => {
    const ana = await joined("Ana");
    const second = await TestClient.connect();
    const closed = new Promise<number>((r) => ana.client.ws.once("close", (code) => r(code)));
    second.send({ type: "join", roomId: "algo-study", name: "Ana", participantId: ana.id, lastSeq: 1 });
    await second.next("welcome");
    expect(await closed).toBe(4000);
    expect(hub.getRoom("algo-study")!.size).toBe(1);
  });

  it("relays signaling only within the same room", async () => {
    const ana = await joined("Ana", "room-a");
    const ben = await joined("Ben", "room-a");
    const eve = await joined("Eve", "room-b");
    const data = { kind: "description", description: { type: "offer", sdp: "v=0" } } as const;

    eve.client.send({ type: "signal", to: ana.id, data });
    ben.client.send({ type: "signal", to: ana.id, data });

    const sig = await ana.client.next("signal");
    expect(sig.from).toBe(ben.id);
    await sleep(100);
    expect(ana.client.inbox.some((m) => m.type === "signal")).toBe(false);
  });

  it("rejects malformed frames and actions before joining", async () => {
    const c = await TestClient.connect();
    c.ws.send("not json");
    expect((await c.next("error")).code).toBe("bad_request");
    c.send({ type: "chat_send", clientMsgId: "x", text: "hi" });
    expect((await c.next("error")).code).toBe("not_joined");
  });

  it("rate limits chat floods", async () => {
    const ana = await joined("Ana");
    for (let i = 0; i < 7; i++) ana.client.send({ type: "chat_send", clientMsgId: `m${i}`, text: "spam" });
    const err = await ana.client.next("error");
    expect(err.code).toBe("rate_limited");
  });

  it("only lets the organizer cancel a session", async () => {
    const ana = await joined("Ana");
    const ben = await joined("Ben");
    await ana.client.next("event");
    ana.client.send({ type: "session_schedule", title: "DP practice", startsAt: Date.now() + 60_000, durationMin: 45 });
    const scheduled = await ben.client.next("event", (m) => m.event.type === "session_scheduled");
    if (scheduled.event.type !== "session_scheduled") throw new Error();
    ben.client.send({ type: "session_cancel", sessionId: scheduled.event.session.id });
    expect((await ben.client.next("error")).code).toBe("forbidden");
  });
});
