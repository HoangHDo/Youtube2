/**
 * Session lifecycle, subscriber fan-out and reaping.
 *
 * One `Session` == one FFmpeg process == one logical stream. Viewers
 * (WebSocket for MPEG-TS, HTTP for MP3) attach and detach freely; the process
 * only dies when the last viewer leaves for longer than ORPHAN_GRACE_MS, when
 * the hard lifetime cap is hit, when the source ends, or when someone calls
 * the stop endpoint.
 */
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { childLogger } from './logger.js';
import { newSessionId, newViewerToken, shortId } from './ids.js';
import { acquireSource } from './resolver.js';
import { Transcoder } from './ffmpeg.js';
import { TsClock } from './ts-clock.js';
import { SESSION_TMP_ROOT } from './orphan-reaper.js';

export const SESSION_STATE = Object.freeze({
  RESOLVING: 'resolving',
  STARTING: 'starting',
  LIVE: 'live',
  ENDED: 'ended',
  FAILED: 'failed',
  STOPPING: 'stopping',
});

/** Per-subscriber buffering ceilings. */
const VIDEO_HIGH_WATER = 1024 * 1024; // 1 MiB queued in the browser socket
const AUDIO_HIGH_WATER = 512 * 1024; // ~32s of 128 kbps MP3, then we shed
const OVERFLOW_NOTICE_MS = 1000;

/** How long a finished session lingers so clients can read the final state. */
const LINGER_MS = 30_000;

let sessionCounter = 0;

export class Session extends EventEmitter {
  /** @param {import('./logger.js').Logger} log */
  constructor({ input, requestIp, log, ownerSocketId = null, quality = null }) {
    super();
    this.id = newSessionId();
    this.viewerToken = newViewerToken();
    this.ownerToken = newViewerToken(); // separate, higher-trust token for control
    this.seq = ++sessionCounter;
    this.log = log ?? childLogger({ mod: 'session', session: shortId(this.id) });

    this.requestIp = requestIp;
    this.ownerSocketId = ownerSocketId;

    this.state = SESSION_STATE.RESOLVING;
    this.reason = null;
    this.error = null;

    this.createdAt = Date.now();
    this.startedAt = null;
    this.endedAt = null;
    this.lastActivityAt = Date.now();
    this.orphanedAt = null;

    this.input = input;
    this.quality = quality;
    this.source = null;
    this.transcoder = null;
    this.hasVideo = false;
    this.hasAudio = false;
    /** Set when FFmpeg closes an output without ever writing to it. */
    this.missingTracks = { video: null, audio: null };

    this.videoSubscribers = new Set();
    this.audioSubscribers = new Set();

    this.stats = {
      videoBytes: 0,
      audioBytes: 0,
      videoDropped: 0,
      audioDropped: 0,
      videoFrames: 0,
    };

    this.tempDir = join(tmpdir(), SESSION_TMP_ROOT, `s-${shortId(this.id)}-${randomUUID().slice(0, 8)}`);
    this._timers = new Set();
    this._destroyed = false;
    this._lastOverflowNotice = 0;
    this._lastClockPush = 0;
    this._videoPts = null;
    this._videoPtsWall = 0;
    this._clockBase = null;

    // MPEG-TS clock: turns the byte stream into a real video timeline so the
    // client can measure A/V drift instead of guessing.
    this.clock = config.video.tsClock
      ? new TsClock((sample) => this._onClockSample(sample))
      : null;
  }

