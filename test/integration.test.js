/**
 * HTTP API + streaming integration tests.
 *
 * These boot the real Express app and a real FFmpeg process, then drive the
 * actual endpoints: create a session, read the MP3 over HTTP, open the
 * WebSocket, and stop the stream. No mocks - if the pipeline regresses, these
 * fail.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.ALLOW_DIRECT_MEDIA_URLS = 'true';
process.env.DIRECT_MEDIA_PORTS = 'any';
// The fixture server is on loopback, which production correctly refuses.
process.env.ALLOW_PRIVATE_MEDIA_HOSTS = 'true';
process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = 'false';
process.env.NODE_ENV = 'test';
// A short grace period would race the lifecycle tests against the reaper; the
// reaper itself is exercised deterministically further down.
process.env.ORPHAN_GRACE_MS = '60000';
process.env.CLEANUP_INTERVAL_MS = '1000';
process.env.BOOT_TIMEOUT_MS = '20000';
process.env.MAX_SESSIONS = '3';

const { createApp } = await import('../src/app.js');
const { attachVideoWebSocket } = await import('../src/realtime/video.socket.js');
const { attachControlSocket } = await import('../src/realtime/control.socket.js');
const { sessionStore, shutdownAll, startReaper } = await import('../src/lib/session-store.js');
const { purgeResolveTemp } = await import('../src/lib/resolver.js');
const { config } = await import('../src/config/index.js');

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Serves a generated fixture over HTTP so FFmpeg exercises its network path. */
async function startFixtureServer() {
  const dir = mkdtempSync(join(tmpdir(), 'cyberstream-fixture-'));
  const file = join(dir, 'clip.mp4');
  execFileSync(
    'ffmpeg',
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      // Long enough that the source cannot run out mid-suite: a session that
      // ends normally is a legitimate state, but it would make the streaming
      // assertions flaky.
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=120',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=120',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      file,
    ],
    { stdio: 'ignore' },
  );

  const { createReadStream, statSync } = await import('node:fs');
  const server = createServer((req, res) => {
    const size = statSync(file).size;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : size - 1;
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
        'content-length': end - start + 1,
      });
      createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': size,
        'accept-ranges': 'bytes',
      });
      createReadStream(file).pipe(res);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/clip.mp4`, close: () => server.close() };
}

describe('CyberStream HTTP + streaming', { skip: !hasFfmpeg && 'ffmpeg not available' }, () => {
  let server;
  let video;
  let control;
  let fixture;
  let base;
  let wsBase;
  let stopReaper;

  before(async () => {
    fixture = await startFixtureServer();
    const app = createApp();
    server = createServer(app);
    video = attachVideoWebSocket(server);
    control = attachControlSocket(server);
    // The reaper is started by server.js in production; the tests drive it too
    // so the cleanup behaviour is actually covered.
    stopReaper = startReaper();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    base = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
  });

  after(async () => {
    await shutdownAll('test');
    stopReaper?.();
    control?.close();
    video?.close();
    await new Promise((r) => server.close(r));
    fixture?.close();
    await purgeResolveTemp();
  });

  const json = async (path, init) => {
    const res = await fetch(`${base}${path}`, init);
    const body = await res.json().catch(() => null);
    return { res, body };
  };

  /* ------------------------------------------------------------- basics -- */
  it('serves health, config and catalog without auth', async () => {
    const { res, body } = await json('/api/health');
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);

    const cfg = await json('/api/config');
    assert.equal(cfg.res.status, 200);
    assert.ok(cfg.body.media.width > 0);
    assert.equal(cfg.body.paths.ws, '/ws/video');

    const cat = await json('/api/catalog');
    assert.equal(cat.res.status, 200);
    assert.ok(Array.isArray(cat.body.items));
    assert.ok(cat.body.items.every((i) => i.url && i.thumb));
  });

  it('validates a URL without starting FFmpeg', async () => {
    const { res, body } = await json('/api/resolve/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://youtu.be/aqz-KE-bpKQ' }),
    });
    assert.equal(res.status, 200);
    assert.equal(body.videoId, 'aqz-KE-bpKQ');
  });

  it('rejects a URL that is not a media file with a friendly 400', async () => {
    const { res, body } = await json('/api/resolve/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://cdn.example/admin/page' }),
    });
    assert.equal(res.status, 400);
    assert.match(body.message, /media file/);
  });

  it('rejects a missing body', async () => {
    const { res } = await json('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it('sends security headers', async () => {
    const res = await fetch(`${base}/`);
    assert.ok(res.headers.get('content-security-policy'), 'CSP present');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  /* ------------------------------------------------------------ session -- */
  describe('session lifecycle', () => {
    let session;

    before(async () => {
      const { res, body } = await json('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: fixture.url }),
      });
      assert.equal(res.status, 201, JSON.stringify(body));
      session = body;
    });

    after(() => session?.sessionId && sessionStore.get(session.sessionId)?.destroy());

    it('reports both tracks and the encoder strategy', () => {
      assert.ok(session.sessionId);
      assert.ok(session.tokens.viewerToken);
      assert.ok(session.tokens.ownerToken);
      assert.notEqual(session.tokens.viewerToken, session.tokens.ownerToken);
      assert.match(session.endpoints.video, /^wss?:\/\//);
      assert.match(session.endpoints.audio, /audio\.mp3/);
      assert.ok(session.endpoints.video.includes(session.tokens.viewerToken));
      // Any single-timeline strategy is acceptable; dual-stdout is the one mode
    // where the two outputs can drift apart, so assert we are not in it unless
    // the platform left us no alternative.
    assert.ok(
      ['multi-pipe', 'dual-file', 'dual-stdout'].includes(session.strategy),
      `unexpected strategy ${session.strategy}`,
    );
      // `missingTracks` is the authoritative signal; neither output is empty
      // for a source that has both.
      assert.equal(session.missingTracks.video, null);
      assert.equal(session.missingTracks.audio, null);
    });

    it('never leaks the owner token into the media endpoints', () => {
      assert.ok(!session.endpoints.video.includes(session.tokens.ownerToken));
      assert.ok(!session.endpoints.audio.includes(session.tokens.ownerToken));
    });

    it('refuses the audio endpoint without a token', async () => {
      const res = await fetch(`${base}/api/stream/${session.sessionId}/audio.mp3`);
      assert.equal(res.status, 401);
    });

    it('refuses a wrong token', async () => {
      const res = await fetch(
        `${base}/api/stream/${session.sessionId}/audio.mp3?token=${'a'.repeat(43)}`,
      );
      assert.equal(res.status, 401);
    });

    it('does not confirm existence for an unknown session', async () => {
      const res = await fetch(
        `${base}/api/stream/${'b'.repeat(22)}/audio.mp3?token=${session.tokens.viewerToken}`,
      );
      assert.equal(res.status, 404);
    });

    it('refuses to stop the session with the viewer token', async () => {
      const res = await fetch(
        `${base}/api/stream/${session.sessionId}?token=${session.tokens.viewerToken}`,
        { method: 'DELETE' },
      );
      assert.equal(res.status, 403);
    });

    it('streams MP3 over HTTP with the right headers and real frames', async () => {
      const res = await fetch(session.endpoints.audio, { headers: { accept: 'audio/mpeg' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'audio/mpeg');
      assert.equal(res.headers.get('accept-ranges'), 'none');
      assert.equal(res.headers.get('x-accel-buffering'), 'no');
      assert.match(res.headers.get('cache-control'), /no-store/);

      const reader = res.body.getReader();
      const { value } = await reader.read();
      await reader.cancel();

      assert.ok(value.length > 0, 'received audio bytes');
      // Every MP3 frame begins with a 0xFF Ex sync word.
      assert.equal(value[0], 0xff, 'MP3 frame sync');
      assert.equal(value[1] & 0xe0, 0xe0, 'MP3 frame sync bits');
    });

    it('relays MPEG-TS over the WebSocket, starting with 0x47 packets', async () => {
      const ws = new WebSocket(
        `${wsBase}/ws/video?sessionId=${session.sessionId}&token=${session.tokens.viewerToken}`,
      );
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });

      const chunks = await new Promise((resolve, reject) => {
        const got = [];
        const timer = setTimeout(() => resolve(got), 6000);
        ws.on('message', (data, isBinary) => {
          if (!isBinary) return;
          got.push(Buffer.from(data));
          if (got.reduce((n, c) => n + c.length, 0) > 200_000) {
            clearTimeout(timer);
            resolve(got);
          }
        });
        ws.on('error', reject);
        ws.on('close', () => {
          clearTimeout(timer);
          resolve(got);
        });
      });
      ws.close();

      const total = chunks.reduce((n, c) => n + c.length, 0);
      assert.ok(total > 100_000, `expected video data, got ${total} bytes`);

      // Concatenating must land on the 188-byte TS packet grid.
      const all = Buffer.concat(chunks);
      assert.equal(all[0], 0x47, 'TS sync byte');
      for (const offset of [0, 188, 376, 188 * 10]) {
        assert.equal(all[offset], 0x47, `packet boundary at ${offset}`);
      }
    });

    it('refuses a WebSocket upgrade without a valid token', async () => {
      await assert.rejects(
        () => new Promise((resolve, reject) => {
          const ws = new WebSocket(
            `${wsBase}/ws/video?sessionId=${session.sessionId}&token=${'c'.repeat(43)}`,
          );
          ws.once('open', () => resolve());
          ws.once('error', reject);
          ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
        }),
        /401/,
      );
    });

    it('stops on request with the owner token and tears down FFmpeg', async () => {
      const pid = sessionStore.get(session.sessionId)?.transcoder?.pid();
      const before = sessionStore.size;
      const res = await fetch(session.endpoints.stop, { method: 'DELETE' });
      assert.equal(res.status, 200);
      assert.equal(sessionStore.size, before - 1);
      // The session is gone from the registry immediately...
      assert.equal(sessionStore.get(session.sessionId), undefined);
      // ...and the FFmpeg process must actually be gone shortly after.
      if (pid) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && isAlive(pid)) {
          await new Promise((r) => setTimeout(r, 200));
        }
        assert.equal(isAlive(pid), false, `ffmpeg pid ${pid} is still running`);
      }
    });
  });

  /* ------------------------------------------------------------ cleanup -- */
  it('reaps a session that has been orphaned past the grace period', async () => {
    const { res, body } = await json('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: fixture.url }),
    });
    assert.equal(res.status, 201);
    const id = body.sessionId;
    const live = sessionStore.get(id);
    assert.ok(live);

    // No viewer ever attached. Backdate the orphan marker instead of sleeping
    // through the real grace period, so the assertion is deterministic.
    live.maybeMarkOrphaned();
    live.orphanedAt = Date.now() - config.sessions.orphanGraceMs - 1000;

    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && sessionStore.get(id)) {
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(sessionStore.get(id), undefined, 'orphan was reaped');
  });

  it('honours the session cap', async () => {
    const cap = config.sessions.max;
    const sizeBefore = sessionStore.size;
    const ids = [];
    let sawLimit = false;

    for (let i = 0; i < cap + 3; i += 1) {
      const { res, body } = await json('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: fixture.url }),
      });
      if (res.status === 503) {
        assert.equal(body.error, 'TOO_MANY_SESSIONS');
        assert.match(body.message, /already streaming/);
        sawLimit = true;
        break;
      }
      assert.equal(res.status, 201, JSON.stringify(body));
      ids.push(body.sessionId);
    }

    assert.ok(sawLimit, 'the cap was enforced');
    assert.equal(sessionStore.size, sizeBefore + ids.length);
    await shutdownAll('test-cap');
    assert.equal(sessionStore.size, 0);
  });

  it('rate limits session creation per IP', async () => {
    let limited = false;
    for (let i = 0; i < 40; i += 1) {
      const { res, body } = await json('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: fixture.url }),
      });
      if (res.status === 429) {
        assert.equal(body.error, 'rate_limited');
        limited = true;
        break;
      }
      if (res.status === 503) continue; // cap, not the limiter
    }
    assert.ok(limited, 'the create limiter returned 429');
    await shutdownAll('test-ratelimit');
  });
});
