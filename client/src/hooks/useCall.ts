import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MediaState } from "../../../shared/protocol";
import type { RoomClient } from "../net/RoomClient";
import { PeerMesh, type RemoteStreams } from "../rtc/PeerMesh";
import type { RoomState } from "../state/roomState";

/**
 * Local media (mic, camera, screen) plus the peer mesh for the room.
 *
 * - Mic mute flips `track.enabled` (instant, no renegotiation).
 * - Camera off stops the track so the camera light goes off; turning it back
 *   on swaps a fresh track into the existing sender.
 * - Screen share swaps the outgoing video track; ending it from the browser's
 *   own "Stop sharing" button falls back to the camera.
 */
export function useCall(client: RoomClient, state: RoomState) {
  const [audioTrack, setAudioTrack] = useState<MediaStreamTrack | null>(null);
  const [cameraTrack, setCameraTrack] = useState<MediaStreamTrack | null>(null);
  const [screenTrack, setScreenTrack] = useState<MediaStreamTrack | null>(null);
  const [audioOn, setAudioOn] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState<RemoteStreams>({});
  const [mediaError, setMediaError] = useState<string | null>(null);
  const meshRef = useRef<PeerMesh | null>(null);

  // (Re)create the mesh when our identity changes, e.g. after a server restart.
  useEffect(() => {
    if (!state.selfId) return;
    const mesh = new PeerMesh(state.selfId, (to, data) => client.sendSignal(to, data));
    meshRef.current = mesh;
    const offStreams = mesh.onStreams(setRemoteStreams);
    const offSignal = client.onSignal((from, data) => void mesh.handleSignal(from, data));
    return () => {
      offSignal();
      offStreams();
      mesh.close();
      meshRef.current = null;
      setRemoteStreams({});
    };
  }, [client, state.selfId]);

  const participantKey = Object.keys(state.participants).sort().join(",");
  useEffect(() => {
    meshRef.current?.sync(participantKey ? participantKey.split(",") : []);
  }, [participantKey, state.selfId]);

  const outgoingVideo = screenTrack ?? cameraTrack;
  useEffect(() => {
    void meshRef.current?.setTracks(audioTrack, outgoingVideo);
  }, [audioTrack, outgoingVideo, state.selfId]);

  const media: MediaState = useMemo(
    () => ({ audio: audioOn, video: cameraTrack !== null, screen: screenTrack !== null }),
    [audioOn, cameraTrack, screenTrack],
  );
  useEffect(() => {
    if (state.status === "open") client.updateMedia(media);
  }, [client, media, state.status]);

  const toggleAudio = useCallback(async () => {
    setMediaError(null);
    if (audioTrack) {
      audioTrack.enabled = !audioOn;
      setAudioOn(!audioOn);
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      setAudioTrack(s.getAudioTracks()[0]);
      setAudioOn(true);
    } catch {
      setMediaError("Microphone permission was denied.");
    }
  }, [audioTrack, audioOn]);

  const toggleVideo = useCallback(async () => {
    setMediaError(null);
    if (cameraTrack) {
      cameraTrack.stop();
      setCameraTrack(null);
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      setCameraTrack(s.getVideoTracks()[0]);
    } catch {
      setMediaError("Camera permission was denied.");
    }
  }, [cameraTrack]);

  const toggleScreen = useCallback(async () => {
    setMediaError(null);
    if (screenTrack) {
      screenTrack.stop();
      setScreenTrack(null);
      return;
    }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = s.getVideoTracks()[0];
      track.contentHint = "detail"; // favour sharp text over smooth motion
      track.onended = () => setScreenTrack(null);
      setScreenTrack(track);
    } catch {
      // User closed the picker: not an error worth showing.
    }
  }, [screenTrack]);

  // Stop every device when leaving the room.
  const tracksRef = useRef<Array<MediaStreamTrack | null>>([]);
  tracksRef.current = [audioTrack, cameraTrack, screenTrack];
  useEffect(() => () => tracksRef.current.forEach((t) => t?.stop()), []);

  const localStream = useMemo(
    () => (outgoingVideo ? new MediaStream([outgoingVideo]) : null),
    [outgoingVideo],
  );

  return {
    media,
    localStream,
    remoteStreams,
    mediaError,
    toggleAudio,
    toggleVideo,
    toggleScreen,
  };
}
