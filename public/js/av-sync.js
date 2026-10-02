/**
 * A/V synchronisation.
 *
 * The two halves arrive on independent transports, so nothing aligns them by
 * itself:
 *
 *   video - MPEG-TS over a WebSocket into JSMpeg, which exposes no public clock
 *           but does track the timestamp of the frame it is displaying
 *   audio - MP3 over HTTP into an <audio> element, which has currentTime
 *
 * The fix is to compare *playhead against playhead* and correct the *change*:
 *
 *   drift = audioPlayhead - videoPlayhead - offset
 *
 * `offset` is a single calibration constant, estimated once and then held, and
 * holding it is not a workaround - it is the whole point. The two playheads do
 * not share a zero: `audio.currentTime` counts from the first MP3 byte that
 * particular element received, and the video playhead counts from when JSMpeg
 * attached, so their *difference* is an arbitrary constant that says nothing
 * about lip sync. Only how that difference *changes* is observable, and only
 * that needs correcting.
 *
 * The absolute alignment is therefore established upstream, not here. The
 * server runs a single FFmpeg process whose two outputs come off one decode of
 * one input (see src/lib/ffmpeg.js), so the audio and video live edges are the
 * same instant by construction. This controller's remaining job is to stop the
 * two consumers from running at different speeds.
 *
 * Once calibrated:
 *   |drift| < 60ms  -> do nothing (inaudible)
 *   >= 60ms         -> nudge audio.playbackRate by a couple of percent
 *
 * Correcting the *audio* rate is the right lever: video is already decoding at
 * a fixed rate, and browsers honour small playbackRate changes cleanly.
 *
 * A genuine discontinuity - a reconnect, a stall, a transport restart - moves
 * the playheads to unrelated positions and invalidates the calibration. The
 * player reports those through `noteDiscontinuity()`; re-baselining is done
 * there and only there, because doing it whenever the drift looks large just
 * hides the very error it is supposed to react to.
 *
 * The server's MPEG-TS clock (see src/lib/ts-clock.js) is used for a different
 * job: confirming the video stream itself is advancing, so a stalled decoder is
 * reported as stalled rather than silently "in sync" with silence.
 */

const SOFT_LIMIT_MS = 60;
const MAX_RATE = 1.06;
const MIN_RATE = 0.94;
const RESET_RATE = 0.02; // per correction step
const CORRECTION_INTERVAL_MS = 1500;
/** Samples before the controller starts acting. */
const CALIBRATION_SAMPLES = 3;
/**
 * Seconds of audio that must be buffered before the controller will speed the
 * element up. Below this the buffer is the binding constraint, not the drift.
 */
const BUFFER_FLOOR_SEC = 2;

export class AvSync {
  /**
   * @param {object} o
   * @param {() => HTMLAudioElement} o.getAudio
   * @param {() => number|null} o.getVideoTimeMs  playhead of the displayed frame
   * @param {() => number|null} [o.getServerPtsMs] newest PTS from the server
   * @param {boolean} [o.enabled]
   * @param {() => number} [o.getBufferedAheadSec] audio buffered ahead of the playhead
   */
  constructor({
    getAudio,
    getVideoTimeMs,
    getServerPtsMs = () => null,
    getBufferedAheadSec = () => Infinity,
    enabled = true,
  }) {
    this.getAudio = getAudio;
    this.getVideoTimeMs = getVideoTimeMs;
    this.getServerPtsMs = getServerPtsMs;
    this.getBufferedAheadSec = getBufferedAheadSec;
    this.enabled = enabled;

    /**
     * Calibration constant: the playhead difference that existed once both
     * transports were running. Arbitrary by nature - see the file header - and
     * only ever moved by noteDiscontinuity().
     */
    this.offset = null;
    this.samples = 0;
    /** Smoothed video playhead, in ms. */
    this.videoMs = null;
    /** Lightly filtered playhead difference, to reject per-tick jitter. */
    this.smoothed = null;

    this.driftMs = 0;
    /** Raw (unfiltered) playhead difference, for diagnostics. */
    this.diffMs = 0;
    this.rate = 1;
    this.corrections = 0;
    this.discontinuities = 0;
    /** True when the buffer, not the drift, is limiting the correction. */
    this.bufferLimited = false;
    this.lastDiscontinuity = null;
    this.lastCorrectionAt = 0;

    this.serverPtsMs = null;
    this.serverPtsAt = 0;
    this.videoStalled = false;

    this._timer = null;
  }

