/**
 * VideoPlayer: owns the JSMpeg instance, the <canvas>, the <audio> element and
 * the reconnection logic for both transports.
 *
 * Recovery model
 * --------------
 * Video (WebSocket -> JSMpeg): JSMpeg reconnects on its own socket errors, but
 * only the browser's WebSocket does, so we drive it: on close we tear the
 * player down and build a new one, which forces a fresh demuxer and a new
 * keyframe wait. Bounded exponential backoff, and never past a dead session.
 *
 * Audio (HTTP -> <audio>): the element cannot be "reconnected" without
 * re-issuing the request, so we re-point `src` at the same URL. The browser
 * then re-fetches from the live edge. Same backoff, independent of video, so
 * one dead transport never takes the other down.
 */
import { AvSync } from './av-sync.js';

const RETRY_DELAYS = [0, 800, 1600, 3000, 5000, 8000, 12_000, 20_000];

/**
 * Client-side decode watchdog.
 *
 * The window is long enough that a slow start or a single stalled buffer refill
 * cannot trip it, and short enough that the user is told within a few seconds
 * of the picture actually going bad.
 */
const DECODE_WATCH_TICK_MS = 1000;
const DECODE_WATCH_WINDOW_MS = 8000;
/**
 * Below this, the decoder is not keeping up with real time. 0.95 rather than 1.0
 * so ordinary jitter does not trip it - the point is to catch a decoder running
 * at a fraction of real time, not to police a millisecond.
 */
const DECODE_MIN_RATIO = 0.95;

/**
 * Seconds of audio to buffer before starting playback.
 *
 * The element refills at exactly 1x, so a thin buffer has no way to absorb a
 * delivery hiccup and one stall leaves it permanently behind. Three seconds is
 * far more than the jitter seen on a local or LAN stream, and the wait is
 * invisible next to the time JSMpeg already spends finding its first keyframe.
 */
const AUDIO_PREROLL_SEC = 3;
/** Give up waiting for the full cushion and play whatever has arrived. */
const AUDIO_PREROLL_TIMEOUT_MS = 10_000;

/** Seconds of audio buffered ahead of the playhead. */
export function bufferedAhead(el) {
  if (!el?.buffered?.length) return 0;
  const end = el.buffered.end(el.buffered.length - 1);
  return Number.isFinite(end) ? Math.max(0, end - el.currentTime) : 0;
}

export const PLAYER_STATE = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  BUFFERING: 'buffering',
  PLAYING: 'playing',
  PAUSED: 'paused', // viewer-initiated: the frame is held, the server keeps going
  DEGRADED: 'degraded', // one transport is down, the other still works
  ENDED: 'ended',
  ERROR: 'error',
});

export class VideoPlayer extends EventTarget {
  constructor({ canvas, audioEl, serverToken = null, syncEnabled = true, wasmReady = false, autoplay = true }) {
    super();
    this.canvas = canvas;
    this.audioEl = audioEl;
    this.serverToken = serverToken;
    this.wasmReady = wasmReady;
    // When false the audio is attached and buffered but left paused, so the
    // viewer starts it from the native controls themselves. This is a live
    // pipe, so "not yet" is a real state to honour rather than a setting to
    // silently ignore.
    this.autoplay = autoplay !== false;

    this.jsmpeg = null;
    this.session = null;
    this.state = PLAYER_STATE.IDLE;
    /**
     * Viewer-initiated pause. Kept separate from `state`, because several
     * states (buffering, degraded) can occur *while* paused and must not be
     * mistaken for "not paused".
     */
    this.paused = false;
    this._pausedAt = 0;
    /**
     * Set while the player is pausing/resuming on the audio element itself, so
     * the resulting `play`/`pause` events are not mistaken for the user
     * pressing play or pause on the native controls.
     */
    this._suppressAudioEvents = false;
    this.hasAudio = true;
    this.hasVideo = true;
    this.firstFrameAt = 0;
    this._videoRetries = 0;
    this._audioRetries = 0;
    this._stopped = true;
    this._reconnectTimers = new Set();
    this._degradeTimer = null;

    this.sync = new AvSync({
      getAudio: () => this.audioEl,
      getVideoTimeMs: () => this.videoTimeMs(),
      getServerPtsMs: () => this.sync.serverPtsMs,
      getBufferedAheadSec: () => bufferedAhead(this.audioEl),
      enabled: syncEnabled,
    });

    this._wireAudio();
  }

