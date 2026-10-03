import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordProbe,
  snapshot,
  degradationReason,
  inBundledImage,
  resetProbes,
} from '../src/lib/capabilities.js';

/**
 * The deploy this exists for: a Node service on a host such as Render, which
 * defaults to its *native* runtime and runs `npm start`. The image is never
 * built, so yt-dlp is not installed - yet the deploy reports success and the
 * page loads, and every YouTube URL fails at resolve time.
 *
 * "yt-dlp is not installed on this server (set YT_DLP_PATH)" is true there but
 * actively misleading: the operator already has a Dockerfile that installs
 * yt-dlp, and the real problem is that it is not the thing running. The
 * Dockerfile therefore sets CYBERSTREAM_IMAGE=1, and the app uses its absence
 * to name the actual cause.
 */
describe('runtime detection', () => {
  const original = process.env.CYBERSTREAM_IMAGE;

  afterEach(() => {
    if (original === undefined) delete process.env.CYBERSTREAM_IMAGE;
    else process.env.CYBERSTREAM_IMAGE = original;
  });

  test('only the bundled image sets the sentinel', () => {
    delete process.env.CYBERSTREAM_IMAGE;
    assert.equal(inBundledImage(), false, 'absent means not the image');
    process.env.CYBERSTREAM_IMAGE = '1';
    assert.equal(inBundledImage(), true);
    process.env.CYBERSTREAM_IMAGE = '0';
    assert.equal(inBundledImage(), false, 'only exactly "1" counts');
    process.env.CYBERSTREAM_IMAGE = 'true';
    assert.equal(inBundledImage(), false, 'a stray truthy value does not count');
  });
});

describe('degradation advice depends on the runtime', () => {
  const original = process.env.CYBERSTREAM_IMAGE;

  beforeEach(() => resetProbes());
  afterEach(() => {
    if (original === undefined) delete process.env.CYBERSTREAM_IMAGE;
    else process.env.CYBERSTREAM_IMAGE = original;
  });

  test('outside the image, it names the native-runtime mistake and the fix', () => {
    delete process.env.CYBERSTREAM_IMAGE;
    recordProbe('ffmpeg', { ok: true, version: '5.1.9' });
    recordProbe('ytDlp', { ok: false, error: '"yt-dlp" is not on PATH' });

    const reason = degradationReason();
    assert.match(reason, /yt-dlp is missing/);
    assert.match(reason, /native runtime/i, 'names the likely cause');
    assert.match(reason, /Dockerfile/i, 'and the thing to change');
    assert.match(reason, /direct media URLs still work/i, 'without hiding what does work');
  });

  test('inside the image, it does not tell them to deploy the image they are in', () => {
    process.env.CYBERSTREAM_IMAGE = '1';
    recordProbe('ffmpeg', { ok: true, version: '5.1.9' });
    recordProbe('ytDlp', { ok: false, error: 'no such file' });

    const reason = degradationReason();
    assert.match(reason, /yt-dlp is missing/);
    // Telling someone who is already running the image to deploy it is noise.
    assert.doesNotMatch(reason, /native runtime/i);
    assert.match(reason, /stale/i, 'the plausible cause here is a stale image or a wrong path');
  });

  test('a missing ffmpeg gets the same treatment', () => {
    delete process.env.CYBERSTREAM_IMAGE;
    recordProbe('ffmpeg', { ok: false, error: 'no such file' });
    assert.match(degradationReason(), /ffmpeg is not usable/);
    // The runtime hint is specific to the yt-dlp case; ffmpeg may legitimately
    // be pointed elsewhere.
    assert.doesNotMatch(degradationReason(), /native runtime/i);
  });

  test('the capabilities snapshot still reports the underlying state plainly', () => {
    delete process.env.CYBERSTREAM_IMAGE;
    recordProbe('ytDlp', { ok: false, error: '"yt-dlp" is not on PATH' });
    const caps = snapshot();
    // The API keeps machine-readable fields; the prose advice is separate.
    assert.equal(caps.canResolveYouTube, false);
    assert.equal(caps.ytDlp.ok, false);
    assert.equal(caps.degraded, true);
    assert.match(caps.ytDlp.error, /not on PATH/);
  });
});

describe('capabilities reporting', () => {
  const GOOD = { ok: true, version: '1.2.3' };
  const BAD = { ok: false, error: '"yt-dlp" is not on PATH' };

  beforeEach(() => resetProbes());

  test('starts unprobed, and unprobed is not ready', () => {
    const caps = snapshot();
    assert.equal(caps.ffmpeg.checked, false);
    // Readiness is a claim about capability, and nothing has been shown yet.
    assert.equal(caps.ready, false, 'an unprobed deployment cannot claim readiness');
    // Degraded means "something we checked is broken", which is not the same.
    assert.equal(caps.degraded, false, 'but it is not "degraded" before probing');
  });

  test('a healthy deployment is ready and reports no degradation', () => {
    recordProbe('ffmpeg', GOOD);
    recordProbe('ytDlp', GOOD);
    const caps = snapshot();
    assert.equal(caps.ready, true);
    assert.equal(caps.degraded, false);
    assert.equal(caps.canResolveYouTube, true);
    assert.equal(degradationReason(), null);
  });

  test('a missing yt-dlp degrades without claiming ffmpeg is broken', () => {
    recordProbe('ffmpeg', GOOD);
    recordProbe('ytDlp', BAD);
    const caps = snapshot();
    assert.equal(caps.ready, false);
    assert.equal(caps.degraded, true);
    assert.equal(caps.canResolveYouTube, false);
    assert.equal(caps.ffmpeg.ok, true, 'ffmpeg is fine and must be reported as such');
  });

  test('both missing are reported together', () => {
    recordProbe('ffmpeg', BAD);
    recordProbe('ytDlp', BAD);
    const reason = degradationReason();
    assert.match(reason, /ffmpeg is not usable/);
    assert.match(reason, /yt-dlp is missing/);
  });

  test('version and error are preserved for diagnosis', () => {
    recordProbe('ytDlp', BAD);
    assert.equal(snapshot().ytDlp.error, '"yt-dlp" is not on PATH');
    recordProbe('ytDlp', GOOD);
    assert.equal(snapshot().ytDlp.version, '1.2.3');
    assert.equal(snapshot().ytDlp.error, null, 'a good probe clears the stale error');
  });

  test('the snapshot cannot be mutated through the returned object', () => {
    recordProbe('ffmpeg', GOOD);
    const caps = snapshot();
    caps.ffmpeg.ok = false;
    assert.equal(snapshot().ffmpeg.ok, true, 'callers get a copy');
  });

  test('rejects an unknown probe name rather than silently ignoring it', () => {
    // A typo in a probe name would otherwise report a permanently unprobed
    // capability as healthy-looking silence.
    assert.throws(() => recordProbe('nope', GOOD), /unknown capability/);
  });
});