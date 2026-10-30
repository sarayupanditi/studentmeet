import { useEffect, useRef } from "react";
import type { Participant } from "../../../shared/protocol";

interface Props {
  participant: Participant | undefined;
  stream: MediaStream | null;
  isSelf?: boolean;
  label: string;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function VideoTile({ participant, stream, isSelf, label }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const media = participant?.media;
  const showVideo = Boolean(stream && media && (media.video || media.screen));

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
    // Remote audio plays through a separate element so it keeps playing
    // while the video element is hidden (camera off).
    if (audioRef.current && !isSelf) audioRef.current.srcObject = stream;
  }, [stream, isSelf]);

  return (
    <figure className={`tile${media?.screen ? " tile--screen" : ""}`}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        hidden={!showVideo}
        className={isSelf && !media?.screen ? "mirrored" : undefined}
      />
      {!isSelf && <audio ref={audioRef} autoPlay />}
      {!showVideo && (
        <div className="tile__avatar" aria-hidden="true">
          {initials(participant?.name ?? "?")}
        </div>
      )}
      <figcaption className="tile__caption">
        <span>{label}</span>
        {media && !media.audio && <span className="tile__muted">Muted</span>}
        {media?.screen && <span className="tile__sharing">Sharing screen</span>}
      </figcaption>
    </figure>
  );
}