  _onClockSample({ ptsMs }) {
    const normalized = this.normalizeClock(ptsMs);
    this._videoPts = normalized;
    this._videoPtsWall = Date.now();
    // 2 Hz is plenty to drive a drift controller and keeps control traffic tiny.
    if (Date.now() - this._lastClockPush < 500) return;
    this._lastClockPush = Date.now();
    this.emit('clock', { ptsMs: normalized, at: this._videoPtsWall });
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  async start() {
    try {
      this.source = await acquireSource(this.input);
    } catch (err) {
      this.state = SESSION_STATE.FAILED;
      this.error = { code: err.code ?? 'RESOLVE_FAILED', message: err.message };
      this.endedAt = Date.now();
      this.source?.release?.();
      this.source = null;
      this.emit('state', this.statePayload());
      await this._disposeTempDir();
      throw err;
    }

    if (this._destroyed) {
      this.source.release?.();
      return;
    }

    this.setState(SESSION_STATE.STARTING);
    this.touch();

    const durationCap =
      !this.source.isLive && this.source.duration
        ? Math.min(this.source.duration * 1000, config.sessions.maxDurationMs)
        : config.sessions.maxDurationMs;

    this.transcoder = new Transcoder({
      sources: this.source.sources,
      durationMs: durationCap,
      log: this.log,
      sessionId: this.id,
      quality: this.quality,
      // FFmpeg's dual-file strategy writes its two outputs here, so they are
      // removed with the rest of the session's temp state.
      outputDir: this.tempDir,
      // A googlevideo link is signed for the address that fetched it. If the
      // host's egress address differs between the resolve and the fetch, the
      // link is valid for nobody and FFmpeg is refused with a 403 - a fault no
      // output strategy can fix. Resolving again from the same process gets a
      // link signed for the address this connection will actually use.
      refreshSources: () => this._refreshSources(),
    });

    this._wireTranscoder();

    const lifetimeTimer = setTimeout(() => {
      this.log.info('session hit the lifetime cap');
      this.stop('lifetime-cap');
    }, config.sessions.maxDurationMs);
    this._timers.add(lifetimeTimer);

    const bootTimer = setTimeout(() => {
      if (this.state === SESSION_STATE.STARTING) {
        this.fail('timed out while waiting for the first frame');
      }
    }, config.sessions.bootTimeoutMs);
    this._timers.add(bootTimer);

    try {
      await this.transcoder.start();
    } catch (err) {
      this.fail(err.message);
      throw err;
    }
  }

  /**
   * Resolve the source again and hand back fresh media links.
   *
   * Used once, when FFmpeg is refused the media URL. The old source is released
   * rather than leaked: it holds a reference in the resolver's shared cache,
   * and a session that keeps a dead link alive also keeps its cache entry from
   * being collected.
   */
  async _refreshSources() {
    const previous = this.source;
    // forceRefresh, not a plain re-resolve: the cached entry holds the exact
    // URL that was just refused, so returning it would replay the same 403.
    const fresh = await acquireSource(this.input, { forceRefresh: true });
    this.source = fresh;
    previous?.release?.();
    return fresh.sources;
  }

  _wireTranscoder() {    const t = this.transcoder;

    t.on('video', (chunk) => this._pumpVideo(chunk));
    t.on('audio', (chunk) => this._pumpAudio(chunk));
    t.on('log', (line) => this.log.debug({ line }, 'ffmpeg'));

    t.on('output-end', (kind) => {
      this.missingTracks[kind] = 'no-such-track';
      this.log.info({ kind }, 'ffmpeg output produced no data (missing track?)');
      this.emit('meta', this.metaPayload());
    });

    t.on('firstbyte', () => {
      this.startedAt ??= Date.now();
      this.touch();
      if (this.state === SESSION_STATE.STARTING) {
        this.hasVideo = this.hasVideo || t.hasVideo;
        this.hasAudio = t.hasAudio;
        this.setState(SESSION_STATE.LIVE);
        // A client that asked for a stream but never attached a viewer (closed
        // the tab, crashed before connecting, or only uses the API) would
        // otherwise pin an FFmpeg process until the lifetime cap, because
        // orphanedAt is only ever set from removeSubscriber(). Viewers attach
        // within milliseconds of the 201, so the grace window is ample for a
        // client that is going to connect at all.
        this.maybeMarkOrphaned();
        this.emit('meta', this.metaPayload());
      }
    });

    t.on('done', () => {
      if (this._isTerminal()) return;
      this.endedAt = Date.now();
      this.setState(SESSION_STATE.ENDED, 'source-ended');
    });

    t.on('fatal', (err) => {
      if (this._isTerminal()) return;
      this.fail(err.message);
    });
  }

  _isTerminal() {
    return (
      this.state === SESSION_STATE.ENDED ||
      this.state === SESSION_STATE.FAILED ||
      this.state === SESSION_STATE.STOPPING
    );
  }

  setState(next, reason = null) {
    if (this.state === next) return;
    this.state = next;
    if (reason) this.reason = reason;
    if (next === SESSION_STATE.LIVE || next === SESSION_STATE.ENDED) {
      this.orphanedAt = null;
    }
    this.touch();
    this.emit('state', this.statePayload());
    this.log.info({ state: next, reason }, 'session state');
  }

  fail(message) {
    if (this._isTerminal()) return;
    this.error = { code: 'FFMPEG_FAILED', message };
    this.endedAt = Date.now();
    this.setState(SESSION_STATE.FAILED, 'ffmpeg-failed');
    this._closeSubscribers('session-failed');
  }

  /** Graceful stop: kill FFmpeg, tell viewers, schedule teardown. */
  stop(reason = 'requested') {
    if (this._isTerminal()) return;
    this.setState(SESSION_STATE.STOPPING, reason);
    this.endedAt = Date.now();
    try {
      this.transcoder?.stop(reason);
    } catch {
      /* already dead */
    }
    this._closeSubscribers('stopped');
    this.scheduleTeardown(0);
  }

  _closeSubscribers(reason) {
    for (const sub of [...this.videoSubscribers, ...this.audioSubscribers]) {
      try {
        sub.close(reason);
      } catch {
        /* subscriber already gone */
      }
    }
  }

  scheduleTeardown(delay = LINGER_MS) {
    if (this._teardownTimer || this._destroyed) return;
    this._teardownTimer = setTimeout(() => this.destroy(), delay);
    this._teardownTimer.unref?.();
  }

  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.emit('destroyed', this.id);
    for (const timer of this._timers) clearTimeout(timer);
    this._timers.clear();
    if (this._teardownTimer) clearTimeout(this._teardownTimer);

    this._closeSubscribers('destroyed');
    try {
      this.transcoder?.stop('destroy');
      // Wait for FFmpeg to actually exit before deleting anything it was
      // writing. On Windows its output files cannot be unlinked while the
      // process holds them, which would leave the whole temp directory behind.
      await this.transcoder?.waitForExit?.(4000);
    } catch {
      /* already dead */
    }
    this.source?.release?.();
    this.source = null;
    await this._disposeTempDir();
    this.removeAllListeners();
    this.log.info('session destroyed');
  }

