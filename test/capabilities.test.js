import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordProbe,
  snapshot,
  canResolveYouTube,
  degradationReason,
  resetProbes,
} from '../src/lib/capabilities.js';

/**
 * The boot probes used to be logged and discarded, so a missing dependency was
 * only visible by reading logs. A deployment then reported itself healthy while
 * every YouTube URL failed - the server was "live" in the sense that it answered
 * /api/health, and useless in the sense the user cares about.
 *
 * These hold the reported state honest, and pin the liveness/readiness split:
 * a monitor must not restart-loop a degraded build, because restarting cannot
 * install anything.
 */
const GOOD = { ok: true, version: '1.2.3' };
const BAD = { ok: false, error: '"yt-dlp" is not on PATH' };

describe('capabilities', () => {
  beforeEach(() => resetProbes());

  test('starts unprobed, and unprobed is not ready', () => {
    const caps = snapshot();
    assert.equal(caps.ffmpeg.checked, false);
    assert.equal(caps.ready, false, 'an unprobed deployment cannot claim readiness');
    assert.equal(caps.degraded, false, 'but it is not "degraded" before probing');
    assert.equal(canResolveYouTube(), false);
  });

  test('a healthy deployment is ready', () => {
    recordProbe('ffmpeg', GOOD);
    recordProbe('ytDlp', GOOD);
    const caps = snapshot();
    assert.equal(caps.ready, true);
    assert.equal(caps.degraded, false);
    assert.equal(caps.canResolveYouTube, true);
    assert.equal(degradationReason(), null);
  });

  test('a missing yt-dlp degrades without claiming ffmpeg is broken', () => {
    // The exact deployment from the bug report.
    recordProbe('ffmpeg', GOOD);
    recordProbe('ytDlp', BAD);
    const caps = snapshot();
    assert.equal(caps.ready, false);
    assert.equal(caps.degraded, true);
    assert.equal(caps.canResolveYouTube, false);
    assert.equal(caps.ffmpeg.ok, true, 'ffmpeg is fine and must be reported as such');
    assert.match(degradationReason(), /yt-dlp is missing/);
    assert.match(degradationReason(), /direct media URLs still work/, 'says what still works');
  });

  test('a missing ffmpeg is reported separately and more severely', () => {
    recordProbe('ffmpeg', { ok: false, error: 'no such file' });
    recordProbe('ytDlp', GOOD);
    const caps = snapshot();
    assert.equal(caps.ready, false);
    assert.match(degradationReason(), /ffmpeg is not usable/);
    assert.doesNotMatch(degradationReason(), /yt-dlp is missing/);
  });

  test('both missing are reported together', () => {
    recordProbe('ffmpeg', BAD);
    recordProbe('ytDlp', BAD);
    const reason = degradationReason();
    assert.match(reason, /ffmpeg is not usable/);
    assert.match(reason, /yt-dlp is missing/);
  });

  test('version and error are preserved for diagnosis', () => {
    recordProbe('ytDlp', { ok: false, error: '"yt-dlp" is not on PATH' });
    assert.equal(snapshot().ytDlp.error, '"yt-dlp" is not on PATH');
    recordProbe('ytDlp', GOOD);
    assert.equal(snapshot().ytDlp.version, '1.2.3');
    assert.equal(snapshot().ytDlp.error, null);
  });

  test('the snapshot cannot be mutated through the returned object', () => {
    recordProbe('ffmpeg', GOOD);
    const caps = snapshot();
    caps.ffmpeg.ok = false;
    assert.equal(snapshot().ffmpeg.ok, true, 'callers get a copy');
  });

  test('rejects an unknown probe name rather than silently ignoring it', () => {
    assert.throws(() => recordProbe('nope', GOOD), /unknown capability/);
  });
});