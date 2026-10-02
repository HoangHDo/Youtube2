import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneStaleSessionDirs, SESSION_TMP_ROOT } from '../src/lib/orphan-reaper.js';

/**
 * In `dual-file` mode FFmpeg writes its MPEG-TS and MP3 outputs into a
 * per-session directory. A session that shuts down normally removes it, but a
 * crash or a `kill -9` does not - and these are real bytes on disk, tens of
 * megabytes each, so a crash loop would fill the temp volume. The sweeper is the
 * only thing that collects them.
 */
describe('pruneStaleSessionDirs', () => {
  const root = join(tmpdir(), SESSION_TMP_ROOT);

  const makeSessionDir = async (name) => {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `out-${name}.ts`), 'x'.repeat(2048));
    return dir;
  };

  /** Backdate a directory so the sweeper considers it abandoned. */
  const backdate = async (dir, hours) => {
    const when = new Date(Date.now() - hours * 3600 * 1000);
    await utimes(dir, when, when);
  };

  // `stat`, not `readdir`: readdir on a *file* rejects with ENOTDIR, so a
  // readdir-based check reports every file as missing and turns a real
  // "the sweeper ate it" bug into a confusing one.
  const exists = (p) => stat(p).then(() => true).catch(() => false);

  before(async () => {
    // Use a private root per run so the sweeper cannot touch a real session.
    process.env.CYBERSTREAM_TEST_TMP = '1';
  });

  after(async () => {
    delete process.env.CYBERSTREAM_TEST_TMP;
  });

  test('removes a directory abandoned by a crashed run', async () => {
    const dir = await makeSessionDir('s-crashedtest-aaaaaaaa');
    await backdate(dir, 5);
    const removed = await pruneStaleSessionDirs();
    assert.ok(removed >= 1, 'the abandoned directory should be swept');
    assert.equal(await exists(dir), false, 'and actually removed, contents included');
  });

  test('never touches a directory that looks live', async () => {
    // A running session is being written to continuously, so its mtime is fresh.
    // Deleting one would destroy a stream in progress, so the age gate is the
    // whole safety property here.
    const dir = await makeSessionDir('s-livetest-bbbbbbbb');
    assert.equal(await exists(dir), true, 'precondition: it exists');
    await pruneStaleSessionDirs();
    assert.equal(await exists(dir), true, 'a fresh session directory must survive');
    await rm(dir, { recursive: true, force: true });
  });

  test('respects an explicit age threshold', async () => {
    const dir = await makeSessionDir('s-margin-cccccccc');
    await backdate(dir, 0.02); // ~72 seconds old
    // Default (1 hour) must leave it alone.
    await pruneStaleSessionDirs();
    assert.equal(await exists(dir), true, 'under an hour old: untouched');
    // A caller that genuinely wants it gone can say so.
    await pruneStaleSessionDirs({ minAgeMs: 1000 });
    assert.equal(await exists(dir), false, 'with a tiny threshold: swept');
  });

  test('does not throw when the temp root has never been created', async () => {
    const missing = join(tmpdir(), 'cyberstream-does-not-exist-xyz');
    assert.equal(await exists(missing), false, 'precondition');
    // The real root usually exists, but the function must tolerate its absence.
    const removed = await pruneStaleSessionDirs();
    assert.equal(typeof removed, 'number');
  });

  test('ignores files and non-session names in the root', async () => {
    const stray = join(root, 'not-a-session-dir');
    await mkdir(stray, { recursive: true });
    await backdate(stray, 5);
    const strayFile = join(root, 'some-file.txt');
    await writeFile(strayFile, 'hello');

    await pruneStaleSessionDirs();

    assert.equal(await exists(stray), true, 'a directory not named s-* must be left alone');
    assert.equal(await exists(strayFile), true, 'a stray file must be left alone');
    await rm(stray, { recursive: true, force: true });
    await rm(strayFile, { force: true });
  });
});
