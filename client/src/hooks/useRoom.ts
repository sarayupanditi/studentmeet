import { useEffect, useMemo, useSyncExternalStore } from "react";
import { RoomClient } from "../net/RoomClient";

function defaultWsUrl(): string {
  const fromEnv = import.meta.env.VITE_WS_URL as string | undefined;
  if (fromEnv) return fromEnv;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

/** One RoomClient per (room, name); state read via useSyncExternalStore. */
export function useRoom(roomId: string, name: string) {
  const client = useMemo(
    () => new RoomClient({ url: defaultWsUrl(), roomId, name }),
    [roomId, name],
  );

  useEffect(() => {
    client.connect();
    return () => client.leave();
  }, [client]);

  const state = useSyncExternalStore(client.subscribe, client.getState);
  return { client, state };
}
