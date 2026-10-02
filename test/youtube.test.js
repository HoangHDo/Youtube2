import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSource, extractYouTubeId, isPrivateHost, SOURCE_KIND } from '../src/lib/youtube.js';

const ok = (input, opts) => () => parseSource(input, opts);

describe('parseSource - accepted forms', () => {
  const cases = [
    ['aqz-KE-bpKQ', 'aqz-KE-bpKQ'],
    ['  aqz-KE-bpKQ  ', 'aqz-KE-bpKQ'],
    ['https://www.youtube.com/watch?v=aqz-KE-bpKQ', 'aqz-KE-bpKQ'],
    ['https://youtube.com/watch?v=aqz-KE-bpKQ&t=42s', 'aqz-KE-bpKQ'],
    ['https://m.youtube.com/watch?v=aqz-KE-bpKQ', 'aqz-KE-bpKQ'],
    ['https://music.youtube.com/watch?v=aqz-KE-bpKQ', 'aqz-KE-bpKQ'],
    ['https://youtu.be/aqz-KE-bpKQ', 'aqz-KE-bpKQ'],
    ['https://youtu.be/aqz-KE-bpKQ?t=30', 'aqz-KE-bpKQ'],
    ['https://www.youtube.com/shorts/aqz-KE-bpKQ', 'aqz-KE-bpKQ'],
    ['https://www.youtube.com/live/aqz-KE-bpKQ', 'aqz-KE-bpKQ'],
    ['https://www.youtube.com/embed/aqz-KE-bpKQ', 'aqz-KE-bpKQ'],
    ['https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ', 'aqz-KE-bpKQ'],
    ['youtube.com/watch?v=aqz-KE-bpKQ', 'aqz-KE-bpKQ'],
    ['https://www.youtube.com/watch?list=PL123&v=aqz-KE-bpKQ', 'aqz-KE-bpKQ'],
  ];

  for (const [input, expected] of cases) {
    it(`accepts ${input}`, () => {
      const src = parseSource(input);
      assert.equal(src.kind, SOURCE_KIND.YOUTUBE);
      assert.equal(src.videoId, expected);
      assert.equal(src.url, `https://www.youtube.com/watch?v=${expected}`);
    });
  }
});

describe('parseSource - rejection', () => {
  const bad = [
    ['', /Enter a YouTube URL/],
    ['   ', /Enter a YouTube URL/],
    ['not a url at all', /does not look like/],
    ['https://www.youtube.com/', /no video/],
    ['https://www.youtube.com/@someChannel', /no video/],
    ['https://www.youtube.com/playlist?list=PL123', /no video/],
    ['https://www.youtube.com/results?search_query=cats', /no video/],
    ['ftp://youtube.com/watch?v=aqz-KE-bpKQ', /http and https/],
    ['file:///etc/passwd', /http and https/],
    ['javascript:alert(1)', /http and https/],
    ['https://evil.example/watch?v=aqz-KE-bpKQ', /Only YouTube links/],
    ['https://youtube.com.evil.example/watch?v=aqz-KE-bpKQ', /Only YouTube links/],
    ['https://x'.repeat(3000), /too long/],
  ];

  for (const [input, message] of bad) {
    it(`rejects ${JSON.stringify(input.slice(0, 40))}`, () => {
      assert.throws(ok(input), message);
    });
  }

  it('rejects non-strings', () => {
    for (const value of [null, undefined, 42, {}, []]) {
      assert.throws(ok(value), /Enter a YouTube URL/);
    }
  });

  it('tags rejections with a 400 status so the API can pass them through', () => {
    try {
      parseSource('');
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, 'INVALID_SOURCE');
    }
  });
});

describe('parseSource - direct media URLs', () => {
  const direct = { allowDirectPorts: true };

  it('is off by default', () => {
    assert.throws(ok('https://cdn.example/a.mp4'), /Only YouTube links/);
  });

  it('accepts a media file when explicitly enabled', () => {
    const src = parseSource('https://cdn.example/a.mp4', direct);
    assert.equal(src.kind, SOURCE_KIND.DIRECT);
    assert.equal(src.url, 'https://cdn.example/a.mp4');
  });

  it('accepts the streaming extensions too', () => {
    for (const url of [
      'https://cdn.example/a.m3u8',
      'https://cdn.example/a.webm',
      'https://cdn.example/a.mkv',
    ]) {
      assert.equal(parseSource(url, direct).url, url);
    }
  });

  it('still blocks non-media paths', () => {
    assert.throws(ok('https://cdn.example/admin', direct), /does not look like a media file/);
  });

  it('blocks embedded credentials', () => {
    assert.throws(
      ok('https://user:pass@cdn.example/a.mp4', direct),
      /embedded credentials/,
    );
  });

  it('blocks non-standard ports by default (SSRF hardening)', () => {
    assert.throws(ok('https://cdn.example:8081/a.mp4', direct), /Only port/);
    assert.doesNotThrow(() => parseSource('https://cdn.example:8081/a.mp4', {
      ...direct,
      allowedPorts: ['any'],
    }));
  });

  it('blocks loopback, link-local and LAN targets by default', () => {
    for (const host of [
      'http://localhost/a.mp4',
      'http://127.0.0.1/a.mp4',
      'http://169.254.169.254/latest/meta-data.mp4',
      'http://10.0.0.5/a.mp4',
      'http://192.168.1.1/a.mp4',
      'http://[::1]/a.mp4',
    ]) {
      assert.throws(ok(host, direct), /not reachable from a public stream server/, host);
    }
  });

  it('allows private hosts only when the operator opts in', () => {
    assert.doesNotThrow(() =>
      parseSource('http://127.0.0.1:8081/a.mp4', {
        ...direct,
        allowedPorts: ['any'],
        allowPrivateHosts: true,
      }),
    );
  });

  it('classifies hosts correctly', () => {
    assert.equal(isPrivateHost('93.184.216.34'), false);
    assert.equal(isPrivateHost('cdn.example.com'), false);
    assert.equal(isPrivateHost('127.0.0.1'), true);
    assert.equal(isPrivateHost('169.254.169.254'), true);
    assert.equal(isPrivateHost('172.32.0.1'), false, '172.32 is outside the private block');
    assert.equal(isPrivateHost('172.16.0.1'), true);
    assert.equal(isPrivateHost('foo.local'), true);
  });

  it('strips the fragment but keeps the query', () => {
    const src = parseSource('https://cdn.example/a.mp4?token=1#frag', direct);
    assert.equal(src.url, 'https://cdn.example/a.mp4?token=1');
  });
});

describe('extractYouTubeId', () => {
  it('works on URL instances', () => {
    assert.equal(extractYouTubeId(new URL('https://youtu.be/aqz-KE-bpKQ?t=1')), 'aqz-KE-bpKQ');
  });

  it('returns null for a non-YouTube URL', () => {
    assert.equal(extractYouTubeId(new URL('https://example.com/watch?v=aqz-KE-bpKQ')), null);
  });

  it('returns null for a YouTube URL with no video', () => {
    assert.equal(extractYouTubeId(new URL('https://www.youtube.com/feed/history')), null);
  });
});
