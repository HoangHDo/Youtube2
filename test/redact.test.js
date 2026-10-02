import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { redactUrls } from '../src/lib/redact.js';

/**
 * FFmpeg and yt-dlp both echo the URL they were handed when an input fails. For
 * a resolved YouTube stream that URL is a signed media link carrying the
 * fetching machine's IP, an expiry and a signature, and these strings end up in
 * an error message rendered into the page and in the log file. So the scrubbing
 * is a security control, not cosmetics.
 */
describe('redactUrls', () => {
  test('removes a signed googlevideo URL but keeps the host', () => {
    const out = redactUrls(
      '[in#0] Error opening input: https://rr3---sn-abc123.googlevideo.com/videoplayback' +
        '?expire=1790833283&ei=xyz&ip=203.0.113.9&sig=AAHbGcntsigVALUE&itag=136',
    );
    assert.ok(!out.includes('AAHbGcntsigVALUE'), 'signature must not survive');
    assert.ok(!out.includes('203.0.113.9'), 'client IP must not survive');
    assert.ok(!out.includes('1790833283'), 'expiry must not survive');
    assert.ok(
      out.includes('rr3---sn-abc123.googlevideo.com'),
      'the host is the diagnostic signal and must be kept',
    );
    assert.ok(out.includes('Error opening input'), 'surrounding text is preserved');
  });

  test('redacts the IP even when it is not inside a URL', () => {
    const out = redactUrls('Cookie: SID=abc; ip=203.0.113.9; pot=XYZPOT');
    assert.ok(!out.includes('203.0.113.9'), 'ip= must be redacted');
    assert.ok(!out.includes('XYZPOT'), 'pot= must be redacted');
  });

  test('handles several URLs in one string', () => {
    const out = redactUrls(
      'a https://www.youtube.com/watch?v=abc then b https://youtu.be/abc and c https://x.test/p',
    );
    assert.ok(out.includes('www.youtube.com'));
    assert.ok(out.includes('youtu.be'));
    assert.ok(out.includes('x.test'));
    assert.ok(!/\?v=abc/.test(out), 'query strings must be gone');
  });

  test('leaves ordinary text alone', () => {
    const text = 'ffmpeg rejected the source: [in#0] Invalid data found when processing input';
    assert.equal(redactUrls(text), text);
  });

  test('does not throw on empty or non-string input', () => {
    assert.equal(redactUrls(''), '');
    assert.equal(redactUrls(null), '');
    assert.equal(redactUrls(undefined), '');
    assert.equal(redactUrls(42), '42');
  });

  test('never echoes a URL it could not parse', () => {
    // An invalid port makes `new URL()` throw. The text must still be replaced,
    // not passed through: the safe move is to redact what we cannot understand.
    for (const input of ['see https://[::1]:99999/x here', 'https://%zz/path']) {
      const out = redactUrls(input);
      assert.ok(out.includes('unparseable-host'), `placeholder missing for ${input}`);
      assert.ok(!out.includes('99999'), 'port must not survive');
      assert.ok(!out.includes('%zz'), 'path must not survive');
    }
  });

  test('leaves text that merely contains "https://" as plain words', () => {
    // Nothing follows the scheme, so there is no URL to redact and no reason to
    // mangle the sentence.
    assert.equal(redactUrls('a https:// b'), 'a https:// b');
  });
});