  /* ------------------------------------------------------------- events -- */
  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * States that may be entered while the viewer has paused.
   *
   * PAUSED is sticky on purpose. Several events can fire while paused - a
   * reconnect finishing, the audio element reporting `playing`, a buffer
   * filling - and each of them would otherwise report PLAYING and quietly
   * un-pause the UI while the video is still frozen. Guarding here means one
   * choke point rather than a check at every call site.
   */
  static _allowedWhilePaused(state) {
    return state === PLAYER_STATE.PAUSED
      || state === PLAYER_STATE.IDLE
      || state === PLAYER_STATE.ERROR
      || state === PLAYER_STATE.ENDED;
  }

  setState(state, detail = {}) {
    if (this.state === state) return;
    if (this.paused && !VideoPlayer._allowedWhilePaused(state)) {
      // Report it as a paused buffer/degraded state rather than dropping the
      // pause: the underlying condition is still true and worth showing.
      const held = state === PLAYER_STATE.PLAYING ? PLAYER_STATE.PAUSED : state;
      if (this.state === held) return;
      this.state = held;
      this._emit('state', { state: held, held: true, ...detail });
      return;
    }
    this.state = state;
    this._emit('state', { state, ...detail });
  }

  /* -------------------------------------------------------------- start -- */
  /**
   * @param {{sessionId:string, videoUrl:string, audioUrl:string, missingTracks?:{video:?string,audio:?string}, title?:string}} session
   */
  start(session) {
    this.stop({ keepState: true });
    this.session = session;
    this._stopped = false;
    this.paused = false;
    this._pausedAt = 0;
    this._videoRetries = 0;
    this._audioRetries = 0;

    // `missingTracks` is the only authoritative signal, and it is often not
    // known until FFmpeg has actually tried the output. So we always start
    // both and let disable*() switch off a track that turns out to be absent.
    this.hasAudio = session.missingTracks?.audio !== 'no-such-track';
    this.hasVideo = session.missingTracks?.video !== 'no-such-track';

    this.setState(PLAYER_STATE.CONNECTING);
    this.sync.start();
    this._startDecodeWatch();

    if (this.hasVideo) {
      this._startVideo();
      // Start audio only once the video is actually decoding. Attaching both at
      // once lets the audio reach the live edge while the video is still
      // filling, which is where a multi-second standing offset comes from.
      this._audioGate = this._after(3000, () => {
        if (this.hasAudio && this._stopped === false) this._startAudio();
      });
    } else if (this.hasAudio) {
      this._startAudio();
      this._emit('video:unavailable', {});
    } else {
      this._emit('video:unavailable', {});
      this._emit('audio:unavailable', {});
    }

    if (!this.hasVideo) this._emit('video:unavailable', {});
    if (!this.hasAudio) this._emit('audio:unavailable', {});

    if (!this.hasVideo && !this.hasAudio) {
      this.setState(PLAYER_STATE.ERROR, { message: 'This source has neither video nor audio.' });
    }
  }

  /** Called when the server reports a track it will never produce. */
  disableVideo() {
    this.hasVideo = false;
    this._videoRetries = RETRY_DELAYS.length;
    this._teardownJsmpeg();
    this._emit('video:unavailable', {});
    if (!this.hasAudio) {
      this.setState(PLAYER_STATE.ERROR, { message: 'This source has no video or audio.' });
    }
  }

  disableAudio() {
    this.hasAudio = false;
    this._audioRetries = RETRY_DELAYS.length;
    try {
      this.audioEl.pause();
      this.audioEl.removeAttribute('src');
      this.audioEl.load();
    } catch {
      /* ignore */
    }
    this._emit('audio:unavailable', {});
  }

