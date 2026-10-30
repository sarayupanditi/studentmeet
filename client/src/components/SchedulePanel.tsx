import { useState, type FormEvent } from "react";
import { LIMITS } from "../../../shared/protocol";
import type { RoomClient } from "../net/RoomClient";
import type { RoomState } from "../state/roomState";

function defaultStart(): string {
  // Next full hour, formatted for <input type="datetime-local">.
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const when = (t: number) =>
  new Date(t).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function SchedulePanel({ client, state }: { client: RoomClient; state: RoomState }) {
  const [title, setTitle] = useState("");
  const [start, setStart] = useState(defaultStart);
  const [duration, setDuration] = useState(60);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const startsAt = new Date(start).getTime();
    if (!title.trim()) return setError("Give the session a title.");
    if (Number.isNaN(startsAt) || startsAt < Date.now()) return setError("Pick a time in the future.");
    setError(null);
    client.scheduleSession(title.trim(), startsAt, duration);
    setTitle("");
  };

  const upcoming = state.sessions.filter((s) => s.startsAt + s.durationMin * 60_000 > Date.now());

  return (
    <section className="panel schedule" aria-label="Schedule">
      <form className="schedule__form" onSubmit={submit}>
        <label>
          Title
          <input
            value={title}
            maxLength={LIMITS.titleMax}
            placeholder="Graph algorithms review"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="row">
          <label>
            Starts
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            Length
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {[30, 45, 60, 90, 120].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn btn--primary" type="submit">
          Schedule session
        </button>
      </form>

      <ul className="sessions">
        {upcoming.length === 0 && <li className="empty">Nothing scheduled. Plan the next session above.</li>}
        {upcoming.map((s) => (
          <li key={s.id} className="session">
            <div>
              <strong>{s.title}</strong>
              <span>
                {when(s.startsAt)}, {s.durationMin} min
              </span>
              <span className="muted">Organized by {s.createdBy === state.selfId ? "you" : s.createdByName}</span>
            </div>
            {s.createdBy === state.selfId && (
              <button className="btn btn--quiet" onClick={() => client.cancelSession(s.id)}>
                Cancel
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
