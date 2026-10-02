import { randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_ID = /^[A-Za-z0-9_-]{16,64}$/;
const VIEWER_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * 192 bits of entropy, URL-safe. Session ids are *capabilities*: anyone
 * holding one (plus the viewer token) can read the stream, so they must not be
 * guessable or enumerable.
 */
export function newSessionId() {
  return randomBytes(24).toString('base64url');
}

/** 256 bits, used to gate the WebSocket + MP3 endpoints of one session. */
export function newViewerToken() {
  return randomBytes(32).toString('base64url');
}

export function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

export function isValidViewerToken(value) {
  return typeof value === 'string' && VIEWER_TOKEN.test(value);
}

/** Constant-time compare that never throws on length mismatch. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the timing profile stays flat-ish.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

const b64u = (buf) => buf.toString('base64url');

/** Short, human-quotable id used for log correlation. */
export function shortId(sessionId) {
  return b64u(Buffer.from(sessionId).subarray(0, 4));
}
