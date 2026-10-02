/**
 * Turns a user supplied YouTube reference into a direct media URL that FFmpeg
 * can read.
 *
 * yt-dlp does the work (it is the only thing that reliably understands
 * YouTube's current formats). It is executed with spawn() and an argument
 * array - never a shell string - so nothing from the user can be interpreted
 * as a flag or a command.
 */
import { spawn } from 'node:child_process';
import { rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { config } from '../config/index.js';
import { childLogger } from './logger.js';
import { SOURCE_KIND, parseSource } from './youtube.js';
import { parseOptions } from './parse-options.js';
import { redactUrls } from './redact.js';

const log = childLogger({ mod: 'resolver' });

const RESOLVE_TIMEOUT_MS = 45_000;
const MAX_STDERR = 16 * 1024;
const RESOLVE_TMP_ROOT = join(tmpdir(), 'cyberstream-resolve');

export class ResolveError extends Error {
  constructor(message, { code = 'RESOLVE_FAILED', statusCode = 422 } = {}) {
    super(message);
    this.name = 'ResolveError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * url -> { value, expiresAt, refs }
 *
 * Resolved sources are shared between sessions: two tabs asking for the same
 * video must not run yt-dlp twice. Entries that point at a downloaded temp
 * file are reference counted, because a session deletes the file once the last
 * consumer lets go of it.
 */
const cache = new Map();
const inflightMap = new Map();

/**
 * Progressive (muxed) formats are preferred on purpose: they start streaming
 * immediately. A `bestvideo+bestaudio` choice makes yt-dlp download the whole
 * file and merge it first, which adds minutes of latency to a "live" stream.
 *
 * The height cap has to be applied to the *adaptive* branches too, not just the
 * progressive ones. Many videos have no progressive format above 360p, so a
 * selector that only caps `best[...]` falls through to `bestvideo` and takes
 * whatever YouTube considers best - typically 4K AV1. That is a serious
 * problem here: FFmpeg then has to *decode* 4K AV1 in real time, and when it
 * cannot, the video output falls permanently behind the (trivially cheap) audio
 * output. Measured on a 24-core desktop: 4K AV1 gave 0.70x real time while a
 * 358p H.264 source gave 1.01x, with the output settings identical.
 *
 * AVC is preferred within the height cap because it is by far the cheapest
 * source to decode; VP9 and AV1 are accepted only if AVC is unavailable.
 */
const DEFAULT_FORMAT =
  'best[ext=mp4][height<=720][acodec!=none][vcodec!=none]/' +
  'best[height<=720][acodec!=none][vcodec!=none]/' +
  'bestvideo[height<=720][vcodec^=avc1]+bestaudio/' +
  'bestvideo[height<=720][vcodec^=vp9]+bestaudio/' +
  'bestvideo[height<=720]+bestaudio/' +
  'best[height<=720]/' +
  'bestvideo*+bestaudio/best';

/**
 * Resolve a user reference and return a handle that must be released when the
 * consumer is done; releasing is what allows merged temp files to be reclaimed.
 *
 * @param {unknown} rawInput
 * @returns {Promise<object>} resolved source (has `.release()`)
 */
export async function acquireSource(rawInput) {
  const parsed = parseSource(rawInput, parseOptions());

  if (parsed.kind === SOURCE_KIND.DIRECT) {
    return {
      kind: parsed.kind,
      videoId: null,
      sources: { muxed: true, video: { url: parsed.url, headers: {} } },
      localFile: null,
      host: new URL(parsed.url).hostname,
      duration: null,
      isLive: false,
      splitSource: false,
      title: parsed.label,
      release() {},
    };
  }

  const key = parsed.url;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    cached.refs += 1;
    return decorate(cached, key);
  }
  if (cached) await releaseEntry(key, cached);

  if (!inflightMap.has(key)) {
    const pending = resolveYouTube(parsed)
      .then((value) => {
        const entry = { value, expiresAt: Date.now() + config.youtube.resolveTtlMs, refs: 0 };
        cache.set(key, entry);
        trimCache();
        return entry;
      })
      .catch((err) => {
        cache.delete(key);
        throw err;
      });
    inflightMap.set(key, pending);
    pending
      .catch(() => {})
      .finally(() => {
        if (inflightMap.get(key) === pending) inflightMap.delete(key);
      });
  }

  const entry = await inflightMap.get(key);
  entry.refs += 1;
  return decorate(entry, key);
}

/** Plain resolve without refcounting - used by scripts and tests. */
export async function resolveSource(rawInput) {
  const handle = await acquireSource(rawInput);
  const { release, ...rest } = handle;
  void release;
  return rest;
}

function decorate(entry, key) {
  return {
    ...entry.value,
    release() {
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs === 0 && entry.expiresAt <= Date.now()) {
        void releaseEntry(key, entry);
      }
    },
  };
}

async function releaseEntry(key, entry) {
  if (!entry) return;
  if (key && cache.get(key) === entry) cache.delete(key);
  const file = entry.value?.localFile;
  if (file && file.startsWith(RESOLVE_TMP_ROOT)) {
    // Only ever unlink inside the temp root we created.
    await unlink(file).catch(() => {});
    log.debug({ file: basename(file) }, 'removed merged temp file');
  }
}

function trimCache(max = 100) {
  while (cache.size > max) {
    const [key, entry] = cache.entries().next().value;
    cache.delete(key);
    if (entry.refs === 0) void releaseEntry(key, entry);
  }
}

/** Removes the whole scratch directory on shutdown. */
export async function purgeResolveTemp() {
  inflightMap.clear();
  const entries = [...cache.values()];
  cache.clear();
  for (const entry of entries) void releaseEntry(null, entry);
  await rm(RESOLVE_TMP_ROOT, { recursive: true, force: true }).catch(() => {});
}

async function resolveYouTube(source) {
  const args = buildYtDlpArgs(source);
  const started = Date.now();

  const { stdout, stderr, code, signal } = await runYtDlp(args);

  if (code !== 0 || !stdout.trim()) {
    const reason = translateError(stderr, stdout);
    // yt-dlp echoes the page URL and sometimes a signed media URL on failure;
    // scrub before it reaches the log file.
    log.warn(
      { err: reason.message, stderr: redactUrls(stderr).slice(-800) },
      'resolve failed',
    );
    throw reason;
  }

  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new ResolveError('yt-dlp returned unreadable output.');
  }

  const entries = Array.isArray(info) ? info : [info];
  const media = entries.find((e) => e && (e.url || e.filepath)) ?? entries[0];
  if (!media) throw new ResolveError('No playable stream found for that video.');

  const isLive = Boolean(media.is_live);
  const duration = Number.isFinite(media.duration) ? media.duration : null;

  if (
    !isLive &&
    config.youtube.maxSourceDuration > 0 &&
    duration &&
    duration > config.youtube.maxSourceDuration
  ) {
    throw new ResolveError(
      `That video is ${Math.round(duration / 60)} min long; this server caps sources at ` +
        `${Math.round(config.youtube.maxSourceDuration / 60)} min.`,
      { code: 'SOURCE_TOO_LONG' },
    );
  }

  // `--dump-single-json` never downloads, so a selection that would normally be
  // merged comes back as `requested_formats` with no top level url. Rather
  // than downloading and merging the whole file (minutes of latency for a
  // "play it now" product), we hand FFmpeg both adaptive streams as separate
  // inputs and map video from one and audio from the other.
  const requested = Array.isArray(media.requested_formats) ? media.requested_formats : null;
  const localFile = media.filepath || media._filename || null;

  const pick = (predicate) =>
    requested?.find((f) => f?.url && predicate(f)) ??
    (requested === null && media.url ? media : null);

  const videoFormat = pick((f) => f.vcodec && f.vcodec !== 'none');
  const audioFormat = pick((f) => f.acodec && f.acodec !== 'none');
  const progressive =
    requested === null
      ? Boolean(media.url)
      : requested.length === 1 && Boolean(requested[0]?.url);

  if (!localFile && !videoFormat && !progressive) {
    throw new ResolveError('That video has no downloadable stream.');
  }

  const fallbackHeaders = defaultHeaders(source);
  const withDefaultHeaders = (headers) => ({ ...fallbackHeaders, ...sanitiseHeaders(headers) });

  const sources = localFile
    ? { muxed: true, video: { url: localFile, headers: {} } }
    : progressive
      ? { muxed: true, video: { url: videoFormat?.url ?? media.url, headers: withDefaultHeaders(videoFormat?.http_headers ?? media.http_headers) } }
      : {
          muxed: false,
          video: { url: videoFormat.url, headers: withDefaultHeaders(videoFormat.http_headers) },
          audio: audioFormat
            ? { url: audioFormat.url, headers: withDefaultHeaders(audioFormat.http_headers) }
            : null,
        };

  const result = {
    kind: source.kind,
    videoId: source.videoId,
    sources,
    /** Kept for logging and for the merged-temp-file cleanup path. */
    localFile: localFile ?? null,
    host: localFile ? 'local' : safeHost(sources.video.url),
    ext: videoFormat?.ext ?? media.ext ?? null,
    formatIds: requested ? requested.map((f) => f.format_id) : [media.format_id],
    splitSource: sources.muxed === false,
    title: cleanTitle(media.title) ?? `YouTube ${source.videoId}`,
    uploader: cleanTitle(media.uploader ?? media.channel) ?? null,
    duration,
    isLive,
    thumbnail: media.thumbnail ?? null,
    resolvedAt: Date.now(),
    resolveMs: Date.now() - started,
  };

  log.info(
    {
      videoId: source.videoId,
      host: result.host,
      ms: result.resolveMs,
      live: isLive,
      split: result.splitSource,
      formats: result.formatIds,
    },
    'resolved source',
  );
  return result;
}

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function defaultHeaders(source) {
  const headers = { 'user-agent': DESKTOP_UA };
  if (source.kind === SOURCE_KIND.YOUTUBE) headers.referer = 'https://www.youtube.com/';
  return headers;
}

