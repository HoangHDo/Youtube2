/**
 * Bootstraps the external binaries CyberStream shells out to.
 *
 *   node scripts/install-tools.mjs           # download yt-dlp into ./bin
 *   node scripts/install-tools.mjs --check   # only report what is available
 *
 * FFmpeg is *not* installed here: it is a system dependency. Use your package
 * manager, or use the bundled Docker image (see Dockerfile).
 */
import { spawn } from 'node:child_process';
import { mkdir, chmod, writeFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arch, platform } from 'node:os';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const binDir = join(root, 'bin');
const checkOnly = process.argv.includes('--check');

const EXE = platform() === 'win32' ? '.exe' : '';
const YT_DLP = `yt-dlp${EXE}`;

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => resolve({ code: -1, out: `${cmd}: ${err.message}` }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function version(cmd, args = ['-version']) {
  const { code, out } = await run(cmd, args);
  if (code !== 0) return null;
  return out.split(/\r?\n/)[0].trim();
}

async function downloadYtDlp() {
  await mkdir(binDir, { recursive: true });
  const target = join(binDir, YT_DLP);
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp${EXE}`;
  process.stdout.write(`downloading ${url}\n`);

  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'cyberstream-setup' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 100_000) throw new Error('suspiciously small payload');
  await writeFile(target, bytes);
  if (platform() !== 'win32') await chmod(target, 0o755);
  const { size } = await stat(target);
  process.stdout.write(`installed ${target} (${(size / 1e6).toFixed(1)} MB)\n`);
}

async function main() {
  const ffmpeg = await version('ffmpeg', ['-hide_banner', '-version']);
  const ytdlpLocal = await version(join(binDir, YT_DLP), ['--version']);
  const ytdlpSystem = await version('yt-dlp', ['--version']);

  process.stdout.write(`platform      : ${platform()}/${arch()}\n`);
  process.stdout.write(`ffmpeg        : ${ffmpeg ?? 'NOT FOUND (install it, or use Docker)'}\n`);
  process.stdout.write(
    `yt-dlp (bin/)  : ${ytdlpLocal ?? 'not installed'}\n`,
  );
  process.stdout.write(
    `yt-dlp (PATH)  : ${ytdlpSystem ?? 'not found'}\n`,
  );

  if (checkOnly) return;

  if (!ytdlpLocal && !ytdlpSystem) {
    try {
      await downloadYtDlp();
    } catch (err) {
      process.stdout.write(
        `\nCould not download yt-dlp: ${err.message}\n` +
          'Install it manually (pip install yt-dlp / brew install yt-dlp /\n' +
          'choco install yt-dlp) or set YT_DLP_PATH in .env.\n' +
          'Without it only direct media URLs can be streamed.\n',
      );
      return;
    }
  }

  // Prefer the local copy, then the system one.
  const chosen = ytdlpLocal ?? ytdlpSystem;
  if (chosen) {
    process.stdout.write(
      `\nAdd this to your .env when the local copy is used:\n` +
        `YT_DLP_PATH=${ytdlpLocal ? './bin/' + YT_DLP : 'yt-dlp'}\n`,
    );
  }

  // Housekeeping: never leave a half-written binary behind.
  if (!ytdlpLocal && ytdlpSystem) await rm(binDir, { recursive: true, force: true });
}

main().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exitCode = 1;
});
