/**
 * API client. Every call is same-origin by default; a different server can be
 * configured at runtime (the "API: Configure" control).
 */

const STORAGE_KEY = 'cyberstream.api';

let base = '';

/** Resolves the server base, preferring a user-configured remote endpoint. */
export function configureApi(url) {
  const trimmed = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
  if (trimmed) {
    // eslint-disable-next-line no-new
    new URL(trimmed); // throws on garbage, caught by the caller
  }
  base = trimmed;
  try {
    if (trimmed) localStorage.setItem(STORAGE_KEY, trimmed);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode */
  }
  return base;
}

export function loadApiConfig() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY) ?? '';
    base = stored;
  } catch {
    base = '';
  }
  return base;
}

export function apiOrigin() {
  return base || location.origin;
}

export function isRemote() {
  return Boolean(base) && base !== location.origin;
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'error' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body, signal, timeoutMs = 90_000 } = {}) {
  const url = `${base}${path}`;
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    signal.addEventListener('abort', onAbort, { once: true });
  }
  // Resolution can legitimately take a while on a cold YouTube format.
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
    });

    const text = await res.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!res.ok) {
      throw new ApiError(payload?.message ?? `Request failed (${res.status}).`, {
        status: res.status,
        code: payload?.error ?? 'http_error',
      });
    }
    return payload;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err?.name === 'AbortError') {
      if (signal?.aborted) throw err;
      throw new ApiError('The server took too long to respond.', { code: 'timeout' });
    }
    throw new ApiError('Cannot reach the streaming server.', {
      code: 'network',
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export const api = {
  config: () => request('/api/config', { timeoutMs: 10_000 }),
  health: () => request('/api/health', { timeoutMs: 5000 }),
  catalog: () => request('/api/catalog', { timeoutMs: 10_000 }),

  /** Cheap URL validation used for inline input feedback. */
  validate: (url) => request('/api/resolve/validate', { method: 'POST', body: { url } }),

  createSession: (url, { signal, quality, autoplay } = {}) =>
    request('/api/sessions', {
      method: 'POST',
      // `quality` and `autoplay` are optional: the server clamps quality to its
      // own configured ceiling and ignores an unknown value.
      body: { url, ...(quality ? { quality } : {}), ...(autoplay === undefined ? {} : { autoplay }) },
      signal,
      timeoutMs: 90_000,
    }),

  session: (id, token) => request(`/api/sessions/${id}?token=${encodeURIComponent(token)}`),

  stop: (stopUrl) => request(stopUrl.replace(/^https?:\/\/[^/]+/, base), { method: 'DELETE' }),
};