  /* -------------------------------------------------------------- video -- */
  _startVideo() {
    if (this._stopped || !this.session) return;
    this._teardownJsmpeg();

    const started = performance.now();
    let established = false;

    try {
      // JSMpeg opens its own WebSocket; we only need to observe it.
      this.jsmpeg = new window.JSMpeg.Player(this.session.videoUrl, {
        canvas: this.canvas,
        // Audio is delivered by the <audio> element, so JSMpeg must stay mute.
        audio: false,
        video: true,
        autoplay: true,
        loop: false,
        // Frequent keyframes + a small queue: the stream is live, never seeked.
        progressive: false,
        chunkSize: 512 * 1024,
        reconnectInterval: 0, // we own reconnection, see _scheduleVideoRetry
        preserveDrawingBuffer: false,
        disableGl: false,
        smoothing: true,

        // JSMpeg only reaches its WASM decoder through a compiled
        // `jsmpeg.wasm` side module, which upstream builds with emscripten and
        // does not publish. If the file is missing, JSMpeg waits forever for it
        // and never opens the socket at all - so we take the pure JS decoder
        // unless the operator has actually dropped the module in place.
        disableWebAssembly: !this.wasmReady,

        onSourceEstablished: () => {
          established = true;
          this.firstFrameAt ||= performance.now();
          this._videoRetries = 0;
          this._emit('video:up', { bootMs: Math.round(performance.now() - started) });
          this.setState(PLAYER_STATE.PLAYING);
          // The video is decoding: release the audio gate (if it has not fired
          // already) so both start from the same live edge.
          if (this.hasAudio && this.audioEl.paused && !this.audioEl.getAttribute('src')) {
            this._startAudio();
          }
        },
        onStalled: () => {
          if (!this._stopped) this.setState(PLAYER_STATE.BUFFERING, { transport: 'video' });
        },
        onEnded: () => {
          if (!this._stopped) this._emit('video:ended', {});
        },
      });
    } catch (err) {
      this._emit('video:error', { message: err?.message ?? 'Player failed to start.' });
      this._scheduleVideoRetry();
      return;
    }

    // The socket JSMpeg just created is the one we watch for health.
    const socket = this.jsmpeg?.source?.socket;
    if (socket) {
      socket.addEventListener('close', (ev) => {
        if (this._stopped) return;
        this._emit('video:down', { code: ev.code, reason: ev.reason });
        // 1000 = server closed a finished stream; do not fight it.
        if (ev.code === 1000 && this._sessionFinished()) return;
        this._scheduleVideoRetry();
      });
      socket.addEventListener('error', () => {
        if (this._stopped) return;
        this._emit('video:down', { code: 1006, reason: 'socket error' });
        this._scheduleVideoRetry();
      });
    }

    if (!established) {
      // A short guard: if nothing is established by now, surface buffering.
      this._after(9000, () => {
        if (!established && !this._stopped) {
          this.setState(PLAYER_STATE.BUFFERING, { transport: 'video' });
        }
      });
    }
  }

  _teardownJsmpeg() {
    if (!this.jsmpeg) return;
    try {
      this.jsmpeg.destroy();
    } catch {
      /* already gone */
    }
    this.jsmpeg = null;
  }

  _scheduleVideoRetry() {
    // While paused the video socket is expected to go quiet: the decoder has
    // stopped, so the server eventually sheds data for us. Rebuilding the
    // player then would reconnect, find the live edge, and resume without being
    // asked - un-pausing the viewer from under them.
    if (this.paused) return;
    if (this._stopped || !this.session) return;
    if (this._videoRetries >= RETRY_DELAYS.length) {
      this._markDegraded('video');
      this._emit('video:failed', { message: 'Video stream could not be recovered.' });
      return;
    }
    const delay = RETRY_DELAYS[Math.min(this._videoRetries, RETRY_DELAYS.length - 1)];
    this._videoRetries += 1;
    this.setState(PLAYER_STATE.BUFFERING, { transport: 'video' });
    this._emit('video:retrying', { attempt: this._videoRetries, delay });
    // The video playhead is about to jump to an unrelated position, which
    // invalidates the A/V baseline. Re-baseline here rather than letting the
    // controller read the jump as drift.
    this.sync.noteDiscontinuity('video-retry');
    this._after(delay, () => {
      if (this._stopped) return;
      this._startVideo();
    });
  }

