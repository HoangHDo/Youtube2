/**
 * Capability checks for the stream endpoints.
 *
 * Two independent secrets protect a stream:
 *
 *   viewerToken  per-session, 256 bit, handed to whoever created the session.
 *                Sent as `?token=` (or the x-cyberstream-token header).
 *   STREAM_TOKEN an optional operator-wide shared secret (env). When set it
 *                must be presented *in addition*, as `?st=`.
 *
 * There is no user account system here by design. If you need real
 * authentication, put it in front of the app (see the Caddyfile in the repo).
 */
import { isValidSessionId, isValidViewerToken, safeEqual } from '../lib/ids.js';
import { sessionStore } from '../lib/session-store.js';
import { config } from '../config/index.js';

const NO_STORE = 'no-store, no-cache, must-revalidate, private';

function header(req, name) {
  const v = req.headers?.[name];
  return typeof v === 'string' && v ? v : null;
}

export function readViewerToken(req) {
  const q = req.query ?? {};
  return (
    header(req, 'x-cyberstream-token') ??
    (typeof q.token === 'string' ? q.token : null) ??
    (typeof q.t === 'string' ? q.t : null) ??
    bearer(req)
  );
}

function readServerToken(req) {
  const q = req.query ?? {};
  return (
    header(req, 'x-cyberstream-key') ??
    (typeof q.st === 'string' ? q.st : null) ??
    bearer(req)
  );
}

function bearer(req) {
  const auth = req.headers?.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function fail(res, status, code, message) {
  res.setHeader('Cache-Control', NO_STORE);
  res.status(status).json({ error: code, message });
}

function checkServerToken(req) {
  if (!config.security.streamToken) return true;
  return safeEqual(readServerToken(req) ?? '', config.security.streamToken);
}

/** Attaches `req.streamSession` when the caller holds the viewer token. */
export function requireViewer(req, res, next) {
  const id = req.params.sessionId ?? req.query?.sessionId;
  if (!isValidSessionId(id)) return fail(res, 400, 'bad_session', 'Invalid session id.');

  const token = readViewerToken(req);
  if (!isValidViewerToken(token) || !checkServerToken(req)) {
    return fail(res, 401, 'bad_token', 'Invalid or missing stream token.');
  }

  const session = sessionStore.get(id);
  if (!session) {
    // Do not confirm whether an id ever existed.
    return fail(res, 404, 'no_session', 'That stream is no longer available.');
  }
  if (!safeEqual(token, session.viewerToken)) {
    return fail(res, 401, 'bad_token', 'Invalid or missing stream token.');
  }
  req.streamSession = session;
  res.setHeader('Cache-Control', NO_STORE);
  return next();
}

/** Control-plane guard: only the creator's owner token passes. */
export function requireOwner(req, res, next) {
  const id = req.params.sessionId;
  if (!isValidSessionId(id)) return fail(res, 400, 'bad_session', 'Invalid session id.');

  const token = readViewerToken(req);
  const session = sessionStore.get(id);
  if (!session) return fail(res, 404, 'no_session', 'That stream is no longer available.');

  if (!isValidViewerToken(token) || !safeEqual(token, session.ownerToken) || !checkServerToken(req)) {
    return fail(res, 403, 'forbidden', 'Only the stream owner can do that.');
  }
  req.streamSession = session;
  return next();
}

/**
 * WebSocket upgrade variant.
 * @returns {{ok:true, session:import('../lib/session-store.js').Session} | {ok:false, status:number, reason:string}}
 */
export function verifyUpgradeRequest({ sessionId, token, serverToken, origin }) {
  if (!isValidSessionId(sessionId)) {
    return { ok: false, status: 400, reason: 'Invalid session id.' };
  }
  if (!isValidViewerToken(token)) {
    return { ok: false, status: 401, reason: 'Invalid stream token.' };
  }
  if (config.security.streamToken && !safeEqual(serverToken ?? '', config.security.streamToken)) {
    return { ok: false, status: 401, reason: 'Invalid stream token.' };
  }
  if (origin && config.allowedOrigins.length) {
    const allowed =
      config.allowedOrigins.includes(origin) ||
      (config.publicOrigin !== '' && origin === config.publicOrigin);
    if (!allowed) return { ok: false, status: 403, reason: 'Origin not allowed.' };
  }
  const session = sessionStore.get(sessionId);
  if (!session) return { ok: false, status: 404, reason: 'Stream is gone.' };
  if (!safeEqual(token, session.viewerToken)) {
    return { ok: false, status: 401, reason: 'Invalid stream token.' };
  }
  return { ok: true, session };
}

export { NO_STORE };
