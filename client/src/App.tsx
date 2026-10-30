import { useEffect, useState, type FormEvent } from "react";
import { LIMITS } from "../../shared/protocol";
import { RoomView } from "./components/RoomView";

const NAME_KEY = "studentmeet:name";

function roomFromUrl(): string {
  return new URLSearchParams(location.search).get("room") ?? "";
}

function randomRoom(): string {
  const words = ["graphs", "heaps", "tries", "proofs", "kernels", "queues", "lemmas", "vectors"];
  const w = words[Math.floor(Math.random() * words.length)];
  return `${w}-${Math.random().toString(36).slice(2, 6)}`;
}

export function App() {
  const [joined, setJoined] = useState<{ roomId: string; name: string } | null>(null);
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [roomId, setRoomId] = useState(() => roomFromUrl() || randomRoom());

  useEffect(() => {
    const onPop = () => {
      if (!roomFromUrl()) setJoined(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const join = (e: FormEvent) => {
    e.preventDefault();
    const cleanRoom = roomId.trim().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, LIMITS.roomIdMax);
    const cleanName = name.trim().slice(0, LIMITS.nameMax);
    if (!cleanRoom || !cleanName) return;
    localStorage.setItem(NAME_KEY, cleanName);
    history.pushState(null, "", `?room=${encodeURIComponent(cleanRoom)}`);
    setJoined({ roomId: cleanRoom, name: cleanName });
  };

  const leave = () => {
    history.pushState(null, "", location.pathname);
    setJoined(null);
  };

  if (joined) return <RoomView key={joined.roomId} {...joined} onLeave={leave} />;

  const invited = Boolean(roomFromUrl());

  return (
    <main className="lobby">
      <div className="lobby__card">
        <h1 className="wordmark">StudentMeet</h1>
        <p className="lobby__lede">
          {invited
            ? "You've been invited to a study room. Add your name to join."
            : "Video, chat, screen sharing and a shared schedule for your study group. Start a room and send the link."}
        </p>
        <form onSubmit={join} className="lobby__form">
          <label>
            Your name
            <input
              autoFocus
              required
              value={name}
              maxLength={LIMITS.nameMax}
              placeholder="Sarayu"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Room
            <input
              required
              value={roomId}
              maxLength={LIMITS.roomIdMax}
              pattern="[a-zA-Z0-9_\-]+"
              title="Letters, numbers, dashes and underscores"
              onChange={(e) => setRoomId(e.target.value)}
            />
          </label>
          <button className="btn btn--primary btn--lg" type="submit">
            {invited ? "Join room" : "Start room"}
          </button>
        </form>
        <p className="muted small">Camera and mic stay off until you turn them on.</p>
      </div>
    </main>
  );
}
