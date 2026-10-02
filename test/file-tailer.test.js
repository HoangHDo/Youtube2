import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTailer } from '../src/lib/file-tailer.js';

/** Collects everything a tailer emits. */
function collect(tailer) {
  const chunks = [];
  tailer.on('data', (b) => chunks.push(b));
  return {
    chunks,
    text: () => Buffer.concat(chunks).toString(),
    size: () => chunks.reduce((n, c) => n + c.length, 0),
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('FileTailer', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tailer-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await t.test('emits bytes appended after it starts', async () => {
    const path = join(dir, 'a.bin');
    await writeFile(path, Buffer.alloc(0));
    const tailer = new FileTailer({ path, intervalMs: 10 });
    const seen = collect(tailer);
    tailer.start();

    await appendFile(path, 'hello ');
    await wait(60);
    await appendFile(path, 'world');
    await wait(60);

    assert.equal(seen.text(), 'hello world');
    await tailer.stop({ unlink: false });
  });

  await t.test('does not re-emit bytes it has already read', async () => {
    const path = join(dir, 'b.bin');
    await writeFile(path, 'one');
    const tailer = new FileTailer({ path, intervalMs: 10 });
    const seen = collect(tailer);
    tailer.start();
    await wait(60);
    await appendFile(path, 'two');
    await wait(60);
    assert.equal(seen.text(), 'onetwo', 'each byte arrives exactly once');
    await tailer.stop({ unlink: false });
  });

  await t.test('survives the file not existing yet', async () => {
    const path = join(dir, 'sub', 'later.bin');
    const tailer = new FileTailer({ path, intervalMs: 10 });
    const seen = collect(tailer);
    tailer.start();
    await wait(50); // nothing to read yet
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(path, 'late');
    await wait(80);
    assert.equal(seen.text(), 'late');
    await tailer.stop();
  });

  await t.test('stop() removes the file it was following', async () => {
    const path = join(dir, 'c.bin');
    await writeFile(path, 'data');
    const tailer = new FileTailer({ path, intervalMs: 10 });
    tailer.start();
    await wait(30);
    await tailer.stop();
    await assert.rejects(() => import('node:fs/promises').then((fs) => fs.stat(path)));
  });

  await t.test('emits nothing more after stop()', async () => {
    const path = join(dir, 'd.bin');
    await writeFile(path, 'x');
    const tailer = new FileTailer({ path, intervalMs: 10 });
    const seen = collect(tailer);
    tailer.start();
    await wait(40);
    await tailer.stop({ unlink: false });
    const before = seen.size();
    await appendFile(path, 'yz');
    await wait(60);
    assert.equal(seen.size(), before, 'no reads after stop');
  });

  await t.test('reads a large backlog in bounded chunks', async () => {
    const path = join(dir, 'big.bin');
    // 300 KiB written at once, with a 64 KiB cap per read.
    await writeFile(path, Buffer.alloc(300 * 1024, 7));
    const tailer = new FileTailer({ path, intervalMs: 5, maxChunkBytes: 64 * 1024 });
    const seen = collect(tailer);
    tailer.start();
    // Long enough for ~5 polls at 5 ms.
    for (let i = 0; i < 40 && seen.size() < 300 * 1024; i += 1) await wait(10);
    assert.equal(seen.size(), 300 * 1024, 'drains the whole backlog');
    await tailer.stop({ unlink: false });
  });
});
