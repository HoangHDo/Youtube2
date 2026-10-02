import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pause/resume on a live stream has one non-obvious property, and it is the
 * reason this is tested separately: **the two transports must never diverge**.
 *
 * The `<audio controls>` element ships its own play/pause button. Before this
 * work, pressing it paused only the audio while the video kept running - the
 * exact desync the rest of the player works to prevent, reachable from a control
 * the user is expected to use. So the native control is treated as a request for
 * the whole player, and these tests pin that down.
 *
 * A headless browser cannot exercise the UI part: JSMpeg decodes one frame per
 * requestAnimationFrame and a headless page fires rAF zero times per second, so
 * the picture never advances. The state machine is therefore mirrored here, and
 * the source is asserted for the wiring that cannot be unit-tested.
 */
const root = join(import.meta.dirname, '..');

const PLAYER_STATE = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  BUFFERING: 'buffering',
  PLAYING: 'playing',
  PAUSED: 'paused',
  DEGRADED: 'degraded',
  ENDED: 'ended',
  ERROR: 'error',
};

const ALLOWED_WHILE_PAUSED = new Set([
  PLAYER_STATE.PAUSED,
  PLAYER_STATE.IDLE,
  PLAYER_STATE.ERROR,
  PLAYER_STATE.ENDED,
]);

/** Mirrors setState() in player.js. */
function setState(self, state) {
  if (self.state === state) return;
  if (self.paused && !ALLOWED_WHILE_PAUSED.has(state)) {
    const held = state === PLAYER_STATE.PLAYING ? PLAYER_STATE.PAUSED : state;
    if (self.state === held) return;
    self.state = held;
    self.emitted.push({ state: held, held: true });
    return;
  }
  self.state = state;
  self.emitted.push({ state });
}

function makePlayer() {
  return {
    state: PLAYER_STATE.IDLE,
    paused: false,
    emitted: [],
    jsmpegPaused: 0,
    audioPaused: 0,
    retries: 0,
    watchStarts: 0,
    watchStops: 0,
  };
}

const pause = (p) => {
  if (p.paused) return false;
  p.paused = true;
  p.jsmpegPaused += 1;
  p.audioPaused += 1;
  p.watchStops += 1;
  setState(p, PLAYER_STATE.PAUSED);
  return true;
};

const resume = (p) => {
  if (!p.paused) return false;
  p.paused = false;
  p.retries += 1;
  p.watchStarts += 1;
  setState(p, PLAYER_STATE.BUFFERING);
  return true;
};

describe('pause state machine', () => {
  test('pause holds the frame and silences audio together', () => {
    const p = makePlayer();
    p.state = PLAYER_STATE.PLAYING;
    assert.equal(pause(p), true);
    assert.equal(p.state, PLAYER_STATE.PAUSED);
    // The whole point: both transports move in one step.
    assert.equal(p.jsmpegPaused, 1, 'the decoder must stop');
    assert.equal(p.audioPaused, 1, 'the audio must stop');
  });

  test('pause is idempotent', () => {
    const p = makePlayer();
    pause(p);
    assert.equal(pause(p), false, 'a second pause is a no-op');
    assert.equal(p.jsmpegPaused, 1);
    assert.equal(p.audioPaused, 1);
  });

  test('resume rejoins the live edge and re-arms the watchdog', () => {
    const p = makePlayer();
    pause(p);
    assert.equal(resume(p), true);
    assert.equal(p.paused, false);
    // Re-attaching both transports is what puts them back on the same edge.
    assert.equal(p.retries, 1);
    assert.equal(p.watchStarts, 1, 'the decode watchdog must restart');
  });

  test('resume without pause is a no-op', () => {
    const p = makePlayer();
    assert.equal(resume(p), false);
    assert.equal(p.retries, 0);
  });

  test('a reconnect finishing cannot silently un-pause the viewer', () => {
    // The video socket going quiet while paused is expected, and several events
    // can fire afterwards. If any of them reported PLAYING, the UI would claim
    // to be playing while the picture is still frozen.
    const p = makePlayer();
    p.state = PLAYER_STATE.PLAYING;
    pause(p);
    setState(p, PLAYER_STATE.PLAYING);
    assert.equal(p.state, PLAYER_STATE.PAUSED, 'still paused');

    // From a *different* held state, the event is emitted and flagged, so a
    // consumer can tell "held" from a genuine transition.
    const q = makePlayer();
    q.paused = true;
    q.state = PLAYER_STATE.BUFFERING;
    q.emitted = [];
    setState(q, PLAYER_STATE.PLAYING);
    assert.equal(q.state, PLAYER_STATE.PAUSED);
    assert.equal(q.emitted.at(-1).held, true, 'the event says it was held');
  });

  test('buffering and degraded are also held out of PAUSED', () => {
    for (const s of [PLAYER_STATE.BUFFERING, PLAYER_STATE.DEGRADED, PLAYER_STATE.CONNECTING]) {
      const p = makePlayer();
      pause(p);
      setState(p, s);
      // These are not PLAYING, so they are reported as-is: a viewer should still
      // learn that a transport is unhealthy while paused.
      assert.equal(p.state, s, `${s} should surface while paused`);
    }
  });

  test('terminal states still win over a pause', () => {
    for (const s of [PLAYER_STATE.ERROR, PLAYER_STATE.ENDED, PLAYER_STATE.IDLE]) {
      const p = makePlayer();
      pause(p);
      setState(p, s);
      assert.equal(p.state, s, `${s} must not be masked by the pause`);
    }
  });

  test('a redundant state change emits nothing', () => {
    const p = makePlayer();
    p.state = PLAYER_STATE.PLAYING;
    setState(p, PLAYER_STATE.PLAYING);
    assert.equal(p.emitted.length, 0);
  });
});

