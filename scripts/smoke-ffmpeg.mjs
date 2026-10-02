/**
 * Standalone smoke test for the FFmpeg pipeline.
 *
 *   node --env-file-if-exists=.env scripts/smoke-ffmpeg.mjs [input]
 *
 * Spawns the real transcoder over a local file, then reports how much MPEG-TS
 * and MP3 came out, whether the TS clock found a video PID, and the measured
 * end-to-end latency to the first byte. No server, no browser.
 */
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transcoder, buildFfmpegArgs } from '../src/lib/ffmpeg.js';
import { TsClock } from '../src/lib/ts-clock.js';
import { childLogger } from '../src/lib/logger.js';

const input = process.argv[2] ?? 'tmp/fixture.mp4';
const log = childLogger({ mod: 'smoke' });

const dir = await mkdtemp(join(tmpdir(), 'cyberstream-smoke-'));
const tsPath = join(dir, 'out.ts');
const mp3Path = join(dir, 'out.mp3');

const tsSinks = [];
const mp3Sinks = [];
const tsStream = (await import('node:fs')).createWriteStream(tsPath);
const mp3Stream = (await import('node:fs')).createWriteStream(mp3Path);
tsSinks.push(tsStream);
mp3Sinks.push(mp3Stream);

const clock = new TsClock(({ ptsMs }) => {
  if (clock.first === undefined) clock.first = ptsMs;
});

const t0 = Date.now();
let firstVideoMs = null;
let firstAudioMs = null;
let videoBytes = 0;
let audioBytes = 0;
let done = null;

// A local file behaves like a progressive (muxed) source: one input, both
// tracks mapped out of it.
const sources = { muxed: true, video: { url: input, headers: {} } };

const transcoder = new Transcoder({
  sources,
  durationMs: 0, // no -re, so a short fixture finishes fast
  log,
  sessionId: 'smoke',
});

transcoder.on('video', (chunk) => {
  if (firstVideoMs === null) firstVideoMs = Date.now() - t0;
  videoBytes += chunk.length;
  clock.push(chunk);
  tsStream.write(chunk);
});
transcoder.on('audio', (chunk) => {
  if (firstAudioMs === null) firstAudioMs = Date.now() - t0;
  audioBytes += chunk.length;
  mp3Stream.write(chunk);
});
transcoder.on('log', (line) => log.debug({ line }, 'ffmpeg'));
transcoder.on('fatal', (err) => {
  log.error({ err: err.message }, 'fatal');
  done?.(err);
});
transcoder.on('done', () => done?.(null));

process.stderr.write(`args: ${buildFfmpegArgs({ sources }).join(' ')}\n\n`);

const strategy = await transcoder.start();
log.info({ strategy }, 'started');

const watchdog = setTimeout(() => {
  transcoder.stop('smoke-timeout');
  done?.(new Error('timed out after 25s'));
}, 25_000);

await new Promise((resolve) => {
  done = (err) => {
    if (err) log.warn({ err: err.message }, 'smoke ended early');
    resolve();
  };
});
clearTimeout(watchdog);

for (const s of [...tsSinks, ...mp3Sinks]) await new Promise((r) => s.end(r));

const [tsStat, mp3Stat] = await Promise.all([stat(tsPath).catch(() => null), stat(mp3Path).catch(() => null)]);
const tsHead = tsStat ? (await readFile(tsPath)).subarray(0, 4) : null;

console.log('\n================ smoke result ================');
console.log(`strategy        : ${strategy}`);
console.log(`first video byte: ${firstVideoMs} ms`);
console.log(`first audio byte: ${firstAudioMs} ms`);
console.log(`video bytes     : ${videoBytes} (${(videoBytes / 1024).toFixed(1)} KiB)`);
console.log(`audio bytes     : ${audioBytes} (${(audioBytes / 1024).toFixed(1)} KiB)`);
console.log(`ts file         : ${tsStat?.size ?? 0} bytes, first byte = 0x${tsHead?.[0].toString(16)}`);
console.log(`mp3 file        : ${mp3Stat?.size ?? 0} bytes`);
console.log(`ts clock stats  : ${JSON.stringify(clock.stats)}`);
console.log(`video pts (ms)  : ${clock.first ?? 'n/a'}`);
console.log('=============================================\n');

await rm(dir, { recursive: true, force: true });

if (videoBytes === 0 || audioBytes === 0) {
  console.error('SMOKE FAILED: no output');
  process.exit(1);
}
if (tsHead?.[0] !== 0x47) {
  console.error('SMOKE FAILED: MPEG-TS sync byte missing');
  process.exit(1);
}
if (clock.first === undefined) {
  console.error('SMOKE FAILED: TS clock never found a video PTS');
  process.exit(1);
}
console.log('SMOKE OK');
void writeFile;
