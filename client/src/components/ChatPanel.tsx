import { useEffect, useRef, useState, type FormEvent } from "react";
import { LIMITS } from "../../../shared/protocol";
import type { RoomClient } from "../net/RoomClient";
import type { RoomState } from "../state/roomState";

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function ChatPanel({ client, state }: { client: RoomClient; state: RoomState }) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLOListElement>(null);
  const count = state.messages.length + state.pending.length;

  // Stick to the bottom unless the user has scrolled up to read history.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [count]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    client.sendChat(draft);
    setDraft("");
  };

  return (
    <section className="panel chat" aria-label="Chat">
      <ol className="chat__list" ref={listRef} aria-live="polite">
        {count === 0 && (
          <li className="empty">No messages yet. Drop a question or a link for the group.</li>
        )}
        {state.messages.map((m) => (
          <li key={m.id} className={`msg${m.authorId === state.selfId ? " msg--self" : ""}`}>
            <div className="msg__meta">
              <strong>{m.authorId === state.selfId ? "You" : m.authorName}</strong>
              <time dateTime={new Date(m.sentAt).toISOString()}>{time(m.sentAt)}</time>
            </div>
            <p>{m.text}</p>
          </li>
        ))}
        {state.pending.map((p) => (
          <li key={p.clientMsgId} className={`msg msg--self msg--${p.status}`}>
            <div className="msg__meta">
              <strong>You</strong>
              {p.status === "sending" ? (
                <span>Sending…</span>
              ) : (
                <button type="button" className="link" onClick={() => client.retryChat(p.clientMsgId)}>
                  Not sent. Retry
                </button>
              )}
            </div>
            <p>{p.text}</p>
          </li>
        ))}
      </ol>
      <form className="chat__form" onSubmit={submit}>
        <label htmlFor="chat-input" className="sr-only">
          Message
        </label>
        <textarea
          id="chat-input"
          rows={2}
          value={draft}
          maxLength={LIMITS.chatMax}
          placeholder="Message the group"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) submit(e);
          }}
        />
        <button type="submit" className="btn btn--primary" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