  /* -------------------------------------------------------------- audio -- */
  _startAudio() {
    if (this._stopped || !this.session) return;
    const el = this.audioEl;
    // Crossorigin is not needed (same-origin, no credentials) and would force a
    // CORS preflight we do not want on a media request.
    el.crossOrigin = null;
    el.preload = 'auto';
    el.src = this.session.audioUrl;
    el.load();

    if (!this.autoplay) {
      // The element is attached and preloading, so pressing play is instant, but
      // nothing is started on the viewer's behalf. Returning before the
      // preroll below keeps the buffer from filling unplayed.
      this._emit('audio:state', { state: 'ready' });
      this._emit('audio:awaiting-play', {});
      return;
    }

    const play = () => {
      const attempt = el.play();
      if (attempt?.catch) {
        attempt.catch((err) => {
          if (err?.name === 'AbortError') return;
          this._emit('audio:blocked', { message: 'Click play to start audio.' });
        });
      }
    };

    // Hold playback until there is a real cushion of audio buffered.
    //
    // An <audio> element fed a live stream starts with almost nothing buffered,
    // and it then plays at 1x from a buffer that only ever refills at exactly
    // 1x. There is no margin: any hiccup in delivery empties it, the element
    // stalls, and it falls permanently behind - which reads to a viewer as the
    // audio and video drifting apart, for a reason that has nothing to do with
    // the two streams being misaligned.
    //
    // A few seconds of cushion costs a slightly later audio start and removes
    // the failure mode entirely. The timeout matters too: a source that never
    // gets that far ahead must still be audible rather than silent.
    this._cancelAfter('_audioPreroll');
    this._audioPreroll = this._after(0, () => {
      const ready = () => bufferedAhead(el) >= AUDIO_PREROLL_SEC;
      if (ready()) {
        play();
        return;
      }
      this._emit('audio:state', { state: 'priming' });
      const deadline = performance.now() + AUDIO_PREROLL_TIMEOUT_MS;
      const poll = () => {
        if (this._stopped) return;
        if (ready() || performance.now() > deadline) {
          if (!ready()) {
            this._emit('audio:state', { state: 'priming-timeout' });
          }
          play();
          return;
        }
        this._after(100, poll);
      };
      poll();
    });
  }

  _wireAudio() {
    const el = this.audioEl;

    el.addEventListener('loadstart', () => {
      this._emit('audio:state', { state: 'loading' });
    });
    el.addEventListener('canplay', () => {
      this._audioRetries = 0;
      this._emit('audio:state', { state: 'ready' });
      if (this.state === PLAYER_STATE.BUFFERING) {
        this.setState(PLAYER_STATE.PLAYING, { via: 'audio' });
      }
    });
    el.addEventListener('playing', () => {
      this._emit('audio:state', { state: 'playing' });
      this.setState(PLAYER_STATE.PLAYING);
    });
    el.addEventListener('waiting', () => {
      if (this._stopped) return;
      this._emit('audio:state', { state: 'stalled' });
      this._markDegraded('audio');
    });
    el.addEventListener('stalled', () => {
      if (this._stopped) return;
      this._emit('audio:state', { state: 'stalled' });
      this._markDegraded('audio');
    });
    el.addEventListener('error', () => {
      if (this._stopped) return;
      const code = el.error?.code;
      this._emit('audio:error', { code });
      this._scheduleAudioRetry();
    });
    el.addEventListener('ended', () => {
      if (this._stopped) return;
      // A live stream "ends" whenever the source is exhausted.
      this._emit('audio:ended', {});
      if (!this._sessionFinished()) this._scheduleAudioRetry();
    });
    el.addEventListener('pause', () => {
      if (this._stopped) return;
      this._emit('audio:state', { state: 'paused' });
      // The native controls carry their own play/pause button. Letting it move
      // only the audio would freeze the sound and keep the picture running -
      // which is the one thing that must never happen, since the two are only
      // in sync because they are corrected against each other. So the native
      // control is treated as a request for the whole player.
      if (this._suppressAudioEvents || this.paused) return;
      this.pause({ silent: true });
    });
    el.addEventListener('play', () => {
      if (this._stopped) return;
      if (this._suppressAudioEvents) return;
      // Symmetric: pressing play on the native element resumes both.
      if (this.paused) this.resume();
    });
  }