describe('native audio controls stay in lockstep', () => {
  const playerSource = readFileSync(join(root, 'public', 'js', 'player.js'), 'utf8');

  /**
   * Returns the source between two markers. Regex-matching a whole handler body
   * is brittle - the terminator is `});`, not `)});` - so slice deterministically
   * from the handler's own opening to the next listener registration.
   */
  const section = (from, to = "el.addEventListener(") => {
    const start = playerSource.indexOf(from);
    assert.notEqual(start, -1, `marker not found: ${from}`);
    const end = playerSource.indexOf(to, start + from.length);
    return playerSource.slice(start, end === -1 ? start + 900 : end);
  };

  test('pausing the audio element pauses the whole player', () => {
    // Without this, the native pause button freezes the sound and leaves the
    // picture running - reachable from a control the user is meant to use.
    const handler = section("el.addEventListener('pause'");
    assert.match(
      handler,
      /if\s*\(this\._suppressAudioEvents\s*\|\|\s*this\.paused\)\s*return;/,
      'ignores its own programmatic pause',
    );
    assert.match(handler, /this\.pause\(\{ silent: true \}\)/, 'pauses the player');
  });

  test('playing the audio element resumes the whole player', () => {
    const handler = section("el.addEventListener('play'");
    assert.match(handler, /if\s*\(this\._suppressAudioEvents\)\s*return;/);
    assert.match(handler, /if\s*\(this\.paused\)\s*this\.resume\(\);/, 'resumes the player');
  });

  test('the reconnect paths do not fire while paused', () => {
    // A paused decoder makes the server shed data, so a dropped socket is
    // expected. Reconnecting would rejoin the live edge and resume playback
    // without being asked.
    for (const fn of ['_scheduleVideoRetry', '_scheduleAudioRetry']) {
      const start = playerSource.indexOf(`  ${fn}() {`);
      assert.notEqual(start, -1, `found ${fn}`);
      // Wide enough to clear the explanatory comment that precedes the guard.
      const body = playerSource.slice(start, start + 460);
      assert.match(body, /if\s*\(this\.paused\)\s*return;/, `${fn} must bail out when paused`);
    }
  });

  test('the decode watchdog ignores a paused player', () => {
    const start = playerSource.indexOf('  _isPlaybackActive() {');
    assert.notEqual(start, -1, 'found _isPlaybackActive');
    const body = playerSource.slice(start, start + 260);
    assert.match(
      body,
      /if\s*\(this\._stopped\s*\|\|\s*!this\.jsmpeg\s*\|\|\s*this\.paused\)\s*return false;/,
    );
  });

  test('pause resets the calibration baseline on resume', () => {
    // Both playheads jump on resume, so the A/V calibration must be re-based -
    // otherwise the first samples after resuming look like an enormous drift.
    const start = playerSource.indexOf('  resume() {');
    assert.notEqual(start, -1, 'found resume()');
    const body = playerSource.slice(start, start + 900);
    assert.match(body, /this\.sync\.noteDiscontinuity\('resume'\)/);
  });

  test('resume reports the jump, not just how long the button was held', () => {
    // A frame that was already behind live before the pause is caught up on
    // resume too, so the pause duration understates how far the picture moves.
    // The figure the toast shows has to be the one a viewer would measure.
    const start = playerSource.indexOf('  resume() {');
    const body = playerSource.slice(start, start + 900);
    assert.match(body, /this\.behindLiveMs\(\)\s*\?\?\s*pausedForMs/, 'measures the real jump');
    assert.match(body, /jumpedMs/, 'and passes it to the event');

    // The UI must use the jump, not the pause duration.
    const main = readFileSync(join(root, 'public', 'js', 'main.js'), 'utf8');
    const at = main.indexOf("'player:resumed'");
    assert.notEqual(at, -1, 'found the resume listener');
    const handler = main.slice(at, at + 600);
    assert.match(handler, /ev\.detail\.jumpedMs/, 'the toast uses jumpedMs');
    assert.doesNotMatch(handler, /pausedForMs/, 'and not the pause duration');
  });

  test('stop clears the paused flag', () => {
    const start = playerSource.indexOf('  stop({ keepState = false } = {}) {');
    assert.notEqual(start, -1, 'found stop()');
    const body = playerSource.slice(start, start + 320);
    assert.match(body, /this\.paused = false;/, 'a stopped player is not paused');
  });

  test('starting a new session clears the paused flag', () => {
    const start = playerSource.indexOf('  start(session) {');
    assert.notEqual(start, -1, 'found start()');
    const body = playerSource.slice(start, start + 400);
    assert.match(body, /this\.paused = false;/);
  });
});

describe('behind-live reporting', () => {
  test('is zero when playing, null when there is nothing to compare', () => {
    // Mirrors behindLiveMs(): only meaningful while paused, and only once a
    // server clock sample and a decoded frame both exist.
    const behindLiveMs = (paused, serverPtsMs, frame) => {
      if (!paused) return 0;
      if (serverPtsMs === null) return null;
      if (frame === null) return null;
      return Math.max(0, Math.round(serverPtsMs - frame));
    };
    assert.equal(behindLiveMs(false, 5000, 1000), 0);
    assert.equal(behindLiveMs(true, null, 1000), null);
    assert.equal(behindLiveMs(true, 5000, null), null);
    assert.equal(behindLiveMs(true, 5000, 1000), 4000);
    // Never negative, even if a clock sample arrives slightly behind the frame.
    assert.equal(behindLiveMs(true, 1000, 5000), 0);
  });
});
