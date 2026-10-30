import { useState } from "react";
import { useCall } from "../hooks/useCall";
import { useRoom } from "../hooks/useRoom";
import type { ConnectionStatus } from "../state/roomState";
import { ChatPanel } from "./ChatPanel";
import { PeoplePanel } from "./PeoplePanel";
import { SchedulePanel } from "./SchedulePanel";
import { VideoTile } from "./VideoTile";

type Tab = "chat" | "people" | "schedule";

const statusText: Record<ConnectionStatus, string> = {
  idle: "Starting",
  connecting: "Connecting",
  open: "Connected",
  reconnecting: "Reconnecting. Messages you send will go out when you're back.",
  closed: "Disconnected",
};

export function RoomView({ roomId, name, onLeave }: { roomId: string; name: string; onLeave: () => void }) {
  const { client, state } = useRoom(roomId, name);
  const call = useCall(client, state);
  const [tab, setTab] = useState<Tab>("chat");
  const [copied, setCopied] = useState(false);

  const self = state.selfId ? state.participants[state.selfId] : undefined;
  const others = Object.values(state.participants)
    .filter((p) => p.id !== state.selfId)
    .sort((a, b) => a.joinedAt - b.joinedAt);
  const total = others.length + 1;

  const copyLink = async () => {
    await navigator.clipboard.writeText(location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="room">
      <header className="room__bar">
        <div className="room__title">
          <h1>{roomId}</h1>
          <span className={`status status--${state.status}`} role="status">
            {statusText[state.status]}
          </span>
        </div>
        <button className="btn btn--quiet" onClick={copyLink}>
          {copied ? "Link copied" : "Copy invite link"}
        </button>
      </header>

      {state.lastError && <p className="banner" role="alert">{state.lastError}</p>}
      {call.mediaError && <p className="banner" role="alert">{call.mediaError}</p>}

      <main className="stage" data-count={Math.min(total, 6)}>
        <VideoTile participant={self} stream={call.localStream} isSelf label={`${name} (you)`} />
        {others.map((p) => (
          <VideoTile key={p.id} participant={p} stream={call.remoteStreams[p.id] ?? null} label={p.name} />
        ))}
      </main>

      <aside className="side">
        <div className="tabs" role="tablist" aria-label="Room panels">
          {(["chat", "people", "schedule"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className="tab"
              onClick={() => setTab(t)}
            >
              {t === "chat" && "Chat"}
              {t === "people" && `People (${total})`}
              {t === "schedule" && `Schedule${state.sessions.length ? ` (${state.sessions.length})` : ""}`}
            </button>
          ))}
        </div>
        {tab === "chat" && <ChatPanel client={client} state={state} />}
        {tab === "people" && <PeoplePanel state={state} />}
        {tab === "schedule" && <SchedulePanel client={client} state={state} />}
      </aside>

      <nav className="controls" aria-label="Call controls">
        <button className="ctl" aria-pressed={call.media.audio} onClick={call.toggleAudio}>
          {call.media.audio ? "Mute" : "Unmute"}
        </button>
        <button className="ctl" aria-pressed={call.media.video} onClick={call.toggleVideo}>
          {call.media.video ? "Stop camera" : "Start camera"}
        </button>
        {"getDisplayMedia" in (navigator.mediaDevices ?? {}) && (
          <button className="ctl" aria-pressed={call.media.screen} onClick={call.toggleScreen}>
            {call.media.screen ? "Stop sharing" : "Share screen"}
          </button>
        )}
        <button className="ctl ctl--leave" onClick={onLeave}>
          Leave
        </button>
      </nav>
    </div>
  );
}