  _scheduleAudioRetry() {
    if (this.paused) return; // see _scheduleVideoRetry
    if (this._stopped || !this.session) return;
    if (!this.hasAudio) return;
    if (this._audioRetries >= RETRY_DELAYS.length) {
      this._emit('audio:failed', { message: 'Audio stream could not be recovered.' });
      return;
    }
    const delay = RETRY_DELAYS[Math.min(this._audioRetries, RETRY_DELAYS.length - 1)];
    this._audioRetries += 1;
    this._emit('audio:retrying', { attempt: this._audioRetries, delay });
    // A new src restarts the audio playhead from zero - the largest possible
    // discontinuity, so the baseline has to move with it.
    this.sync.noteDiscontinuity('audio-retry');
    this._after(delay, () => {
      if (this._stopped) return;
      this._startAudio();
    });
  }

  /* ------------------------------------------------- decode watchdog -- */
  /**
   * Watches whether the *client* can decode fast enough to keep up.
   *
   * The producer's health and the decoder's health look identical from the
   * browser: if the picture is not advancing, the video is stalling - but the
   * cause could be a slow encoder upstream or a machine that cannot decode
   * MPEG-1 at this resolution. Only the ratio of decoded media time to wall
   * time tells them apart, and only the client can measure it.
   *
   * A ratio persistently below 1 while the server clock is still advancing and
   * the socket is open means data is arriving fine and the decoder is the
   * bottleneck - so the fix is a lower resolution, not a reconnect. That is
   * worth reporting: a stuttering picture with no explanation is the single
   * most confusing failure this app can have, and the user can only act on it
   * if they are told which knob to turn.
   */
  _startDecodeWatch() {
    this._stopDecodeWatch();
    let last = null;
    let window = { wall: 0, media: 0, stalledTicks: 0, serverAdvancing: false };
    this._decodeWatch = setInterval(() => {
      if (this._stopped) return;
      const media = this.videoTimeMs();
      const now = performance.now();
      if (media === null || last === null) {
        last = media === null ? null : { wall: now, media };
        return;
      }
      const dWall = now - last.wall;
      // A paused or backgrounded tab decodes nothing; that is not a decode
      // failure and must not trigger advice about lowering the quality.
      if (this._isPlaybackActive() === false) {
        last = { wall: now, media };
        window = { wall: 0, media: 0, stalledTicks: 0, serverAdvancing: false };
        return;
      }
      window.wall += dWall;
      window.media += media - last.media;
      if (this.serverClockAgeMs() < 2500) window.serverAdvancing = true;
      last = { wall: now, media };

      if (window.wall < DECODE_WATCH_WINDOW_MS) return;
      const ratio = window.media / window.wall;
      this.decodeRatio = ratio;
      const behind = window.serverAdvancing && ratio < DECODE_MIN_RATIO;
      window = { wall: 0, media: 0, stalledTicks: 0, serverAdvancing: false };

      if (behind && !this._decodeWarned) {
        this._decodeWarned = true;
        this._emit('video:decodebound', {
          ratio: Number(ratio.toFixed(3)),
          width: this.jsmpeg?.video?.width ?? null,
          height: this.jsmpeg?.video?.height ?? null,
        });
      } else if (!behind && this._decodeWarned) {
        // Holding real time again - typically because the quality was stepped
        // down. Re-arm, or a *second* decode problem later would go unreported.
        // The bar is simply "not behind": a separate `ratio > min + epsilon`
        // check is unusable, because min + epsilon sits above real time and can
        // never be met.
        this._decodeWarned = false;
      }
    }, DECODE_WATCH_TICK_MS);
  }

  _stopDecodeWatch() {
    if (this._decodeWatch) clearInterval(this._decodeWatch);
    this._decodeWatch = null;
  }

  /** False when nothing is playing, or the tab is not being rendered. */
  _isPlaybackActive() {
    if (this._stopped || !this.jsmpeg || this.paused) return false;
    if (document.hidden || !document.hasFocus?.()) return false;
    return this.jsmpeg.video?.width > 0;
  }

  serverClockAgeMs() {
    const s = this.sync;
    if (!s || s.serverPtsMs === null) return Infinity;
    return Date.now() - s.serverPtsAt;
  }

