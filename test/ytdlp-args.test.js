import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildYtDlpArgs, looksLikeIpBlock, translateError } from '../src/lib/resolver.js';
import { config } from '../src/config/index.js';

/**
 * The failure these cover: a service on a datacenter IP - Render, or any cloud
 * host - is refused by YouTube's anonymous player clients. The video is fine and
 * plays in a browser; the deploy succeeds; the dashboard loads; and every
 * YouTube URL fails with an error that used to blame the user's link.
 */

const SOURCE = { kind: 'youtube', videoId: 'aqz-KE-bpKQ', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' };

describe('recognising a blocked server', () => {
  it('treats a missing player response as an IP block, not a bad video', () => {
    // This is the exact stderr from the Render deploy.
    const stderr = 'ERROR: [youtube] aqz-KE-bpKQ: Failed to extract any player response; '
      + 'please report this issue on https://github.com/yt-dlp/yt-dlp, '
      + 'filling out the appropriate issue template.';
    assert.equal(looksLikeIpBlock(stderr), true);
  });

  it('recognises the other shapes of the same refusal', () => {
    for (const text of [
      'The page needs to be reloaded.',
      'Unable to extract player response',
      'Sign in to confirm you\'re not a bot',
      'This video is unavailable. PO Token is required',
    ]) {
      assert.equal(looksLikeIpBlock(text), true, text);
    }
  });

  it('does not claim an IP block for failures that are about the video', () => {
    // Retrying a private video on every player client would be pure latency,
    // so these must not trigger the fallback chain.
    for (const text of [
      'ERROR: [youtube] x: Private video. Sign in if you\'ve been granted access',
      'ERROR: [youtube] x: Video unavailable',
      'ERROR: [youtube] x: This video is not available in your country',
      'ERROR: [youtube] x: HTTP Error 429: Too Many Requests',
    ]) {
      assert.equal(looksLikeIpBlock(text), false, text);
    }
  });
});

describe('yt-dlp arguments', () => {
  it('no longer passes the deprecated --no-call-home', () => {
    // It is deprecated, and yt-dlp answered it with a four-line banner on every
    // resolve, which buried the real error on the failures that needed reading.
    const args = buildYtDlpArgs(SOURCE, null);
    assert.equal(args.includes('--no-call-home'), false);
  });

  it('passes no player client by default, leaving yt-dlp its own choice', () => {
    const args = buildYtDlpArgs(SOURCE, null);
    assert.equal(args.some((a) => a.startsWith('youtube:player_client')), false);
  });

  it('pins a player client when one is given for a retry', () => {
    const args = buildYtDlpArgs(SOURCE, 'tv');
    const i = args.indexOf('--extractor-args');
    assert.ok(i >= 0, 'has --extractor-args');
    assert.equal(args[i + 1], 'youtube:player_client=tv');
  });

  it('keeps the URL last so it cannot be read as an option', () => {
    assert.equal(buildYtDlpArgs(SOURCE, 'tv').at(-1), SOURCE.url);
    // The `--` separator is what makes that true for a value starting with "-".
    const i = buildYtDlpArgs(SOURCE, null).indexOf('--');
    assert.ok(i >= 0 && i === buildYtDlpArgs(SOURCE, null).length - 2);
  });

  it('always asks for metadata only, never a download', () => {
    const args = buildYtDlpArgs(SOURCE, null);
    assert.ok(args.includes('--no-download'));
    assert.ok(args.includes('--dump-single-json'));
    // A "play it now" request must not wait for the whole file.
    assert.equal(args.some((a) => a === '-o' || a === '-f'), false);
  });

  it('passes cookies only when an operator configured some', () => {
    assert.equal(buildYtDlpArgs(SOURCE, null).includes('--cookies'), false,
      'no --cookies without a configured file');
    assert.equal(typeof config.youtube.cookies, 'string');
  });
});

describe('the message the user actually sees', () => {
  it('does not blame the video when YouTube blocked the server', () => {
    const err = translateError('ERROR: [youtube] aqz-KE-bpKQ: Failed to extract any player response;'
      + ' please report this issue on https://github.com/yt-dlp/yt-dlp,'
      + ' filling out the appropriate issue template.');
    // The old text was "It may be region locked, private or unsupported", which
    // sends people hunting for a fault in a link that is perfectly fine.
    assert.doesNotMatch(err.message, /region locked, private or unsupported/);
    assert.match(err.message, /refusing this server, not the video/);
    assert.match(err.message, /datacenter IP/i);
    // Actionable: both remedies are named.
    assert.match(err.message, /YT_DLP_CLIENTS/);
    assert.match(err.message, /YT_DLP_COOKIES/);
    assert.equal(err.code, 'YOUTUBE_BLOCKED_SERVER');
    assert.equal(err.statusCode, 503, 'a server problem, not the user sending a bad request');
  });

  it('still names genuinely per-video problems specifically', () => {
    assert.match(translateError('ERROR: [youtube] x: Private video').message, /private/i);
    assert.match(
      translateError('ERROR: [youtube] x: Video unavailable. This video has been removed').message,
      /unavailable or has been removed/i,
    );
    assert.match(
      translateError('ERROR: [youtube] x: HTTP Error 429: Too Many Requests').message,
      /rate-limiting/i,
    );
  });
});
