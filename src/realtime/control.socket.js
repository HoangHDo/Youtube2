/**
 * Socket.IO control plane.
 *
 * The media itself does not travel here: MPEG-TS goes over a raw WebSocket and
 * MP3 over HTTP. What travels here is everything else the UI needs to stay
 * honest about what it is showing:
 *
 *   session:state   - live / ended / failed / stopping
 *   session:meta    - title, duration, tracks, encoder strategy
 *   session:clock   - 2 Hz video timestamp, used for A/V drift correction
 *   session:overflow- a viewer fell behind and had chunks dropped
 *
 * Subscribing requires the same viewer token as the media endpoints, so the
 * control channel leaks no more than the stream does.
 */
import { Server } from 'socket.io';
import { config } from '../config/index.js';
import { verifyUpgradeRequest } from '../middleware/auth.js';
import { sessionStore, SESSION_STATE } from '../lib/session-store.js';
import { childLogger } from '../lib/logger.js';

const room = (sessionId) => `session:${sessionId}`;
const MAX_SUBSCRIPTIONS_PER_SOCKET = 8;

export function attachControlSocket(httpServer) {
  const log = childLogger({ mod: 'control' });

  const io = new Server(httpServer, {
    path: '/control',
    serveClient: true,
    cors: config.allowedOrigins.length
      ? { origin: config.allowedOrigins, credentials: false }
      : undefined,
    // Media does not flow here, so defaults are fine and keep memory low.
    maxHttpBufferSize: 8 * 1024,
    pingInterval: 20_000,
    pingTimeout: 20_000,
  });

  io.on('connection', (socket) => {
    socket.data.subscriptions = new Set();

    socket.on('subscribe', (payload, ack) => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : null;
      const token = typeof payload?.token === 'string' ? payload.token : null;
      const serverToken = typeof payload?.st === 'string' ? payload.st : null;

      if (
        socket.data.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_SOCKET ||
        !sessionId ||
        socket.data.subscriptions.has(sessionId)
      ) {
        return respond(ack, { ok: false, error: 'subscribe_failed' });
      }

      const result = verifyUpgradeRequest({
        sessionId,
        token,
        serverToken,
        origin: socket.handshake.headers.origin,
      });

      if (!result.ok) {
        log.warn({ reason: result.reason, sid: socket.id }, 'control subscribe refused');
        return respond(ack, { ok: false, error: result.reason });
      }

      const session = result.session;
      socket.data.subscriptions.add(sessionId);
      void socket.join(room(sessionId));
      session.touch();

      respond(ack, { ok: true, state: session.state, meta: session.metaPayload() });

      // Push anything that happened between the HTTP response and this subscribe.
      socket.emit('session:state', session.statePayload());
      socket.emit('session:meta', session.metaPayload());

      log.debug({ session: session.id, sid: socket.id }, 'control subscriber attached');
    });

    socket.on('unsubscribe', (payload) => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : null;
      if (!sessionId) return;
      socket.data.subscriptions.delete(sessionId);
      void socket.leave(room(sessionId));
    });

    socket.on('disconnect', () => {
      for (const sessionId of socket.data.subscriptions) {
        void socket.leave(room(sessionId));
      }
    });
  });

  // --- session -> control subscribers ---------------------------------------
  const bindings = new Map(); // sessionId -> unsubscribe fn

  const bind = (session) => {
    if (bindings.has(session.id)) return;
    const relay = {
      state: (payload) => io.to(room(session.id)).emit('session:state', payload),
      meta: (payload) => io.to(room(session.id)).emit('session:meta', payload),
      clock: (payload) => io.to(room(session.id)).emit('session:clock', payload),
      overflow: (payload) => io.to(room(session.id)).emit('session:overflow', payload),
    };
    for (const [event, fn] of Object.entries(relay)) session.on(event, fn);
    bindings.set(session.id, () => {
      for (const [event, fn] of Object.entries(relay)) session.off(event, fn);
      bindings.delete(session.id);
    });
  };

  // The store creates sessions dynamically, so hook the registry once.
  const originalCreate = sessionStore.create.bind(sessionStore);
  sessionStore.create = (opts) => {
    const session = originalCreate(opts);
    bind(session);
    return session;
  };

  for (const session of sessionStore.all()) bind(session);

  return {
    io,
    close() {
      for (const unbind of bindings.values()) unbind();
      io.close();
    },
  };
}

function respond(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

export { SESSION_STATE };
