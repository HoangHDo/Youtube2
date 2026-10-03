import { spawn } from 'node:child_process';
import { createWriteStream, createReadStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../config/index.js';
import { childLogger } from './logger.js';

/**
 * Optional bootstrap for yt-dlp on hosts where it cannot be installed.
 *
 * ## Why this exists
 *
 * Some hosts default a Node service to their *own* runtime rather than building
 * the repository's Dockerfile - Render does this, running `npm start`. The image
 * that installs yt-dlp is never built, so yt-dlp is absent and every YouTube URL
 * fails, while the deploy itself reports success and the dashboard loads fine.
 *
 * The real fix is to deploy the Dockerfile. This is the fallback for when that is
 * not available: yt-dlp publishes a single self-contained Linux executable that
 * needs no Python, so it can be fetched once into a cache directory and used.
 *
 * ## Why it is opt-in
 *
 * This downloads an executable and runs it, so it is **off by default** and must
 * be enabled deliberately with `YT_DLP_BOOTSTRAP=1`. A bundled image does not
 * need it and should not use it.
 *
 * Even when enabled it is pinned: one version, one URL, and - if
 * `YT_DLP_BOOTSTRAP_SHA256` is set - the download is rejected unless it hashes to
 * that value. With no checksum configured the digest is logged, so it can be
 * pinned after a first run rather than trusted indefinitely.
 *
 * ## Cache
 *
 * Fetched once into `<tmp>/cyberstream/bin/yt-dlp` and reused. The file is
 * written under a `.part` name and renamed into place, so a crashed or concurrent
 * boot cannot leave a half-written binary, and a failed download leaves nothing
 * behind.
 */

const log = childLogger({ mod: 'ytdlp' });

/** Pinned deliberately: bump this (and the checksum) to upgrade. */
export const DEFAULT_BOOTSTRAP_VERSION = '2026.08.19';

const DOWNLOAD_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 5000;

export function bootstrapEnabled() {
  return process.env.YT_DLP_BOOTSTRAP === '1';
}

/**
 * Path to the yt-dlp that should actually be executed.
 *
 * `config.youtube.ytDlpPath` is frozen, and the bootstrap may legitimately want
 * to point somewhere else, so the override lives here and every caller reads
 * this instead. Without a single accessor the resolver and the doctor would keep
 * using the configured path and fail even after a successful bootstrap - which
 * would look exactly like the bootstrap not having happened.
 */
let override = null;

export function activeYtDlpPath() {
  return override ?? config.youtube.ytDlpPath;
}

function expectedSha256() {
  const raw = (process.env.YT_DLP_BOOTSTRAP_SHA256 ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    throw new Error('YT_DLP_BOOTSTRAP_SHA256 must be 64 hex characters');
  }
  return raw;
}

function cacheFile() {
  const dir = process.env.YT_DLP_BOOTSTRAP_DIR
    || join(tmpdir(), 'cyberstream', 'bin');
  return join(dir, 'yt-dlp');
}

function downloadUrl(version) {
  return `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/yt-dlp`;
}

/** Can this path be executed? True only if it runs and prints a version. */
function probe(path) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(path, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
      });
    } catch {
      resolve(false);
      return;
    }
    let out = '';
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0 && /\d/.test(out)));
  });
}

async function isUsableFile(path) {
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/**
 * Resolves the yt-dlp executable, downloading it if enabled and absent.
 *
 * Returns the configured path unchanged in every normal case, so this is a no-op
 * for a bundled image and for anyone who already has yt-dlp installed.
 *
 * @returns {Promise<string>} path to an executable yt-dlp
 */
export async function resolveYtDlpBinary() {
  const configured = config.youtube.ytDlpPath;

  // Disabled: hand back exactly what was configured, no filesystem probing and
  // no network. This is the path every bundled deployment takes.
  if (!bootstrapEnabled()) return configured;

  // Already working: never download over a working install.
  if (await probe(configured)) return configured;

  const file = cacheFile();
  if (await isUsableFile(file) && await probe(file)) {
    override = file;
    log.info({ file }, 'reusing a previously bootstrapped yt-dlp');
    return file;
  }

  const version = process.env.YT_DLP_BOOTSTRAP_VERSION || DEFAULT_BOOTSTRAP_VERSION;
  const want = expectedSha256();
  const url = downloadUrl(version);
  log.info({ version, url }, 'yt-dlp is not installed; bootstrapping it');

  await mkdir(join(file, '..'), { recursive: true });
  const part = `${file}.${process.pid}.part`;

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));

    const got = createHash('sha256').update(await readFile(part)).digest('hex');
    if (want && got !== want) {
      throw new Error(`checksum mismatch: expected ${want}, got ${got}`);
    }
    if (!want) {
      // Trust-on-first-use: at least make the digest visible so it can be
      // pinned afterwards rather than being trusted blindly forever.
      log.warn(
        { sha256: got },
        'yt-dlp downloaded without checksum verification; pin YT_DLP_BOOTSTRAP_SHA256',
      );
    }

    await chmod(part, 0o755);
    await rename(part, file).catch((err) => {
      // Losing a race with a concurrent boot is fine: its file is equivalent.
      if (err?.code !== 'EEXIST' && err?.code !== 'EPERM') throw err;
    });

    override = file;
    log.info({ file, sha256: got }, 'yt-dlp bootstrapped');
    return file;
  } catch (err) {
    await rm(part, { force: true }).catch(() => {});
    log.error({ err: err.message, version }, 'yt-dlp bootstrap failed');
    throw err;
  }
}

/** Exposed for tests: does the cache already hold something runnable? */
export async function cachedBootstrap() {
  const file = cacheFile();
  return (await isUsableFile(file)) ? file : null;
}

/** Streams the cached file, so tests can hash it without shelling out. */
export function readCached() {
  return createReadStream(cacheFile());
}