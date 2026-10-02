/**
 * Orphan protection for FFmpeg child processes.
 *
 * If the Node process is SIGKILLed (or the machine loses power mid-write) the
 * children survive: FFmpeg is not in the same job object, so nothing reaps it
 * and you end up with a CPU-burning transcoder nobody is watching. This is easy
 * to hit with `kill -9`, a container restart, or a crash in a native addon.
 *
 * Every child we spawn is recorded in a small JSON file. On boot we read it
 * back and terminate anything that is still alive. Two safeguards keep this
 * from killing something unrelated:
 *
 *   1. The pid must still exist.
 *   2. Its image name must still be FFmpeg - pids get recycled, and a stale
 *      entry from last week must never point at today's database server.
 */
import { readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import { childLogger } from './logger.js';

const execFileAsync = promisify(execFile);
const log = childLogger({ mod: 'orphan-reaper' });

/**
 * The pid file is namespaced by listen port.
 *
 * Without that, two CyberStream instances on one machine (a normal setup: 8080
 * for you, 8081 for a demo) would share one file, and the second to boot would
 * kill the first one's running transcoders. Per port, an instance only ever
 * reaps orphans that it started itself.
 */
const STATE_FILE_PREFIX = 'cyberstream-ffmpeg-pids-';
const STATE_FILE = join(tmpdir(), `${STATE_FILE_PREFIX}${config.port}.json`);
/**
 * Root under the OS temp dir that holds one directory per session.
 *
 * Exported so the sweeper here and the session store that creates the
 * directories cannot drift apart - a mismatch would make the sweeper delete
 * nothing while the store kept writing.
 */
export const SESSION_TMP_ROOT = 'cyberstream';
/**
 * How stale a session directory must be before it is swept. Generous: a live
 * session's directory is being written to continuously, so a large margin costs
 * nothing and rules out ever deleting a running session's output.
 */
const SESSION_DIR_MIN_AGE_MS = 60 * 60 * 1000;

/** @type {Map<number, {pid:number, sessionId:string, at:number}>} */
const tracked = new Map();
let persistTimer = null;

function imageName(pid) {
  if (process.platform === 'win32') {
    return execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      windowsHide: true,
    })
      .then(({ stdout }) => {
        // "ffmpeg.exe","1234","Console","1","100,000 K"
        const m = /"([^"]+)"/.exec(stdout ?? '');
        return m?.[1]?.toLowerCase() ?? null;
      })
      .catch(() => null);
  }
  return readFile(`/proc/${pid}/cmdline`, 'utf8')
    .then((cmd) => pathName(cmd.split('\0')[0]))
    .catch(() => null);
}

function pathName(p) {
  if (!p) return null;
  const parts = p.split(/[\\/]/);
  return parts.at(-1)?.toLowerCase() ?? null;
}

/** Call right after spawn(). */
export function registerChild(child, sessionId) {
  if (!child?.pid) return;
  tracked.set(child.pid, { pid: child.pid, sessionId, at: Date.now() });
  schedulePersist();
}

/** Call on 'close'/'exit'. */
export function unregisterChild(pid) {
  if (tracked.delete(pid) && tracked.size === 0) void clearStateFile();
}

function schedulePersist() {
  if (persistTimer) return;
  // Coalesce bursts: a session registers several children at once.
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persist();
  }, 250);
  persistTimer.unref?.();
}

async function persist() {
  try {
    await writeFile(STATE_FILE, JSON.stringify([...tracked.values()]), 'utf8');
  } catch (err) {
    log.debug({ err: err.message }, 'could not persist child pid file');
  }
}

async function clearStateFile() {
  try {
    await rm(STATE_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Terminates FFmpeg processes left behind by a previous run.
 * @returns {Promise<number>} how many were killed
 */
export async function reapOrphans() {
  let entries = [];
  try {
    entries = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    if (!Array.isArray(entries)) entries = [];
  } catch {
    return 0; // no state file: nothing of ours is outstanding
  }

  let killed = 0;
  for (const entry of entries) {
    const pid = Number(entry?.pid);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;

    const name = await imageName(pid);
    if (!name) continue; // already gone
    if (!name.includes('ffmpeg')) {
      // The pid was recycled by something else. Never touch it.
      log.warn({ pid, name }, 'skipping pid that is no longer ffmpeg');
      continue;
    }

    try {
      process.kill(pid, 'SIGKILL');
      killed += 1;
      log.warn({ pid, sessionId: entry.sessionId, startedAt: entry.at }, 'killed orphaned ffmpeg');
    } catch (err) {
      log.debug({ pid, err: err.message }, 'orphan already gone');
    }
  }

  await clearStateFile();
  tracked.clear();
  if (killed > 0) log.warn({ killed }, 'reaped orphaned ffmpeg processes');
  return killed;
}

export function trackedCount() {
  return tracked.size;
}

/**
 * Removes pid files belonging to *other* ports that are no longer in use.
 *
 * Without this, changing PORT leaves a file behind forever. The check is
 * conservative: a file is only removed if nothing is listening on the port it
 * names, so a second instance that is currently running is never disturbed.
 */
export async function pruneForeignStateFiles() {
  let names = [];
  try {
    names = await readdir(tmpdir());
  } catch {
    return 0;
  }

  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(STATE_FILE_PREFIX) || !name.endsWith('.json')) continue;
    const port = Number(name.slice(STATE_FILE_PREFIX.length, -'.json'.length));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      // Not one of ours, or corrupt: never act on an unparseable name.
      continue;
    }
    if (name === `${STATE_FILE_PREFIX}${config.port}.json`) continue;
    if (await isPortInUse(port)) continue;

    await rm(join(tmpdir(), name), { force: true }).catch(() => {});
    removed += 1;
  }
  if (removed > 0) log.debug({ removed }, 'removed pid files from unused ports');
  return removed;
}

/**
 * Removes session temp directories left behind by a process that died.
 *
 * Each session gets a directory under `<tmp>/cyberstream/s-<id>-<rand>/`, and in
 * `dual-file` mode FFmpeg writes its two outputs into it. A session torn down
 * normally removes its own directory, but a crash, a `kill -9`, or a power loss
 * skips that - and unlike the pipes the other strategies use, those are real
 * bytes on disk, tens of megabytes per session. Left alone, a crash loop fills
 * the temp volume.
 *
 * Only directories untouched for a long time are removed, so a session running
 * right now is never disturbed: FFmpeg is still writing into its directory,
 * which keeps the mtime fresh.
 */
export async function pruneStaleSessionDirs({ minAgeMs = SESSION_DIR_MIN_AGE_MS } = {}) {
  const root = join(tmpdir(), SESSION_TMP_ROOT);
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0; // nothing has ever created one
  }

  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('s-')) continue;
    const dir = join(root, entry.name);
    let mtimeMs;
    try {
      mtimeMs = (await stat(dir)).mtimeMs;
    } catch {
      continue; // vanished under us, which is the outcome we wanted
    }
    if (now - mtimeMs < minAgeMs) continue;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    removed += 1;
  }
  if (removed > 0) log.info({ removed }, 'removed stale session temp directories');
  return removed;
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    try {
      socket = netConnect({ port, host: '127.0.0.1' });
    } catch {
      return resolve(false);
    }
    const done = (inUse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 500).unref?.();
  });
}