  start() {
    this.stop();
    this._timer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.rate = 1;
    this.offset = null;
    this.smoothed = null;
    this.samples = 0;
    this.videoMs = null;
    this.driftMs = 0;
    this.serverPtsMs = null;
    this.videoStalled = false;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      const audio = this.getAudio?.();
      if (audio) audio.playbackRate = 1;
      this.rate = 1;
    }
  }

  /** Fed by the control channel (`session:clock`). */
  onServerClock({ ptsMs, at }) {
    if (typeof ptsMs !== 'number' || !Number.isFinite(ptsMs)) return;
    this.serverPtsMs = ptsMs;
    this.serverPtsAt = at ?? Date.now();
  }

  tick() {
    const audio = this.getAudio?.();
    if (!audio || !this.enabled) return;
    if (audio.paused || audio.readyState < 2) return;

    const videoMs = this.getVideoTimeMs?.() ?? null;
    if (videoMs === null) return;

    this._checkVideoAdvancing();
    this.samples += 1;

    // JSMpeg decodes in bursts whenever the socket hands it a batch of packets,
    // so the raw video playhead sawtooths by a frame or two per burst. Light
    // smoothing keeps the controller from chasing that sawtooth.
    this.videoMs =
      this.videoMs === null ? videoMs : this.videoMs + (videoMs - this.videoMs) * 0.4;

    const measured = audio.currentTime * 1000 - this.videoMs;

    // Calibrate once, then hold. The raw difference carries an arbitrary
    // constant (the two playheads do not share a zero - see the note at the top
    // of this file), so it is the *departure* from that constant that is the
    // sync error, and that is what gets corrected.
    //
    // A slow filter is applied to the raw reading only to reject the per-tick
    // jitter of JSMpeg's burst decoding; the baseline itself stays put.
    if (this.offset === null) {
      this.offset = measured;
      this.smoothed = measured;
    } else {
      this.smoothed += (measured - this.smoothed) * 0.35;
    }
    this.diffMs = measured;
    this.driftMs = this.smoothed - this.offset;
    if (this.samples < CALIBRATION_SAMPLES) return;

    if (Math.abs(this.driftMs) < SOFT_LIMIT_MS) {
      this._setRate(1);
      return;
    }

    if (Date.now() - this.lastCorrectionAt < CORRECTION_INTERVAL_MS) return;
    this.lastCorrectionAt = Date.now();

    // Never ask the element to consume faster than it can be fed.
    //
    // The audio element refills at exactly 1x, so raising playbackRate draws
    // down a buffer that only refills at 1x. Doing that to a thin buffer starves
    // the element, and a starved element falls further behind - which is the
    // very error the correction was trying to remove. It is a positive feedback
    // loop, and it ends with the audio permanently stalled.
    //
    // So: below the cushion, back off towards 1x (or below) and let the buffer
    // recover. Only once there is a real cushion is it safe to spend it.
    const ahead = this.getBufferedAheadSec?.() ?? Infinity;
    if (ahead < BUFFER_FLOOR_SEC) {
      this._setRate(clamp(this.rate < 1 ? this.rate + RESET_RATE : 1, MIN_RATE, MAX_RATE));
      this.bufferLimited = true;
      return;
    }
    this.bufferLimited = false;

    // Positive drift: the audio playhead is running ahead of the video's, so
    // slow the audio down. (The sign was inverted originally, which drove the
    // rate into both clamps while making the error worse.)
    const step = -Math.sign(this.driftMs) * RESET_RATE;
    this._setRate(clamp(this.rate + step, MIN_RATE, MAX_RATE));
    this.corrections += 1;
  }

  /**
   * Re-baselines after something moved a playhead discontinuously - a
   * reconnect, a stall, a transport restart.
   *
   * This is the only thing that should ever move `offset`. Doing it
   * automatically whenever the drift looks large would silently absorb the very
   * error the controller exists to report.
   */
  noteDiscontinuity(reason = 'discontinuity') {
    if (this.offset === null) return;
    this.offset = this.smoothed;
    this.driftMs = 0;
    this._setRate(1);
    this.discontinuities += 1;
    this.lastDiscontinuity = reason;
  }

  /**
   * The video decoder can stall while the audio keeps playing. The server's
   * PTS clock tells us whether the *stream* is still advancing, so a frozen
   * decoder is reported instead of being mistaken for drift.
   */
  _checkVideoAdvancing() {
    if (this.serverPtsMs === null) return;
    const age = Date.now() - this.serverPtsAt;
    this.videoStalled = age > 2500;
  }

  _setRate(rate) {
    const audio = this.getAudio?.();
    this.rate = rate;
    if (audio && Math.abs(audio.playbackRate - rate) > 0.001) {
      // `preservesPitch` keeps voices natural while the rate is nudged.
      if ('preservesPitch' in audio) audio.preservesPitch = true;
      if ('mozPreservesPitch' in audio) audio.mozPreservesPitch = true;
      audio.playbackRate = rate;
    }
  }

  /** Manual resync: treat the current difference as the new baseline. */
  hardResync() {
    const audio = this.getAudio?.();
    const videoMs = this.getVideoTimeMs?.() ?? null;
    if (!audio || videoMs === null) return false;
    this.videoMs = videoMs;
    this.smoothed = audio.currentTime * 1000 - videoMs;
    this.offset = this.smoothed;
    this.diffMs = this.offset;
    this.samples = CALIBRATION_SAMPLES;
    this.driftMs = 0;
    this._setRate(1);
    return true;
  }

  snapshot() {
    return {
      driftMs: Math.round(this.driftMs),
      diffMs: Math.round(this.diffMs),
      rate: Number(this.rate.toFixed(3)),
      corrections: this.corrections,
      bufferLimited: this.bufferLimited,
      discontinuities: this.discontinuities,
      lastDiscontinuity: this.lastDiscontinuity,
      locked: this.offset !== null,
      calibrated: this.samples >= CALIBRATION_SAMPLES,
      videoStalled: this.videoStalled,
    };
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
