/**
 * Orphan-reaper tests.
 *
 * The dangerous failure mode here is killing an unrelated process because a
 * pid got recycled, so that case is asserted as explicitly as the happy path.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

// The pid file is namespaced by listen port, so the test resolves it the same
// way the app does rather than hard-coding a name.
process.env.PORT ??= '18099';
const STATE_FILE = join(tmpdir(), `cyberstream-ffmpeg-pids-${process.env.PORT}.json`);

const hasFfmpeg = (() => {
  try {
    spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

describe('orphan reaper', () => {
  before(async () => {
    await rm(STATE_FILE, { force: true });
  });

  after(async () => {
    await rm(STATE_FILE, { force: true });
  });

  it('does nothing when there is no state file', async () => {
    // A fresh boot with no previous run must be a no-op, not an error.
    const { reapOrphans } = await import('../src/lib/orphan-reaper.js');
    const killed = await reapOrphans();
    assert.equal(killed, 0);
  });

  it('ignores a state file that is not valid JSON', async () => {
    await writeFile(STATE_FILE, 'not json at all', 'utf8');
    const { reapOrphans } = await import('../src/lib/orphan-reaper.js');
    assert.equal(await reapOrphans(), 0);
  });

  it('ignores entries whose pid is gone', async () => {
    await writeFile(
      STATE_FILE,
      JSON.stringify([{ pid: 999999, sessionId: 'gone', at: Date.now() }]),
      'utf8',
    );
    const { reapOrphans } = await import('../src/lib/orphan-reaper.js');
    assert.equal(await reapOrphans(), 0);
  });

  it('namespaces the pid file per port, so instances cannot reap each other', async () => {
    // Two instances on one host must not share state: the second to boot would
    // otherwise kill the first one's running transcoders.
    const { pruneForeignStateFiles } = await import('../src/lib/orphan-reaper.js');
    const otherPort = Number(process.env.PORT) + 1;

    const decoyFile = join(tmpdir(), `cyberstream-ffmpeg-pids-${otherPort}.json`);
    await writeFile(decoyFile, JSON.stringify([{ pid: 1, at: Date.now() }]), 'utf8');

    const exists = () => readFile(decoyFile, 'utf8').then(() => true).catch(() => false);

    // Occupying that port must make the file look "in use" and be preserved.
    const blocker = createServer(() => {});
    await new Promise((r) => blocker.listen(otherPort, '127.0.0.1', r));
    try {
      const removed = await pruneForeignStateFiles();
      assert.equal(removed, 0, "a live instance's file is left alone");
      assert.ok(await exists(), "the live instance's pid file still exists");
    } finally {
      await new Promise((r) => blocker.close(r));
    }

    // With the port free the stale file is reclaimable.
    await sleep(100);
    await pruneForeignStateFiles();
    assert.equal(await exists(), false, 'the stale file was removed');
  });

  it('never kills a pid that has been recycled to a non-ffmpeg process', async () => {
    // Spawn a *node* child and pretend the state file says it is an orphan.
    // The reaper must look at the image name and refuse.
    const server = createServer(() => {});
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const decoy = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
    });
    await sleep(300);

    await writeFile(
      STATE_FILE,
      JSON.stringify([{ pid: decoy.pid, sessionId: 'decoy', at: Date.now() }]),
      'utf8',
    );

    const { reapOrphans } = await import('../src/lib/orphan-reaper.js');
    const killed = await reapOrphans();

    assert.equal(killed, 0, 'nothing should be killed');
    assert.equal(isAlive(decoy.pid), true, 'the decoy process survived');

    decoy.kill('SIGKILL');
    server.close();
  });

  it('rejects our own pid and other nonsense entries', async () => {
    await writeFile(
      STATE_FILE,
      JSON.stringify([
        { pid: process.pid, sessionId: 'self', at: Date.now() },
        { pid: -1, sessionId: 'negative', at: Date.now() },
        { pid: 'abc', sessionId: 'string', at: Date.now() },
        { pid: 0, sessionId: 'zero', at: Date.now() },
        null,
      ]),
      'utf8',
    );
    const { reapOrphans } = await import('../src/lib/orphan-reaper.js');
    assert.equal(await reapOrphans(), 0);
    assert.equal(isAlive(process.pid), true, 'the test process is fine');
  });

  it('registers and unregisters a real ffmpeg child', {
    skip: !hasFfmpeg && 'ffmpeg not available',
  }, async () => {
    const { registerChild, unregisterChild, trackedCount } = await import(
      '../src/lib/orphan-reaper.js'
    );

    // A long-running child (-re paces it), so it cannot exit before we assert.
    // 25 fps because MPEG-1 has no other legal frame rate.
    const child = spawn(
      'ffmpeg',
      ['-y', '-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi',
       '-i', 'testsrc2=size=64x64:rate=25:duration=30',
       '-c:v', 'mpeg1video', '-f', 'mpegts', join(tmpdir(), 'orphan-fixture.ts')],
      { stdio: 'ignore' },
    );
    await sleep(400);
    assert.equal(isAlive(child.pid), true, 'child is running');

    registerChild(child, 'test-session');
    assert.equal(trackedCount(), 1);
    // The persist call is coalesced, so give it a moment.
    await sleep(500);
    const entries = JSON.parse(await readFile(STATE_FILE, 'utf8').catch(() => '[]'));
    assert.ok(
      Array.isArray(entries) && entries.some((e) => e.pid === child.pid),
      'the child pid was persisted',
    );

    unregisterChild(child.pid);
    assert.equal(trackedCount(), 0);
    // Removal is asynchronous, so poll rather than race it.
    let removed = false;
    for (let i = 0; i < 20 && !removed; i += 1) {
      await sleep(50);
      removed = (await readFile(STATE_FILE, 'utf8').catch(() => null)) === null;
    }
    assert.ok(removed, 'the state file is removed when nothing is outstanding');

    child.kill('SIGKILL');
    await sleep(200);
    await rm(join(tmpdir(), 'orphan-fixture.ts'), { force: true });
  });
});
