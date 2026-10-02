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
 * CORS / CSRF: the API is meant to be called from our own page, so the default
 * is an origin allow-list. Requests with *no* Origin (curl, native clients) are
 * still allowed - they cannot be forged by a browser.
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
    if (origin && !allowed.has(origin)) {
      log.warn({ origin, path: req.path }, 'blocked cross-origin request');
      return res.status(403).json({
        error: 'origin_not_allowed',
        message: 'This origin is not allowed to use the API.',
      });
    }
    return corsMiddleware(req, res, next);
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
