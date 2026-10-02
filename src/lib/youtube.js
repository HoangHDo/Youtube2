/**
 * Parsing + validation for user supplied media references.
 *
 * Two shapes are accepted:
 *   1. A YouTube video id or any youtube.com / youtu.be URL form.
 *   2. A direct http(s) media URL (disabled unless ALLOW_DIRECT_MEDIA_URLS).
 *
 * Everything that reaches FFmpeg goes through here first. The important
 * property is that we never hand a raw user string to FFmpeg: we rebuild the
 * input URL from validated parts, so `;`, `|`, newlines, `file://`, quote
 * tricks and option-injection (`-i evil`) cannot survive.
 */

const YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'gaming.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
  'www.youtu.be',
]);

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const SHORT_ID = /^[A-Za-z0-9_-]{6,20}$/; // legacy / partial ids
const MEDIA_EXT =
  /\.(m3u8|mpd|mp4|m4v|mkv|webm|mov|flv|mp3|m4a|aac|ogg|opus|wav|ts|avi)(?:$|[?#])/i;

export const SOURCE_KIND = Object.freeze({
  YOUTUBE: 'youtube',
  DIRECT: 'direct',
});

/** @typedef {{kind:string, videoId:string|null, url:string, label:string}} ParsedSource */

/** Strips the many YouTube query params we do not care about. */
function canonicalYouTubeUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * @param {unknown} input raw user input
 * @param {object} [opts]
 * @param {boolean} [opts.allowDirectPorts]    enable non-YouTube media URLs
 * @param {string[]} [opts.allowedPorts]       permitted ports ("any" = all)
 * @param {boolean} [opts.allowPrivateHosts]   allow loopback/LAN hosts
 * @returns {ParsedSource}
 * @throws {Error} with a `.code` suitable for showing to the user
 */
export function parseSource(input, opts = {}) {
  const allowDirectPorts = opts.allowDirectPorts ?? false;
  const allowPrivateHosts = opts.allowPrivateHosts ?? false;
  const allowedPortList = (opts.allowedPorts ?? ['80', '443']).map(String);
  const allowAnyPort = allowedPortList.includes('any');

  if (typeof input !== 'string') {
    throw badRequest('Enter a YouTube URL or video ID.');
  }

  let value = input.trim();
  if (!value) throw badRequest('Enter a YouTube URL or video ID.');
  if (value.length > 2048) throw badRequest('That URL is too long.');

  // Tolerate "youtube.com/watch?v=..." pasted without a scheme.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value) && /^(www\.)?(youtube|youtu\.be)\./i.test(value)) {
    value = `https://${value}`;
  }

  // A bare video id.
  if (YT_ID.test(value)) {
    return {
      kind: SOURCE_KIND.YOUTUBE,
      videoId: value,
      url: canonicalYouTubeUrl(value),
      label: `YouTube ${value}`,
    };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw badRequest('That does not look like a URL or a YouTube video ID.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badRequest('Only http and https URLs are supported.');
  }

  const host = url.hostname.toLowerCase();

  if (YT_HOSTS.has(host)) {
    const videoId = extractYouTubeId(url);
    if (!videoId) {
      throw badRequest(
        'That YouTube link has no video - channel, playlist and search links are not supported.',
      );
    }
    return {
      kind: SOURCE_KIND.YOUTUBE,
      videoId,
      url: canonicalYouTubeUrl(videoId),
      label: `YouTube ${videoId}`,
    };
  }

  if (allowDirectPorts) {
    // Reject credentials in the URL and ports that are not explicitly allowed.
    if (url.username || url.password) {
      throw badRequest('URLs with embedded credentials are not allowed.');
    }
    if (!isAllowedPort(url.port, allowedPortList)) {
      throw badRequest(
        `Only port(s) ${allowedPortList.join(', ')} are allowed for direct media URLs.`,
      );
    }
    // SSRF guard: a "media URL" pointing at 169.254.169.254 or a LAN admin
    // port is how a streaming server gets turned into a request proxy.
    if (!allowPrivateHosts && isPrivateHost(url.hostname)) {
      throw badRequest('That host is not reachable from a public stream server.');
    }
    if (!MEDIA_EXT.test(url.pathname) && !url.searchParams.has('manifest')) {
      throw badRequest('That URL does not look like a media file.');
    }
    return {
      kind: SOURCE_KIND.DIRECT,
      videoId: null,
      url: `${url.origin}${url.pathname}${url.search}`,
      label: url.hostname,
    };
  }

  throw badRequest(
    'Only YouTube links are enabled on this server. Ask the operator to allow direct media URLs.',
  );
}

/** Pulls the 11 character id out of every YouTube URL flavour. */
export function extractYouTubeId(url) {
  if (url instanceof URL) {
    const host = url.hostname.toLowerCase();
    const seg = url.pathname.split('/').filter(Boolean);

    if (host.endsWith('youtu.be')) {
      const id = seg[0];
      return YT_ID.test(id ?? '') ? id : null;
    }
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const v = url.searchParams.get('v');
      if (YT_ID.test(v ?? '')) return v;
      if (seg[0] === 'shorts' || seg[0] === 'live' || seg[0] === 'embed' || seg[0] === 'v') {
        const id = seg[1];
        if (YT_ID.test(id ?? '')) return id;
      }
    }
    return null;
  }

  const value = String(url);
  if (YT_ID.test(value)) return value;
  return null;
}

/** Best-effort thumbnail for the UI; may 404, the client has a fallback. */
export function thumbnailFor(source) {
  if (source.kind === SOURCE_KIND.YOUTUBE && source.videoId) {
    return `https://i.ytimg.com/vi/${source.videoId}/mqdefault.jpg`;
  }
  return null;
}

export function isProbablyShortId(value) {
  return SHORT_ID.test(value);
}

function isAllowedPort(port, allowedPortList) {
  if (!port) return true; // implicit 80/443
  return allowedPortList.includes('any') || allowedPortList.includes(port);
}

/** True for loopback, link-local (cloud metadata), private and reserved ranges. */
export function isPrivateHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0.0.0.0' || host === '::') return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 0) return true;
    return false;
  }
  // Anything that looks like an IPv6 literal is treated as internal: resolving
  // it safely is not worth the complexity for this feature.
  return host.includes(':');
}

function badRequest(message) {
  const err = new Error(message);
  err.code = 'INVALID_SOURCE';
  err.statusCode = 400;
  return err;
}