  async _disposeTempDir() {
    if (!this.tempDir) return;
    // Retry: a file handle can take a moment to clear after the writer exits,
    // and one failure would otherwise leave the directory on disk permanently.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(this.tempDir, { recursive: true, force: true });
        return;
      } catch {
        if (attempt === 4) {
          this.log.warn({ tempDir: this.tempDir }, 'could not remove session temp dir');
          return;
        }
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      }
    }
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  /* ------------------------------------------------------------------ */
  /* subscribers                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * @param {{write:(b:Buffer)=>void, close:(reason:string)=>void}} sub
   */
  addVideoSubscriber(sub) {
    this.videoSubscribers.add(sub);
    this.orphanedAt = null;
    this.touch();
    if (this._isTerminal()) {
      sub.close(this.reason ?? 'ended');
      this.videoSubscribers.delete(sub);
      return false;
    }
    this.log.debug({ viewers: this.videoSubscribers.size }, 'video subscriber attached');
    return true;
  }

  addAudioSubscriber(sub) {
    this.audioSubscribers.add(sub);
    this.orphanedAt = null;
    this.touch();
    if (this._isTerminal()) {
      sub.close(this.reason ?? 'ended');
      this.audioSubscribers.delete(sub);
      return false;
    }
    this.log.debug({ listeners: this.audioSubscribers.size }, 'audio subscriber attached');
    return true;
  }

  removeSubscriber(sub) {
    this.videoSubscribers.delete(sub);
    this.audioSubscribers.delete(sub);
    this.touch();
    this.maybeMarkOrphaned();
  }

  maybeMarkOrphaned() {
    if (this._isTerminal()) return;
    if (this.videoSubscribers.size === 0 && this.audioSubscribers.size === 0) {
      this.orphanedAt ??= Date.now();
    } else {
      this.orphanedAt = null;
    }
  }

  get viewerCount() {
    return this.videoSubscribers.size + this.audioSubscribers.size;
  }

  /* ------------------------------------------------------------------ */
  /* fan-out                                                             */
  /* ------------------------------------------------------------------ */

  _pumpVideo(chunk) {
    this.hasVideo = true;
    this.missingTracks.video = null;
    this.stats.videoBytes += chunk.length;
    this.stats.videoFrames += Math.ceil(chunk.length / 188);
    this.clock?.push(chunk);

    if (this._isTerminal()) return;

    for (const sub of [...this.videoSubscribers]) {
      try {
        sub.write(chunk);
      } catch (err) {
        this.log.warn({ err: err.message }, 'video subscriber write failed');
        this.videoSubscribers.delete(sub);
        try {
          sub.close('write-failed');
        } catch {
          /* noop */
        }
      }
    }
  }

  _pumpAudio(chunk) {
    this.hasAudio = true;
    this.missingTracks.audio = null;
    this.stats.audioBytes += chunk.length;
    if (this._isTerminal()) return;

    for (const sub of [...this.audioSubscribers]) {
      try {
        sub.write(chunk);
      } catch (err) {
        this.log.warn({ err: err.message }, 'audio subscriber write failed');
        this.audioSubscribers.delete(sub);
        try {
          sub.close('write-failed');
        } catch {
          /* noop */
        }
      }
    }
  }

  /** Called by the clock to publish a real video timestamp for drift control. */
  noteVideoClock(ptsMs) {
    this._onClockSample({ ptsMs });
  }

  /**
   * FFmpeg's MPEG-TS muxer starts PTS at a large offset (~2^30 ms) so that a
   * wrapped 33-bit timestamp cannot look like a backwards seek. The offset is
   * constant for a session, so we subtract the first sample we ever saw and
   * publish a timeline that starts near zero. Deltas - the only thing drift
   * correction needs - are unaffected.
   */
  normalizeClock(ptsMs) {
    if (ptsMs === null || ptsMs === undefined) return null;
    this._clockBase ??= ptsMs;
    return ptsMs - this._clockBase;
  }

  get videoClock() {
    return { ptsMs: this._videoPts, at: this._videoPtsWall, ageMs: Date.now() - this._videoPtsWall };
  }

  maybeNotifyOverflow(kind) {
    const now = Date.now();
    if (now - this._lastOverflowNotice < OVERFLOW_NOTICE_MS) return;
    this._lastOverflowNotice = now;
    this.emit('overflow', { kind, at: now });
  }

  /* ------------------------------------------------------------------ */
  /* payloads                                                            */
  /* ------------------------------------------------------------------ */

  statePayload() {
    return {
      sessionId: this.id,
      state: this.state,
      reason: this.reason,
      error: this.error,
      at: Date.now(),
    };
  }

  metaPayload() {
    const clock = this.videoClock;
    return {
      sessionId: this.id,
      state: this.state,
      title: this.source?.title ?? null,
      uploader: this.source?.uploader ?? null,
      thumbnail: this.source?.thumbnail ?? null,
      duration: this.source?.duration ?? null,
      isLive: this.source?.isLive ?? false,
      splitSource: this.source?.splitSource ?? false,
      videoId: this.source?.videoId ?? null,
      // `missingTracks` is authoritative; `hasVideo`/`hasAudio` only say what
      // has arrived *so far*. FFmpeg often emits the first audio chunk before
      // the first video chunk, so a client that trusted `hasVideo` at boot
      // would never start the video. Clients therefore start both transports
      // and switch one off when `missingTracks` says it does not exist.
      hasVideo: this.hasVideo,
      hasAudio: this.hasAudio,
      missingTracks: { ...this.missingTracks },
      strategy: this.transcoder?.strategy ?? null,
      // The *effective* output, not the server default: a session started with
      // a quality override reports what it is actually producing, so the client
      // badge tells the truth.
      quality: this.quality ?? null,
      width: this.transcoder?.video?.width ?? config.video.width,
      height: this.transcoder?.video?.height ?? config.video.height,
      fps: this.transcoder?.video?.fps ?? config.video.fps,
      audio: { bitrate: config.audio.bitrate, sampleRate: config.audio.sampleRate },
      muxDelayMs: Math.round(config.video.muxDelay * 1000),
      videoClock: clock.ptsMs,
      startedAt: this.startedAt,
      stats: { ...this.stats },
    };
  }

  info() {
    return {
      ...this.metaPayload(),
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      viewers: {
        video: this.videoSubscribers.size,
        audio: this.audioSubscribers.size,
      },
      orphaned: this.orphanedAt !== null,
    };
  }
}