/** Keeps only well-formed header names with scalar values. */
function sanitiseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(k)) out[k] = v;
  }
  return out;
}

function buildYtDlpArgs(source) {
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--no-progress',
    '--ignore-config',
    '--no-call-home',
    '--socket-timeout',
    '20',
    '--retries',
    '2',
    '--dump-single-json',
    // We only ever read metadata: even a `video+audio` selection is handed to
    // FFmpeg as two separate inputs, so yt-dlp never has to write a file.
    '--no-download',
  ];

  args.push('--format', config.youtube.format || DEFAULT_FORMAT);

  if (config.youtube.clients) {
    args.push('--extractor-args', `youtube:player_client=${config.youtube.clients}`);
  }
  if (config.youtube.extraArgs) {
    // Operator supplied, via the environment - still split into an argv array.
    args.push(...splitArgs(config.youtube.extraArgs));
  }

  // Positional last: even a value starting with "-" is then treated as a URL by
  // yt-dlp, and the source was already validated before we got here.
  args.push('--', source.url);
  return args;
}

/** Minimal POSIX-ish splitter for operator supplied env args (no shell). */
export function splitArgs(input) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      has = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.youtube.ytDlpPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        // A predictable locale keeps yt-dlp from mangling non-ASCII titles.
        LC_ALL: process.platform === 'win32' ? 'C' : (process.env.LC_ALL ?? 'C.UTF-8'),
        PYTHONIOENCODING: 'utf-8',
      },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new ResolveError('Resolving that video took too long. Try again in a moment.', {
          code: 'RESOLVE_TIMEOUT',
          statusCode: 504,
        }),
      );
    }, RESOLVE_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.length > 8 * 1024 * 1024) child.kill('SIGKILL');
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_STDERR) stderr += d.toString('utf8').slice(0, 4096);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new ResolveError(
          err.code === 'ENOENT'
            ? 'yt-dlp is not installed on this server (set YT_DLP_PATH).'
            : `Could not run yt-dlp: ${err.message}`,
          { code: 'YTDLP_MISSING', statusCode: 503 },
        ),
      );
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, signal });
    });
  });
}

