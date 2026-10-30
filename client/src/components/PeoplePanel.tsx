import type { RoomState } from "../state/roomState";

export function PeoplePanel({ state }: { state: RoomState }) {
  const people = Object.values(state.participants).sort((a, b) => a.joinedAt - b.joinedAt);
  return (
    <section className="panel people" aria-label="People">
      <ul>
        {people.map((p) => (
          <li key={p.id}>
            <span>{p.id === state.selfId ? `${p.name} (you)` : p.name}</span>
            <span className="muted">
              {[p.media.audio ? "Mic on" : "Muted", p.media.video && "Camera on", p.media.screen && "Sharing"]
                .filter(Boolean)
                .join(", ")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
