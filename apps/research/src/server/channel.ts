/**
 * The application's own channel pair: one in-process connection to its host.
 *
 * The product's research runner lives in this same process as the host it
 * drives, so it needs a `ProtocolChannel` pair rather than a socket. The pair
 * keeps the transport contract the protocol states — ordered delivery per
 * direction, a listener installed before traffic, bounded buffering with a
 * synchronous refusal, and a close that ends both ends exactly once — because
 * the point of using the real client is that the runner goes through the same
 * protocol path a remote client would, not a private shortcut into the host.
 *
 * Its limits are the application's too: a frame the peer has not collected is
 * memory, and an unbounded queue is how a stuck run becomes a stuck process.
 */

import type { ProtocolChannel, ProtocolChannelListener } from "@every-dagent/protocol";

const MAX_PENDING_FRAMES = 4_096;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

interface Side {
  listener: ProtocolChannelListener | undefined;
  closed: boolean;
  readonly pending: string[];
  pendingBytes: number;
  peer: Side | undefined;
}

function makeSide(): Side {
  return { listener: undefined, closed: false, pending: [], pendingBytes: 0, peer: undefined };
}

function deliver(side: Side): void {
  if (side.closed || side.listener === undefined || side.pending.length === 0) return;
  const frames = side.pending.splice(0, side.pending.length);
  side.pendingBytes = 0;
  for (const frame of frames) {
    if (side.closed) return;
    try {
      side.listener.onFrame(frame);
    } catch {
      // A listener that throws is a listener that failed to handle a frame; the
      // connection is ended rather than left in a half-read state.
      closeSide(side);
      return;
    }
  }
}

function closeSide(side: Side): void {
  if (side.closed) return;
  side.closed = true;
  side.pending.length = 0;
  side.pendingBytes = 0;
  const listener = side.listener;
  const peer = side.peer;
  if (peer !== undefined) closeSide(peer);
  listener?.onClose();
}

function makeChannel(self: Side): ProtocolChannel {
  return {
    send(frame: string): void {
      const peer = self.peer;
      if (self.closed || peer === undefined || peer.closed) {
        throw new Error("the channel is closed");
      }
      const bytes = Buffer.byteLength(frame, "utf8");
      if (peer.pending.length + 1 > MAX_PENDING_FRAMES || peer.pendingBytes + bytes > MAX_PENDING_BYTES) {
        throw new Error("the channel's buffer is full");
      }
      peer.pending.push(frame);
      peer.pendingBytes += bytes;
      queueMicrotask(() => {
        deliver(peer);
      });
    },
    listen(listener: ProtocolChannelListener): () => void {
      if (self.listener !== undefined && !self.closed) {
        throw new Error("the channel already has a listener");
      }
      self.listener = listener;
      queueMicrotask(() => {
        deliver(self);
      });
      let disposed = false;
      return (): void => {
        if (disposed) return;
        disposed = true;
        if (self.listener === listener) self.listener = undefined;
      };
    },
    close(): void {
      closeSide(self);
    },
  } as ProtocolChannel;
}

/** A client end and a host end of one logical connection. */
export function createChannelPair(): { readonly clientSide: ProtocolChannel; readonly hostSide: ProtocolChannel } {
  const clientSide = makeSide();
  const hostSide = makeSide();
  clientSide.peer = hostSide;
  hostSide.peer = clientSide;
  return { clientSide: makeChannel(clientSide), hostSide: makeChannel(hostSide) };
}
