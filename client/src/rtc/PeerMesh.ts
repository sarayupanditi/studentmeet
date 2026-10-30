import type { SignalData } from "../../../shared/protocol";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

interface Peer {
  pc: RTCPeerConnection;
  /** Perfect-negotiation flags (see MDN "Perfect negotiation"). */
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** ICE candidates that arrived before the remote description. */
  pendingIce: RTCIceCandidateInit[];
  stream: MediaStream;
  senders: { audio?: RTCRtpSender; video?: RTCRtpSender };
}

export type RemoteStreams = Record<string, MediaStream>;

/**
 * Full-mesh WebRTC between room members, signaled over the room WebSocket.
 *
 * Uses the "perfect negotiation" pattern so both sides can add or swap tracks
 * at any time (camera on, screen share) without coordinating who offers:
 * when offers collide, the polite peer rolls back and the impolite peer wins.
 * Politeness is derived from comparing participant ids, so both sides agree.
 *
 * A mesh is fine for small study groups (the server caps rooms at 8); larger
 * rooms would need an SFU.
 */
export class PeerMesh {
  private peers = new Map<string, Peer>();
  private tracks: { audio: MediaStreamTrack | null; video: MediaStreamTrack | null } = {
    audio: null,
    video: null,
  };
  private listeners = new Set<(streams: RemoteStreams) => void>();

  constructor(
    private selfId: string,
    private sendSignal: (to: string, data: SignalData) => void,
  ) {}

  onStreams(fn: (streams: RemoteStreams) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    const streams: RemoteStreams = {};
    for (const [id, p] of this.peers) streams[id] = p.stream;
    this.listeners.forEach((l) => l(streams));
  }

  /** Reconcile peer connections with the current participant list. */
  sync(participantIds: string[]): void {
    const wanted = new Set(participantIds.filter((id) => id !== this.selfId));
    for (const id of wanted) if (!this.peers.has(id)) this.createPeer(id);
    for (const id of [...this.peers.keys()]) if (!wanted.has(id)) this.closePeer(id);
  }

  /** Set the outgoing tracks; swaps in place where possible (no renegotiation). */
  async setTracks(audio: MediaStreamTrack | null, video: MediaStreamTrack | null): Promise<void> {
    this.tracks = { audio, video };
    await Promise.all([...this.peers.values()].map((p) => this.applyTracks(p)));
  }

  private async applyTracks(peer: Peer) {
    for (const kind of ["audio", "video"] as const) {
      const track = this.tracks[kind];
      const sender = peer.senders[kind];
      if (sender) {
        // replaceTrack swaps camera <-> screen without an SDP round trip.
        if (sender.track !== track) await sender.replaceTrack(track);
      } else if (track) {
        // First track of this kind: addTrack triggers negotiationneeded.
        peer.senders[kind] = peer.pc.addTrack(track);
      }
    }
  }

  private createPeer(id: string) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer: Peer = {
      pc,
      polite: this.selfId > id,
      makingOffer: false,
      ignoreOffer: false,
      pendingIce: [],
      stream: new MediaStream(),
      senders: {},
    };
    this.peers.set(id, peer);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.sendDescription(id, pc.localDescription);
      } catch (err) {
        console.warn("[rtc] negotiation failed", err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.sendSignal(id, { kind: "ice", candidate: candidate.toJSON() as never });
    };

    pc.ontrack = ({ track }) => {
      // Keep one stream per peer and swap tracks of the same kind into it.
      for (const old of peer.stream.getTracks()) {
        if (old.kind === track.kind && old !== track) peer.stream.removeTrack(old);
      }
      peer.stream.addTrack(track);
      track.onunmute = () => this.emit();
      this.emit();
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") pc.restartIce();
    };

    void this.applyTracks(peer);
    this.emit();
  }

  private sendDescription(to: string, desc: RTCSessionDescription | null) {
    if (!desc) return;
    this.sendSignal(to, { kind: "description", description: { type: desc.type, sdp: desc.sdp } });
  }

  private closePeer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.close();
    this.peers.delete(id);
    this.emit();
  }

  async handleSignal(from: string, data: SignalData): Promise<void> {
    let peer = this.peers.get(from);
    if (!peer) {
      // Offer from someone our participant list hasn't caught up with yet.
      this.createPeer(from);
      peer = this.peers.get(from)!;
    }
    const { pc } = peer;

    try {
      if (data.kind === "description") {
        const desc = data.description;
        const collision =
          desc.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;

        await pc.setRemoteDescription(desc);
        for (const c of peer.pendingIce.splice(0)) await pc.addIceCandidate(c);
        if (desc.type === "offer") {
          await pc.setLocalDescription();
          this.sendDescription(from, pc.localDescription);
        }
      } else {
        const candidate = data.candidate as RTCIceCandidateInit;
        if (!pc.remoteDescription) {
          peer.pendingIce.push(candidate);
          return;
        }
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          if (!peer.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.warn("[rtc] signal handling failed", err);
    }
  }

  close(): void {
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.listeners.clear();
  }
}