/* ---------------------------------------------------------------------- */
/* registry                                                                */
/* ---------------------------------------------------------------------- */

/** @type {Map<string, Session>} */
const sessions = new Map();

export const sessionStore = {
  get(id) {
    return sessions.get(id);
  },
  all() {
    return [...sessions.values()];
  },
  get size() {
    return sessions.size;
  },
  create(opts) {
    if (sessions.size >= config.sessions.max) {
      const err = new Error(
        `This server is already streaming ${config.sessions.max} sessions. Try again shortly.`,
      );
      err.statusCode = 503;
      err.code = 'TOO_MANY_SESSIONS';
      throw err;
    }
    const session = new Session(opts);
    sessions.set(session.id, session);
    session.once('destroyed', () => sessions.delete(session.id));
    // `destroy()` clears listeners, so use a separate hook that always runs.
    session.on('state', (payload) => {
      if (
        payload.state === SESSION_STATE.ENDED ||
        payload.state === SESSION_STATE.FAILED ||
        payload.state === SESSION_STATE.STOPPING
      ) {
        sessions.delete(session.id);
        session.scheduleTeardown();
      }
    });
    return session;
  },
  delete(id) {
    const session = sessions.get(id);
    if (!session) return false;
    sessions.delete(id);
    void session.destroy();
    return true;
  },
};

/**
 * Periodic reaper: stops orphaned sessions, enforces the lifetime cap, and
 * deletes anything that fell through the cracks. Runs on an unref'd timer so it
 * never keeps the process alive.
 */
export function startReaper() {
  const log = childLogger({ mod: 'reaper' });
  const timer = setInterval(() => {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      if (now - session.lastActivityAt > config.sessions.maxDurationMs + 60_000) {
        log.warn({ session: session.id }, 'reaping stale session');
        void session.destroy();
        continue;
      }
      if (
        session.orphanedAt !== null &&
        now - session.orphanedAt > config.sessions.orphanGraceMs &&
        !session._isTerminal()
      ) {
        log.info({ session: session.id }, 'reaping orphaned session');
        session.stop('orphaned');
      }
    }
  }, config.sessions.cleanupIntervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function shutdownAll(reason = 'shutdown') {
  const all = [...sessions.values()];
  await Promise.allSettled(
    all.map(async (session) => {
      session.stop(reason);
      await session.destroy();
    }),
  );
  sessions.clear();
}

export { VIDEO_HIGH_WATER, AUDIO_HIGH_WATER };
