/** Small DOM + formatting helpers. */

/** @param {string} selector @param {ParentNode} [root] */
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * @param {string} html
 * @param {ParentNode} root
 * @returns {Element|null}
 */
export function fromHtml(html, root = document.createElement('template')) {
  root.innerHTML = html.trim();
  return root.content.firstElementChild;
}

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Normalises whatever the user pasted into a canonical YouTube watch URL. */
export function normaliseInput(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return `https://www.youtube.com/watch?v=${value}`;
  return value;
}

/**
 * Tidies clipboard text into something `normaliseInput` will accept.
 *
 * Copying a link rarely yields the bare URL. Depending on where it came from
 * the clipboard also holds a trailing newline (a terminal, `curl`), a leading
 * and trailing pair of angle brackets (an email client quoting it), the
 * `watch?` query split with a `&amp;` (HTML), zero-width joiners left behind by
 * some chat apps, or a title on the same line as the URL.
 *
 * The leading junk is stripped, then the first thing that actually looks like a
 * URL is taken, and finally the common YouTube URL shapes are rewritten so a
 * bare `youtu.be/…` or `?v=` link works without the user editing it first.
 * Returns an empty string when there is nothing URL-shaped to be had, so the
 * caller can say "nothing on the clipboard" instead of filling the field with
 * noise.
 */
export function cleanPasted(raw) {
  const text = String(raw ?? '');
  if (!text.trim()) return '';

  // Strip invisible characters (zero-width joiner/non-joiner, BOM) that ride
  // along from chat clients and rich-text editors, drop the straight and curly
  // quotes a mail client wraps a link in, then collapse whitespace.
  const stripped = text
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/['\u2018\u2019\u201C\u201D"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Prefer the first http(s) URL anywhere in the text, so a line of prose with
  // a link in it still yields the link. Quotes are already gone by this point.
  const match = stripped.match(/https?:\/\/[^\s<>]+/i);
  let url = match ? match[0] : stripped;

  // Strip trailing punctuation that is sentence punctuation, not part of the URL.
  url = url.replace(/[),.;:!?]+$/, '');
  // Undo HTML-escaped query separators.
  url = url.replace(/&amp;/gi, '&');

  // Accept the shapes people actually copy, not just youtube.com/watch?v=
  const short = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/i);
  if (short) return `https://www.youtube.com/watch?v=${short[1]}`;

  const embed = url.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{11})/i);
  if (embed) return `https://www.youtube.com/watch?v=${embed[1]}`;

  const shorts = url.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/i);
  if (shorts) return `https://www.youtube.com/watch?v=${shorts[1]}`;

  // A bare video id, with or without surrounding decoration.
  const id = url.match(/(?:^|[?&=/\s])([A-Za-z0-9_-]{11})(?:$|[?&#\s])/);
  if (id && !/^https?:/i.test(url)) return `https://www.youtube.com/watch?v=${id[1]}`;

  return url;
}

export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...args);
      }, wait);
    }
  };
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** localStorage that never throws (private mode, disabled storage, ...). */
export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
