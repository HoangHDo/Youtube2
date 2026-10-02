/**
 * WebSocket relay for the MPEG-TS video track.
 *
 * Raw `ws` sockets (not Socket.IO) because the payload is a binary stream and
 * JSMpeg speaks raw WebSocket. The URL is always wss:// in production - the
 * browser refuses ws:// on a secure page, and the same origin check applies.
 *
 * Backpressure: if a client stops reading (background tab, slow phone) we drop
 * video chunks and tell it, instead of letting Node buffer unbounded. A dropped
 * chunk costs at most one GOP (0.48s at the defaults) because MPEG-1 keyframes
 * are frequent; the client resyncs from the next keyframe. Audio is unaffected.
 */
import { WebSocketServer } from 'ws';
import { URL } from 'node:url';
import { config } from '../config/index.js';
import { verifyUpgradeRequest } from '../middleware/auth.js';
import { VIDEO_HIGH_WATER, SESSION_STATE } from '../lib/session-store.js';
import { childLogger } from '../lib/logger.js';

const HEARTBEAT_MS = 20_000;
const WS_PATH = '/ws/video';

const PACKET_SIZE = 188;
const EMPTY = Buffer.alloc(0);

/**
 * Keeps one subscriber's byte stream on the 188-byte MPEG-TS packet grid.
 *
 * This matters because we *do* drop data: if a slow client falls behind we shed
 * chunks rather than buffering without bound. Emitting (or shedding) an
 * arbitrary byte count would shift every following packet out of alignment and
 * break the decoder for the rest of the session, so partial packets are always
 * withheld in a carry buffer and both the emitted bytes and the shed bytes are
 * whole numbers of packets.
 *
 * @param {{carry: Buffer}} state per-subscriber, `carry` starts empty
 * @param {Buffer} chunk
 * @param {boolean} shed true when this subscriber is over its high-water mark
 * @returns {Buffer|null} the bytes to send, or null to send nothing
 */
export function alignChunk(state, chunk, shed) {
  let data = chunk.length ? chunk : EMPTY;

  // 1. Complete a packet left partial by a previous chunk.
  if (state.carry.length > 0) {
    const need = PACKET_SIZE - state.carry.length;
    if (data.length < need) {
      state.carry = Buffer.concat([state.carry, data]);
      return null;
    }
    const completed = Buffer.concat([state.carry, data.subarray(0, need)]);
    state.carry = EMPTY;
    data = data.subarray(need);
    if (shed) return null; // shed: the completed packet is dropped whole
    return emit(state, completed, data);
  }

  // 2. With nothing carried, the chunk starts on a packet boundary.
  if (shed) {
    const drop = data.length - (data.length % PACKET_SIZE);
    if (drop === 0) {
      state.carry = Buffer.from(data);
      return null;
    }
    data = data.subarray(drop);
  }
  return emit(state, EMPTY, data);
}

/** Sends `head` (already packet-sized) plus every whole packet in `data`. */
function emit(state, head, data) {
  const usable = data.length - (data.length % PACKET_SIZE);
  if (usable === 0) {
    if (head.length) return head;
    state.carry = Buffer.from(data);
    return null;
  }
  state.carry = Buffer.from(data.subarray(usable));
  return head.length ? Buffer.concat([head, data.subarray(0, usable)]) : data.subarray(0, usable);
}

const CLOSE_REASON = {
  [SESSION_STATE.STOPPING]: 'server-stopping',
  [SESSION_STATE.ENDED]: 'source-ended',
  [SESSION_STATE.FAILED]: 'session-failed',
};

export function attachVideoWebSocket(server) {
  const log = childLogger({ mod: 'ws' });

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false, // binary media must not be compressed
    // clientTracking stays on: the heartbeat sweep and the shutdown path both
    // iterate wss.clients.
    maxPayload: 256 * 1024,
  });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return abortUpgrade(socket, 400, 'Bad request');
    }
    if (url.pathname !== WS_PATH) return; // not ours (Socket.IO, etc.)

    const result = verifyUpgradeRequest({
      sessionId: url.searchParams.get('sessionId') ?? url.searchParams.get('id'),
      token: url.searchParams.get('token') ?? url.searchParams.get('t'),
      serverToken: url.searchParams.get('st'),
      origin: req.headers.origin,
    });

    if (!result.ok) {
      log.warn({ reason: result.reason, ip: req.socket.remoteAddress }, 'ws upgrade refused');
      return abortUpgrade(socket, result.status, result.reason);
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection(ws, req, result.session, log);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* socket already gone */
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    wss,
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) {
        try {
          ws.close(1001, 'server-shutdown');
        } catch {
          /* noop */
        }
      }
      wss.close();
    },
  };
}

function onConnection(ws, req, session, log) {
  ws.isAlive = true;
  ws.binaryType = 'nodebuffer';
  ws.sessionId = session.id;

  const startedAt = Date.now();
  let sent = 0;
  let dropped = 0;
  const stream = { carry: EMPTY };

  const subscriber = {
    write(chunk) {
      if (ws.readyState !== ws.OPEN) return;
      const shed = ws.bufferedAmount > VIDEO_HIGH_WATER;
      // Keep the client's byte stream packet-aligned even when we shed data.
      const payload = alignChunk(stream, chunk, shed);
      if (payload === null) {
        if (shed) {
          dropped += chunk.length;
          session.stats.videoDropped += chunk.length;
          session.maybeNotifyOverflow('video');
        }
        return;
      }
      if (shed) {
        session.maybeNotifyOverflow('video');
      }
      ws.send(payload, { binary: true }, (err) => {
        if (err) ws.terminate();
      });
      sent += payload.length;
    },
    close(reason) {
      try {
        ws.close(normalCloseCode(reason), String(reason).slice(0, 100));
      } catch {
        try {
          ws.terminate();
        } catch {
          /* noop */
        }
      }
    },
  };

  session.addVideoSubscriber(subscriber);

  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('message', (data, isBinary) => {
    // The protocol is one-way; anything inbound is either a ping of our own or
    // junk. Ignore it, but never buffer it.
    if (!isBinary) ws.pong(data);
  });
  ws.on('close', (code) => {
    session.removeSubscriber(subscriber);
    log.debug(
      { session: session.id, code, sent, dropped, secs: Math.round((Date.now() - startedAt) / 1000) },
      'ws viewer disconnected',
    );
  });
  ws.on('error', (err) => {
    log.debug({ err: err.message, session: session.id }, 'ws error');
    session.removeSubscriber(subscriber);
  });

  // Tell the session a viewer is present so an orphaned session un-orphans.
  session.touch();

  if (session._isTerminal()) {
    subscriber.close(session.reason ?? 'ended');
  }

  log.info(
    { session: session.id, ip: req.socket.remoteAddress, viewers: session.videoSubscribers.size },
    'ws viewer attached',
  );
}

function normalCloseCode(reason) {
  switch (reason) {
    case 'source-ended':
    case 'stopped':
    case 'session-failed':
      return 1000;
    case 'write-failed':
      return 1011;
    default:
      return 1000;
  }
}

/** Rejects an upgrade with a minimal HTTP response before the WS handshake. */
function abortUpgrade(socket, status, message) {
  const body = JSON.stringify({ error: 'upgrade_refused', message });
  const statusText = httpStatusText(status);
  socket.write(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n' +
      'Cache-Control: no-store\r\n' +
      '\r\n' +
      body,
  );
  socket.destroy();
}

function httpStatusText(status) {
  return (
    {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      429: 'Too Many Requests',
      503: 'Service Unavailable',
    }[status] ?? 'Error'
  );
}

export { WS_PATH, config };
