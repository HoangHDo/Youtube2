import helmet from 'helmet';
import cors from 'cors';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { config } from '../config/index.js';
import { childLogger } from '../lib/logger.js';

const log = childLogger({ mod: 'http' });

/**
 * Content-Security-Policy.
 *
 * The frontend is entirely same-origin: no CDN, no inline script, no eval. The
 * only cross-origin images are YouTube thumbnails, and YouTube is contacted for
 * them directly by the browser (never proxied).
 */
function contentSecurityPolicy() {
  return {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'script-src': ["'self'"],
      'script-src-attr': ["'none'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:', 'https://i.ytimg.com', 'https://img.youtube.com'],
      'media-src': ["'self'", 'blob:'],
      'connect-src': ["'self'", 'ws:', 'wss:'],
      'font-src': ["'self'"],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'worker-src': ["'self'", 'blob:'],
      'upgrade-insecure-requests': config.isProduction ? [] : null,
    },
  };
}

export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: contentSecurityPolicy(),
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    // Streaming endpoints must never be cached by the browser or a proxy.
    hsts: config.isProduction
      ? { maxAge: 15_552_000, includeSubDomains: true, preload: false }
      : false,
  });
}

/**
 * True when `origin` is the very origin the request was addressed to.
 *
 * CSRF works by making a *foreign* page issue a request to this server, which
 * necessarily carries a foreign Origin. A request whose Origin matches the host
 * it was sent to cannot be forged that way - it is same-origin - so allowing it
 * unconditionally costs nothing in CSRF protection.
 *
 * That matters because hard-coding the allow-list to `localhost:8080` breaks the
 * app the moment it is served from anywhere else: Render, Fly, a custom domain,
 * even a LAN IP. The symptom is subtle and total - the page loads and then every
 * asset is answered with 403, so the dashboard is blank and the console says
 * "blocked cross-origin request" for the app's own URL.
 *
 * The scheme is checked as well as the host. Matching the host alone would let
 * `http://my-host` be accepted on an HTTPS deployment, which is a downgrade path
 * an attacker on the network path could use; behind a proxy the real scheme
 * arrives in X-Forwarded-Proto, so honour that first.
 */
export function isSameOrigin(req, origin) {
  const host = req.headers.host;
  if (!host) return false; // no Host: nothing to compare against
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.host !== host) return false;

  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim();
  const scheme = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');
  return parsed.protocol === `${scheme}:`;
}

/**
 * CORS / CSRF: the API is meant to be called from our own page, so the default
 * is an origin allow-list. Same-origin requests always pass (see isSameOrigin).
 * Requests with *no* Origin (curl, native clients) are still allowed - they
 * cannot be forged by a browser.
 */
export function originGuard() {
  const allowed = new Set(config.allowedOrigins);
  if (config.publicOrigin) allowed.add(config.publicOrigin);

  const corsMiddleware = cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowed.has(origin)) return callback(null, true);
      return callback(null, false); // refuse, do not throw
    },
    credentials: false,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-cyberstream-token'],
    maxAge: 600,
  });

  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin) && !isSameOrigin(req, origin)) {
      log.warn(
        { origin, host: req.headers.host, path: req.path },
        'blocked cross-origin request',
      );
      return res.status(403).json({
        error: 'origin_not_allowed',
        message: 'This origin is not allowed to use the API.',
      });
    }

    // Same-origin and origin-less requests need no CORS headers at all: the
    // browser does not apply a CORS check to them. Emitting headers here would
    // mean duplicating the same-origin rule inside `cors`, whose `origin`
    // callback never sees the request and so cannot know the Host. Instead the
    // header-emitting path is used only for the explicit allow-list, which is
    // the one case where a separately hosted frontend genuinely needs it.
    if (!origin || allowed.has(origin)) return corsMiddleware(req, res, next);
    return next();
  };
}

const limiterOptions = (max, message) => ({
  windowMs: 60_000,
  limit: max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Rate limits are keyed on the real client IP when a proxy sets it.
  // `ipKeyGenerator` normalises IPv6 to a /64 subnet key, otherwise a single
  // client could rotate addresses within its prefix and dodge the limit.
  keyGenerator: (req, res) => ipKeyGenerator(req.ip ?? '', 56),
  message: { error: 'rate_limited', message },
});

export function globalLimiter() {
  return rateLimit(limiterOptions(config.rateLimit.globalPerMin, 'Too many requests.'));
}

export function createLimiter() {
  return rateLimit(
    limiterOptions(
      config.rateLimit.createPerMin,
      'You are starting streams too quickly. Wait a moment and try again.',
    ),
  );
}
