/** End-to-end check against a running server: real session, both transports. */
import { WebSocket } from 'ws';

const base = process.env.BASE ?? 'http://localhost:8080';
const url = process.argv[2] ?? 'aqz-KE-bpKQ';

const res = await fetch(`${base}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url }),
});
const s = await res.json();
if (!res.ok) {
  console.error('create failed:', s);
  process.exit(1);
}
console.log(`session  : ${s.sessionId}`);
console.log(`title    : ${s.title}`);
console.log(`strategy : ${s.strategy}  splitSource=${s.splitSource}`);
console.log(`duration : ${s.duration}s  missingTracks=${JSON.stringify(s.missingTracks)}`);

// --- video over WebSocket ---
const ws = new WebSocket(s.endpoints.video);
let videoBytes = 0;
let packets = 0;
let misaligned = 0;
let firstByteMs = 0;
let firstBadOffset = null;
const t0 = Date.now();

await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});

// WebSocket messages are NOT 188-byte aligned, so alignment has to be checked
// against the absolute stream offset: the muxer's first packet is at offset 0,
// therefore packet k always starts at k*188.
let offset = 0;
ws.on('message', (data, isBinary) => {
  if (!isBinary) return;
  const buf = Buffer.from(data);
  if (firstByteMs === 0) firstByteMs = Date.now() - t0;
  videoBytes += buf.length;

  const start = offset % 188;
  if (start !== 0) {
    misaligned += 1;
    if (firstBadOffset === null) firstBadOffset = offset;
  }
  for (let i = start; i < buf.length; i += 188) {
    if (buf[i] !== 0x47) {
      misaligned += 1;
      if (firstBadOffset === null) firstBadOffset = offset + i;
      break;
    }
    packets += 1;
  }
  offset += buf.length;
});

// --- audio over HTTP ---
const audioRes = await fetch(s.endpoints.audio);
const reader = audioRes.body.getReader();
let audioBytes = 0;
let firstAudio = 0;
let mp3Sync = false;

const audioDone = (async () => {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!firstAudio) firstAudio = Date.now() - t0;
    audioBytes += value.length;
    if (!mp3Sync) mp3Sync = value[0] === 0xff && (value[1] & 0xe0) === 0xe0;
  }
})();

await new Promise((r) => setTimeout(r, 8000));
ws.close();
await reader.cancel().catch(() => {});
await audioDone.catch(() => {});

// --- stop ---
await fetch(s.endpoints.stop, { method: 'DELETE' });

console.log('\n--- results ---');
console.log(`video first byte : ${firstByteMs} ms`);
console.log(`video bytes      : ${(videoBytes / 1024).toFixed(1)} KiB`);
console.log(
  `TS packets       : ${packets} valid, ${misaligned} misaligned` +
    (firstBadOffset === null ? ' (188-byte grid verified)' : ` first bad at ${firstBadOffset}`),
);
console.log(`audio first byte : ${firstAudio} ms`);
console.log(`audio bytes      : ${(audioBytes / 1024).toFixed(1)} KiB`);
console.log(`mp3 frame sync   : ${mp3Sync}`);

const ok =
  videoBytes > 100_000 && packets > 500 && audioBytes > 20_000 && misaligned === 0 && mp3Sync;
console.log(ok ? '\nE2E OK' : '\nE2E FAILED');
process.exit(ok ? 0 : 1);
