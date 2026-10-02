import { z } from 'zod';

/** Turns "12", "12 KB", "8kb", 8_192 into a byte count. */
const bytes = (fallback) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return fallback;
      if (typeof v === 'number') return Math.trunc(v);
      const m = /^\s*([\d.]+)\s*(b|kb|mb|gb)?\s*$/i.exec(v);
      if (!m) return fallback;
      const n = Number(m[1]);
      const unit = (m[2] ?? 'b').toLowerCase();
      const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[unit];
      return Math.trunc(n * mult);
    });

/** Accepts "1h 30m", "90", "1:30:00", "3600000ms" -> milliseconds. */
const duration = (fallback) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return fallback;
      if (typeof v === 'number') return Math.trunc(v);
      const s = v.trim().toLowerCase();
      let m = /^([\d.]+)\s*ms$/.exec(s);
      if (m) return Math.trunc(Number(m[1]));
      m = /^([\d.]+)\s*h(?:ours?|rs?)?\s*([\d.]+)?\s*m(?:in(?:utes?)?)?$/.exec(s);
      if (m) return Math.trunc(Number(m[1]) * 3600_000 + Number(m[2] ?? 0) * 60_000);
      m = /^([\d.]+)\s*m(?:in(?:utes?)?)?$/.exec(s);
      if (m) return Math.trunc(Number(m[1]) * 60_000);
      m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
      if (m) {
        const [, a, b, c] = m;
        return (Number(a) * 3600 + Number(b) * 60 + Number(c ?? 0)) * 1000;
      }
      if (/^[\d.]+$/.test(s)) return Math.trunc(Number(s));
      return fallback;
    });

const bool = (fallback) =>
  z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return fallback;
      if (typeof v === 'boolean') return v;
      return ['1', 'true', 'yes', 'on', 'y'].includes(v.trim().toLowerCase());
    });

const int = (min, max, fallback) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return fallback;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: 'custom', message: `expected a number, got "${v}"` });
        return z.NEVER;
      }
      return Math.min(max, Math.max(min, Math.trunc(n)));
    });

const str = (fallback) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v.trim()));

const list = (fallback) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : fallback,
    );

const schema = z.object({
  NODE_ENV: str('development'),
  HOST: str('0.0.0.0'),
  PORT: int(1, 65535, 8080),
  PUBLIC_ORIGIN: str(''),
  ALLOWED_ORIGINS: list(['http://localhost:8080', 'http://127.0.0.1:8080']),

  STREAM_TOKEN: str(''),
  ALLOW_CLIENT_TOKEN_BOOTSTRAP: bool(true),
  MAX_JSON_BODY: bytes(8 * 1024),
  VIEWER_TOKEN_TTL: duration(15 * 60_000),

  MAX_SESSION_MS: duration(2 * 3600_000),
  ORPHAN_GRACE_MS: duration(30_000),
  BOOT_TIMEOUT_MS: duration(20_000),
  CLEANUP_INTERVAL_MS: duration(15_000),
  MAX_SESSIONS: int(1, 512, 32),
  RATE_LIMIT_CREATE_PER_MIN: int(1, 10_000, 10),
  RATE_LIMIT_GLOBAL_PER_MIN: int(10, 100_000, 600),
  MAX_TEMP_BYTES: bytes(512 * 1024 * 1024),

  FFMPEG_PATH: str('ffmpeg'),
  VIDEO_WIDTH: int(160, 4096, 1280),
  VIDEO_HEIGHT: int(90, 4096, 720),
  VIDEO_FPS: int(5, 60, 25),
  // mpeg1video quantiser, 1 (best) .. 31 (worst).
  //
  // Measured on the encoder this app drives, at 720p, the quantiser is a weak
  // lever: q5 costs 2154 kbit/s and q16 still costs 1419 - the whole range is
  // only 1.5x. Resolution is the real lever (540p ~914, 720p ~1600, 1080p ~3000
  // kbit/s). So at 720p it is worth spending a *low* q, which is where the
  // picture quality lives: q10 is visibly better than q16 for ~15% more
  // bitrate. The old q5 default was never needed to hit a bitrate target - it
  // just pushed high-motion sources to 5.8 Mbit/s, which is what made playback
  // choppy.
  VIDEO_Q: int(1, 31, 10),
  // Ceiling for a client-chosen quality preset. Deliberately separate from
  // VIDEO_WIDTH/VIDEO_HEIGHT, which are the *default* output. When the two were
  // the same value, a 720p default silently clamped the 1080p preset back to
  // 720p and the quality menu offered a choice that changed nothing.
  VIDEO_MAX_WIDTH: int(160, 4096, 1920),
  VIDEO_MAX_HEIGHT: int(90, 4096, 1080),
  GOP: int(1, 250, 12),
  MUX_DELAY: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? 0.1 : Number(v))),
  AUDIO_BITRATE: str('128k'),
  AUDIO_SAMPLE_RATE: int(8000, 48000, 44100),
  AUDIO_CHANNELS: int(1, 2, 2),
  FFMPEG_THREADS: int(0, 64, 0),
  PROBE_SIZE: bytes(4 * 1024 * 1024),
  ANALYZE_DURATION: int(100_000, 30_000_000, 5_000_000),
  TS_CLOCK_ENABLED: bool(true),
  MAX_MUXING_QUEUE: int(16, 65_535, 1024),
  RW_TIMEOUT_US: int(1_000_000, 300_000_000, 20_000_000),

  YT_DLP_PATH: str('yt-dlp'),
  YT_DLP_EXTRA_ARGS: str(''),
  YT_DLP_CLIENTS: str(''),
  YT_DLP_FORMAT: str(''),
  RESOLVE_TTL_MS: duration(15 * 60_000),
  MAX_SOURCE_DURATION: int(0, 86_400, 0),
  ALLOW_DIRECT_MEDIA_URLS: bool(false),
  // Ports permitted for direct media URLs, or "any".
  DIRECT_MEDIA_PORTS: str('80,443'),
  // Allow direct media URLs that point at loopback/LAN hosts (dev only).
  ALLOW_PRIVATE_MEDIA_HOSTS: bool(false),

  LOG_LEVEL: str('info'),
  LOG_PRETTY: bool(true),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  process.stderr.write(`Invalid environment configuration:\n${details}\n`);
  process.exit(78); // EX_CONFIG
}