  /* ------------------------------------------------------------ degrade -- */
  _markDegraded(which) {
    if (this._stopped) return;
    // A `waiting` event during the very first `load()` is normal, not a stall:
    // the element is simply filling for the first time. Only a stall in an
    // element that was actually playing counts.
    if (which === 'audio') {
      const el = this.audioEl;
      const wasPlaying = el.currentTime > 0.2 && el.readyState >= 3 && !el.paused;
      if (!wasPlaying) return;
    }
    // Give the transport a moment to recover before calling it degraded.
    this._clearDegradeTimer();
    this._degradeTimer = setTimeout(() => {
      if (this._stopped) return;
      // Recovered on its own: nothing to report.
      if (this.audioEl.readyState >= 3 && !this.audioEl.paused && this._videoOk()) {
        this.setState(PLAYER_STATE.PLAYING);
        return;
      }
      if (this.state === PLAYER_STATE.PLAYING) {
        this.setState(PLAYER_STATE.DEGRADED, { transport: which });
        this._emit('degraded', { transport: which });
      }
    }, 4000);
  }

  _videoOk() {
    return !this.hasVideo || this.jsmpeg?.source?.established === true;
  }

  _clearDegradeTimer() {
    if (this._degradeTimer) clearTimeout(this._degradeTimer);
    this._degradeTimer = null;
  }

  /* ------------------------------------------------------------- control -- */
  restartVideo() {
    if (this._stopped) return;
    this._videoRetries = 0;
    this.sync.noteDiscontinuity('video-restart');
    this._startVideo();
  }

  restartAudio() {
    if (this._stopped || !this.hasAudio) return;
    this._audioRetries = 0;
    this.sync.noteDiscontinuity('audio-restart');
    this._startAudio();
  }

  resync() {
    const ok = this.sync.hardResync();
    this._emit('sync:done', { ok });
    return ok;
  }

  setMuted(muted) {
    this.audioEl.muted = muted;
    this.audioEl.volume = muted ? 0 : 1;
  }

  /** Play both halves from a clean slate - the "restart" button. */
  restartBoth() {
    if (this._stopped || !this.session) return;
    this._videoRetries = 0;
    this._audioRetries = 0;
    this._startVideo();
    this._startAudio();
    this.sync.hardResync();
  }

  /* -------------------------------------------------------- pause/resume -- */
  /**
   * Holds the picture and silences the audio, without touching the server.
   *
   * The FFmpeg process belongs to the session, not to this viewer, so pausing
   * must not stop it - other viewers of the same session would go dark. The
   * client simply stops consuming.
   */
  pause({ silent = false } = {}) {
    if (this._stopped || !this.session || this.paused) return false;
    this.paused = true;
    this._pausedAt = Date.now();

    // The decoder stops on the next animation frame, so the canvas keeps showing
    // the last decoded picture - which is exactly the "hold" we want.
    try {
      this.jsmpeg?.pause();
    } catch {
      /* a player that never started has nothing to pause */
    }
    this._suppressAudioEvents = true;
    try {
      this.audioEl.pause();
    } catch {
      /* ignore */
    }
    this._suppressAudioEvents = false;

    this._stopDecodeWatch();
    this.setState(PLAYER_STATE.PAUSED);
    if (!silent) this._emit('player:paused', { at: this._pausedAt });
    return true;
  }

  /**
   * Resumes at the live edge.
   *
   * Not at the pause point, and that is deliberate. Neither transport can be
   * rewound, so "resume where I stopped" would mean playing back a backlog that
   * only grows: the viewer falls further behind with every second paused, the
   * server starts shedding data for them once their send queue fills, and the
   * A/V sync that the rest of this file works to maintain is thrown away. On a
   * live stream, resuming *to live* is the only behaviour that stays coherent.
   *
   * Both transports are therefore re-attached, which also puts them back on the
   * same live edge - so sync is re-established rather than merely hoped for.
   */
  resume() {
    if (this._stopped || !this.session || !this.paused) return false;
    const pausedForMs = Date.now() - this._pausedAt;
    // How far forward playback will actually move. This is not the same as the
    // pause duration: the held frame may already have been behind the live edge
    // when the viewer paused, and resuming to live closes that gap as well.
    // Reporting only the pause duration understates the jump.
    const jumpedMs = this.behindLiveMs() ?? pausedForMs;
    this.paused = false;
    this._pausedAt = 0;

    // Fresh playheads on both sides: the calibration constant is meaningless
    // again, exactly as after a reconnect.
    this.sync.noteDiscontinuity('resume');
    this._videoRetries = 0;
    this._audioRetries = 0;
    this.setState(PLAYER_STATE.BUFFERING, { via: 'resume' });
    if (this.hasVideo) this._startVideo();
    if (this.hasAudio) this._startAudio();
    this._startDecodeWatch();
    this._emit('player:resumed', { pausedForMs, jumpedMs });
    return true;
  }

