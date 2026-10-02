import { open, stat, unlink } from 'node:fs/promises';
import { EventEmitter } from 'node:events';

/**
 * Follows a file that another process is appending to, emitting each new chunk.
 *
 * This exists so that FFmpeg can write its two outputs to two files instead of
 * two pipes. That matters on Windows, where a child process cannot inherit file
 * descriptors above stderr (`pipe:3` fails with EBADF), which used to force the
 * two-output single-process design to degrade into two independent processes.
 * Two processes have two independent start-up latencies, so their live edges sit
 * a few hundred milliseconds apart for the whole session - and because neither
 * transport can be rewound, that offset is invisible to the client and can never
 * be corrected. One process writing two files has a single timeline, so the two
 * outputs cannot drift apart.
 *
 * The tail is poll-based rather than fs.watch-based on purpose: on Windows a
 * write to a file being watched can arrive as several events, and coalescing
 * them correctly is more subtle than simply asking for the size again.
 */
export class FileTailer extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.path      file to follow
   * @param {number} [o.intervalMs] how often to look for new bytes
   * @param {number} [o.maxChunkBytes] cap on a single read
   */
  constructor({ path, intervalMs = 25, maxChunkBytes = 1 << 20 }) {
    super();
    this.path = path;
    this.intervalMs = intervalMs;
    this.maxChunkBytes = maxChunkBytes;
    this.offset = 0;
    this.stopped = false;
    this._timer = null;
    this._handle = null;
    this._opening = null;
  }

  start() {
    if (this._timer || this.stopped) return;
    this._timer = setInterval(() => {
      this._drain().catch(() => {
        // A missing or transiently unreadable file is normal while FFmpeg is
        // still starting up; the next tick retries.
      });
    }, this.intervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  async _open() {
    if (this._handle) return this._handle;
    if (!this._opening) {
      this._opening = open(this.path, 'r')
        .then((handle) => {
          this._handle = handle;
          this._opening = null;
          return handle;
        })
        .catch((err) => {
          this._opening = null;
          throw err;
        });
    }
    return this._opening;
  }

  async _drain() {
    if (this.stopped) return;
    const handle = await this._open();
    const { size } = await stat(this.path).catch(() => ({ size: this.offset }));
    if (size <= this.offset) return;

    // Read at most one chunk per tick so a stalled consumer cannot make this
    // buffer without limit; the next tick picks up where this one stopped.
    const want = Math.min(size - this.offset, this.maxChunkBytes);
    const buf = Buffer.allocUnsafe(want);
    const { bytesRead } = await handle.read(buf, 0, want, this.offset);
    if (bytesRead <= 0) return;
    this.offset += bytesRead;
    this.emit('data', bytesRead === want ? buf : buf.subarray(0, bytesRead));
  }

  async stop({ unlink: remove = true } = {}) {
    this.stopped = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._handle) {
      await this._handle.close().catch(() => {});
      this._handle = null;
    }
    if (this._opening) {
      await this._opening.catch(() => {});
      this._opening = null;
    }
    if (remove) await this._remove();
  }

  /**
   * Deletes the file, retrying briefly.
   *
   * The writer is a separate process that may still be shutting down, and
   * Windows refuses to unlink a file that anyone has open - so the first few
   * attempts can fail even though the file is on its way out. A handful of
   * retries turns that into a reliable delete.
   */
  async _remove(attempts = 6) {
    for (let i = 0; i < attempts; i += 1) {
      try {
        await unlink(this.path);
        return true;
      } catch (err) {
        if (err?.code === 'ENOENT') return true;
        if (i === attempts - 1) return false;
        await new Promise((r) => setTimeout(r, 50 * (i + 1)));
      }
    }
    return false;
  }
}