const env = parsed.data;

export const config = Object.freeze({
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  host: env.HOST,
  port: env.PORT,
  publicOrigin: env.PUBLIC_ORIGIN.replace(/\/+$/, ''),
  allowedOrigins: env.ALLOWED_ORIGINS,

  security: Object.freeze({
    streamToken: env.STREAM_TOKEN,
    allowClientTokenBootstrap: env.ALLOW_CLIENT_TOKEN_BOOTSTRAP,
    maxJsonBody: env.MAX_JSON_BODY,
    viewerTokenTtlMs: env.VIEWER_TOKEN_TTL,
  }),

  sessions: Object.freeze({
    maxDurationMs: env.MAX_SESSION_MS,
    orphanGraceMs: env.ORPHAN_GRACE_MS,
    bootTimeoutMs: env.BOOT_TIMEOUT_MS,
    cleanupIntervalMs: env.CLEANUP_INTERVAL_MS,
    max: env.MAX_SESSIONS,
    maxTempBytes: env.MAX_TEMP_BYTES,
  }),

  rateLimit: Object.freeze({
    createPerMin: env.RATE_LIMIT_CREATE_PER_MIN,
    globalPerMin: env.RATE_LIMIT_GLOBAL_PER_MIN,
  }),

  video: Object.freeze({
    ffmpegPath: env.FFMPEG_PATH,
    width: env.VIDEO_WIDTH,
    height: env.VIDEO_HEIGHT,
    // Ceiling for a client-chosen preset, always at least the default output so
    // a misconfigured pair cannot make the default unreachable.
    maxWidth: Math.max(env.VIDEO_MAX_WIDTH, env.VIDEO_WIDTH),
    maxHeight: Math.max(env.VIDEO_MAX_HEIGHT, env.VIDEO_HEIGHT),
    fps: env.VIDEO_FPS,
    q: env.VIDEO_Q,
    gop: env.GOP,
    muxDelay: env.MUX_DELAY,
    threads: env.FFMPEG_THREADS,
    probeSize: env.PROBE_SIZE,
    analyzeDuration: env.ANALYZE_DURATION,
    tsClock: env.TS_CLOCK_ENABLED,
    maxMuxingQueue: env.MAX_MUXING_QUEUE,
    rwTimeoutUs: env.RW_TIMEOUT_US,
  }),

  audio: Object.freeze({
    bitrate: env.AUDIO_BITRATE,
    sampleRate: env.AUDIO_SAMPLE_RATE,
    channels: env.AUDIO_CHANNELS,
  }),

  youtube: Object.freeze({
    ytDlpPath: env.YT_DLP_PATH,
    extraArgs: env.YT_DLP_EXTRA_ARGS,
    clients: env.YT_DLP_CLIENTS,
    format: env.YT_DLP_FORMAT,
    resolveTtlMs: env.RESOLVE_TTL_MS,
    maxSourceDuration: env.MAX_SOURCE_DURATION,
    allowDirectMediaUrls: env.ALLOW_DIRECT_MEDIA_URLS,
    directMediaPorts: env.DIRECT_MEDIA_PORTS.split(',')
      .map((p) => p.trim())
      .filter(Boolean),
    allowPrivateMediaHosts: env.ALLOW_PRIVATE_MEDIA_HOSTS,
  }),

  log: Object.freeze({
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY && env.NODE_ENV !== 'production',
  }),
});

/** Absolute URL prefix helpers, aware of a TLS-terminating proxy. */
export function publicBaseUrl(req) {
  if (config.publicOrigin) return config.publicOrigin;
  const proto =
    req?.headers?.['x-forwarded-proto']?.split(',')[0]?.trim() ||
    (req?.socket?.encrypted ? 'https' : 'http');
  const host =
    req?.headers?.['x-forwarded-host']?.split(',')[0]?.trim() ||
    req?.headers?.host ||
    `${config.host}:${config.port}`;
  return `${proto}://${host}`;
}