  togglePause() {
    return this.paused ? this.resume() : this.pause();
  }

  /**
   * How far behind the live edge the held frame is, in ms.
   *
   * The server keeps publishing its MPEG-TS clock while paused, so the live
   * edge can be extrapolated from the last sample and compared with the frame
   * still on the canvas. `null` when there is nothing to compare - before the
   * first clock sample, or with no video.
   */
  behindLiveMs() {
    if (!this.paused) return 0;
    const s = this.sync;
    if (!s || s.serverPtsMs === null) return null;
    const live = s.serverPtsMs + (Date.now() - s.serverPtsAt);
    const frame = this.videoTimeMs();
    if (frame === null) return null;
    return Math.max(0, Math.round(live - frame));
  }

  stop({ keepState = false } = {}) {
    this._stopped = true;
    this.paused = false;
    this._pausedAt = 0;
    for (const timer of this._reconnectTimers) clearTimeout(timer);
    this._reconnectTimers.clear();
    this._clearDegradeTimer();
    this._teardownJsmpeg();
    this.sync.stop();
    this._stopDecodeWatch();
    try {
      this.audioEl.pause();
      this.audioEl.removeAttribute('src');
      this.audioEl.load();
    } catch {
      /* ignore */
    }
    this.session = null;
    this.firstFrameAt = 0;
    this.hasAudio = true;
    this.hasVideo = true;
    // Cleared here, not in markFinished(): this flag exists only to tell
    // _sessionFinished() apart from a dropped connection *within* one stream.
    // Leaving it set would make the video close handler and the audio 'ended'
    // handler suppress reconnection for every later stream in this tab.
    this._finished = false;
    if (!keepState) this.setState(PLAYER_STATE.IDLE);
  }

  /* -------------------------------------------------------------- helpers -- */
  _sessionFinished() {
    return this._finished === true;
  }

  markFinished() {
    this._finished = true;
  }

  _after(ms, fn) {
    if (ms <= 0) return queueMicrotask(fn);
    const timer = setTimeout(() => {
      this._reconnectTimers.delete(timer);
      fn();
    }, ms);
    this._reconnectTimers.add(timer);
    return timer;
  }

  /** Cancels a timer previously stored on `slot`, if there is one. */
  _cancelAfter(slot) {
    const timer = this[slot];
    if (timer === undefined || timer === null) return;
    clearTimeout(timer);
    this._reconnectTimers.delete(timer);
    this[slot] = null;
  }

  /**
   * Presentation time of the frame JSMpeg is currently showing, in ms.
   *
   * JSMpeg has no public clock, but the decoder tracks it: `currentTime` is the
   * frame's PTS and `startTime` is the PTS of the first frame this player saw,
   * so the difference is a 0-based, monotonic video playhead that can be put
   * directly on the same axis as `audio.currentTime`.
   */
  videoTimeMs() {
    try {
      const v = this.jsmpeg?.video;
      if (!v) return null;
      const current = v.currentTime;
      const start = v.startTime ?? 0;
      if (!Number.isFinite(current)) return null;
      return Math.max(0, (current - start) * 1000);
    } catch {
      return null;
    }
  }

  onServerClock(payload) {
    this.sync.onServerClock(payload);
  }

  setSyncEnabled(on) {
    this.sync.setEnabled(on);
  }

  /**
   * Turning autoplay on mid-session should start the audio that was deliberately
   * left paused, rather than only taking effect for the next stream.
   */
  setAutoplay(on) {
    this.autoplay = on !== false;
    if (this.autoplay && this.audioEl && this.audioEl.paused && this.session) {
      this.audioEl.play?.().catch(() => {
        /* still blocked by the browser; the blocked handler covers the UI */
      });
    }
  }
}
