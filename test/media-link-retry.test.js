import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Transcoder, buildFfmpegArgs } from '../src/lib/ffmpeg.js';

/**
 * A googlevideo media URL is not a permanent address. It carries the fetching
 * address in `ip`/`ipb` and a signature over it, so it is only valid to the
 * client it was issued to. Resolve and fetch are separate connections, and a
 * host whose egress address is not stable - a NAT pool, a proxy, a redeployed
 * instance behind a shared address - hands them different addresses, and the
 * link is then valid for nobody. FFmpeg reports that as a 403 while "opening
 * input", which used to end the session.
 *
 * The fix is to resolve again from the same process, getting a link signed for
 * the address this connection will use.
 */

const SIGNED_URL = 'https://rr9---sn-8xgp1vo-cvnd.googlevideo.com/videoplayback?ip=203.0.113.7&expire=1790996801&sig=abc';

const F403 = [
  '[ffmpeg: s @ 000001f8bfa43e00] HTTP error 403 Forbidden',
  '[in#0 @ 000001f8bfa2cc00] Error opening input: Server returned 403 Forbidden (access denied)',
  `Error opening input file ${SIGNED_URL}`,
  'Error opening input files: Server returned 403 Forbidden (access denied)',
];

function transcoderWithTail(tail, extra = {}) {
  const t = new Transcoder({
    sources: { muxed: true, video: { url: SIGNED_URL, headers: {} } },
    ...extra,
  });
  t.stderrTail = tail;
  return t;
}

describe('a rejected media link is recognised as retryable', () => {
  it('asks for a fresh resolve rather than another output strategy', () => {
    const err = transcoderWithTail(F403).fatalFromStderr(1, null);
    // No output strategy can fix a URL signed for a different address, so this
    // must not be spent cycling through dual-file/multi-pipe/dual-stdout.
    assert.equal(err.retryWithFreshSource, true);
  });

  it('says what happened instead of reporting a generic rejection', () => {
    const err = transcoderWithTail(F403).fatalFromStderr(1, null);
    assert.match(err.message, /rejected the media link/i);
    assert.match(err.message, /403/);
    // The old text blamed the source, which sent people hunting for a bad URL.
    assert.doesNotMatch(err.message, /ffmpeg rejected the source/);
  });

  it('never echoes the signed URL, which is a working credential', () => {
    const err = transcoderWithTail(F403).fatalFromStderr(1, null);
    // The URL carries the fetching IP and a signature; it reaches the browser.
    assert.doesNotMatch(err.message, /203\.0\.113\.7/);
    assert.doesNotMatch(err.message, /sig=abc/);
  });

  it('does not treat an output-side 403 as a media link problem', () => {
    const t = transcoderWithTail(['Error opening output: Permission denied', 'HTTP error 403 Forbidden']);
    assert.equal(t.fatalFromStderr(1, null).retryWithFreshSource, false,
      'a 403 while writing is a different fault entirely');
  });

  it('leaves an ordinary unplayable source alone', () => {
    const t = transcoderWithTail([
      '[in#0] Error opening input: Invalid data found when processing input',
    ]);
    const err = t.fatalFromStderr(1, null);
    assert.equal(err.retryWithFreshSource, false);
    assert.equal(err.retryWithOtherStrategy, false, 'retrying the same dead URL cannot help');
  });

  it('is not enabled by default, so a caller without a refresh callback cannot loop', () => {
    const t = transcoderWithTail(F403);
    assert.equal(t.refreshSources, null);
  });
});

describe('the fresh link is actually used', () => {
  it('re-resolves once and restarts, instead of failing the session', async () => {
    const FRESH = 'https://rr9---sn-other.googlevideo.com/videoplayback?ip=198.51.100.9&sig=new';
    let refreshes = 0;
    const t = transcoderWithTail(F403, {
      refreshSources: async () => {
        refreshes += 1;
        return { muxed: true, video: { url: FRESH, headers: {} } };
      },
    });

    const attempts = [];
    // First attempt fails the way FFmpeg fails when the signed link is refused;
    // the second succeeds.
    t.tryStrategy = async (strategy) => {
      attempts.push(strategy);
      if (attempts.length === 1) throw t.fatalFromStderr(1, null);
    };

    const result = await t.start();

    assert.equal(refreshes, 1, 'exactly one fresh resolve');
    assert.equal(attempts.length, 2, 'and exactly one restart');
    assert.ok(result, 'the session started instead of failing');
    assert.ok(t.args.includes(FRESH), 'the retry used the new link');
    assert.equal(t.args.includes(SIGNED_URL), false, 'and not the refused one');
  });

  it('gives up rather than re-resolving forever', async () => {
    // A link refused again *after* being signed for this connection will be
    // refused again; an unbounded retry turns a dead video into a hot loop.
    let refreshes = 0;
    const t = transcoderWithTail(F403, {
      refreshSources: async () => {
        refreshes += 1;
        return { muxed: true, video: { url: 'https://x/again.mp4', headers: {} } };
      },
    });
    let attempts = 0;
    t.tryStrategy = async () => {
      attempts += 1;
      throw t.fatalFromStderr(1, null);
    };

    await assert.rejects(() => t.start());
    assert.equal(refreshes, 1, 'one refresh, not one per attempt');
    assert.ok(attempts <= 2, `bounded attempts, saw ${attempts}`);
  });

  it('surfaces the original failure if the re-resolve itself fails', async () => {
    const t = transcoderWithTail(F403, {
      refreshSources: async () => {
        throw new Error('yt-dlp is down');
      },
    });
    t.tryStrategy = async () => {
      throw t.fatalFromStderr(1, null);
    };
    await assert.rejects(() => t.start(), /rejected the media link/i,
      'reports why the video failed, not the failed repair');
  });

  it('rebuilds the argv, so the retry does not re-fetch the dead URL', async () => {
    // Without this the retry would replay the first failure verbatim.
    const FRESH = 'https://rr9---sn-other.googlevideo.com/videoplayback?ip=198.51.100.9&sig=new';
    const t = transcoderWithTail(F403, {
      refreshSources: async () => ({ muxed: true, video: { url: FRESH, headers: {} } }),
    });
    const before = t.args;
    t.sources = { muxed: true, video: { url: FRESH, headers: {} } };
    t.opts = { sources: t.sources, durationMs: t.durationMs, video: t.video };
    t.args = buildFfmpegArgs(t.opts);

    assert.notEqual(t.args, before);
    assert.ok(t.args.includes(FRESH), 'the new URL reached the argv');
    assert.equal(t.args.includes(SIGNED_URL), false, 'the refused URL is gone');
  });
});