/** Maps yt-dlp's stderr onto messages that mean something to a human. */
function translateError(stderr) {
  const text = `${stderr}`.toLowerCase();

  const rules = [
    [/private video|this video is private/, 'That video is private.'],
    [/members-only|join this channel/, 'That video is members-only.'],
    [
      /video unavailable|has been removed|does not exist/,
      'That video is unavailable or has been removed.',
    ],
    [/confirm your age|age-restricted|inappropriate for some users/, 'That video is age-restricted and cannot be streamed here.'],
    [/not a bot|sign in to confirm/, 'YouTube asked for a sign-in check. Try a different video.'],
    [/not available in your country|blocked it in your country/, 'That video is not available from this server region.'],
    [/copyright/, 'That video was removed for copyright reasons.'],
    [/premieres in|in \d+ (day|hour|minute|second)/, 'That video has not premiered yet.'],
    [/http error 429|too many requests/, 'YouTube is rate-limiting this server. Try again shortly.'],
    [/\b403\b|forbidden/, 'YouTube refused the stream request (403). Try again shortly.'],
    [/\b404\b|not found/, 'YouTube could not find that video (404).'],
    [/\b5\d\d\b|server error|internal server error/, 'YouTube returned a server error. Try again shortly.'],
  ];
  for (const [re, message] of rules) {
    if (re.test(text)) return new ResolveError(message);
  }
  if (/ffmpeg|ffprobe/.test(text) && /not found|not installed/.test(text)) {
    return new ResolveError('yt-dlp needs FFmpeg to merge streams, and FFmpeg is missing.', {
      code: 'FFMPEG_MISSING',
      statusCode: 503,
    });
  }
  return new ResolveError(
    'Could not resolve that video. It may be region locked, private or unsupported.',
  );
}

function cleanTitle(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned || cleaned.length > 200) return null;
  return cleaned;
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function clearResolveCache() {
  for (const [key, entry] of cache) {
    cache.delete(key);
    if (entry.refs === 0) void releaseEntry(key, entry);
  }
}
