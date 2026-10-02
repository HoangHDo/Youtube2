/**
 * Regression test: a session that goes live but never gets a viewer attached
 * must still be reclaimed by the reaper.
 *
 * `orphanedAt` used to be set exclusively from `removeSubscriber()`. A client
 * that called POST /api/sessions and then never connected - closed the tab,
 * crashed, or only used the API - therefore left `orphanedAt` null forever, so
 * the reaper's orphan branch never matched and the FFmpeg process survived until
 * the (2 hour) lifetime cap. Enough of those and MAX_SESSIONS is exhausted for
 * everyone.
 *
 * These use a short grace window and a real local fixture so the failure is
 * deterministic rather than a 30-second wait.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, createReadStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.ALLOW_DIRECT_MEDIA_URLS = 'true';
process.env.DIRECT_MEDIA_PORTS = 'any';
// The fixture server is on loopback, which production correctly refuses.
process.env.ALLOW_PRIVATE_MEDIA_HOSTS = 'true';
process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = 'false';
process.env.NODE_ENV = 'test';
// Short enough that the reaper fires within the test, long enough that a client
// which *does* connect is not racing it.
process.env.ORPHAN_GRACE_MS = '2000';
process.env.CLEANUP_INTERVAL_MS = '500';
process.env.BOOT_TIMEOUT_MS = '20000';

const { sessionStore, shutdownAll, startReaper, SESSION_STATE } = await import(
  '../src/lib/session-store.js'
);

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Serves a long generated clip so the session cannot end on its own mid-test. */
async function startFixtureServer() {
  const dir = mkdtempSync(join(tmpdir(), 'cyberstream-orphan-'));
  const file = join(dir, 'clip.mp4');
  execFileSync(
    'ffmpeg',
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=180',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=180',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      file,
    ],
    { stdio: 'ignore' },
  );

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
  return {
    url: `http://127.0.0.1:${server.address().port}/clip.mp4`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls until `fn()` is truthy or the budget runs out. */
async function until(fn, { timeout = 15000, every = 100 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await wait(every);
  }
  return false;
}

describe('orphan grace for unwatched sessions', { skip: !hasFfmpeg && 'ffmpeg not available' }, () => {
  let fixture;
  let stopReaper;

  before(async () => {
    fixture = await startFixtureServer();
    stopReaper = startReaper();
  });

  after(async () => {
    stopReaper?.();
    await shutdownAll();
    await fixture?.close();
  });

  it('marks a session orphaned as soon as it goes live with no viewers', async () => {
    const session = sessionStore.create({ input: fixture.url, requestIp: '127.0.0.1' });
    await session.start();

    const wentLive = await until(() => session.state === SESSION_STATE.LIVE);
    assert.ok(wentLive, `expected the session to go live, got ${session.state}`);

    // The regression: no subscriber ever attached, so removeSubscriber() never
    // ran. The session must still start its orphan clock on reaching LIVE.
    assert.notEqual(
      session.orphanedAt,
      null,
      'a live session with no viewers must be marked orphaned',
    );

    session.stop('test-teardown');
  });

  it('reaps the session and kills its FFmpeg process once the grace expires', async () => {
    const session = sessionStore.create({ input: fixture.url, requestIp: '127.0.0.1' });
    await session.start();

    const wentLive = await until(() => session.state === SESSION_STATE.LIVE);
    assert.ok(wentLive, `expected the session to go live, got ${session.state}`);

    const pid = session.transcoder?.pid();
    assert.ok(pid, 'expected a transcoder with a pid');

    // Nobody ever attaches a viewer, so the reaper must stop it on its own.
    const stopped = await until(
      () => session.state === SESSION_STATE.STOPPING || session.state === SESSION_STATE.ENDED,
      { timeout: 20000 },
    );
    assert.ok(stopped, `expected the reaper to stop the session, state was ${session.state}`);
    assert.equal(session.reason, 'orphaned', 'expected the session to be reaped as an orphan');

    // The whole point is that the FFmpeg process does not outlive the session.
    const died = await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (err) {
        return err.code === 'ESRCH';
      }
    }, { timeout: 10000 });
    assert.ok(died, `ffmpeg pid ${pid} was still running after the session was reaped`);
  });
});
