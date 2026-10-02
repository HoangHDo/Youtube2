/**
 * Is the *producer* keeping real time at the current output settings?
 *
 * Separates a server-side problem (FFmpeg cannot encode/pace 720p in real time)
 * from a client-side one (JSMpeg cannot decode 720p in real time). They look
 * identical from the browser - the video playhead stops advancing - so the two
 * must be measured independently.
 *
 *   node tmp/producer-rate.mjs [base] [videoId] [seconds]
 */
const base = process.argv[2] ?? 'http://localhost:8080';
const video = process.argv[3] ?? 'wEUySRwbuU8';
const seconds = Number(process.argv[4] ?? 20);

const post = await fetch(`${base}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: video }),
});
const s = await post.json();
if (!post.ok) {
  console.error('create failed:', s);
  process.exit(1);
}
console.log(`session ${s.sessionId}  strategy ${s.strategy}`);

const samples = [];
const t0 = Date.now();
while (Date.now() - t0 < seconds * 1000) {
  await new Promise((r) => setTimeout(r, 1000));
  const info = await fetch(
    `${base}/api/sessions/${s.sessionId}?token=${encodeURIComponent(s.tokens.viewerToken)}`,
  ).then((r) => r.json());
  if (typeof info.videoClock !== 'number') continue;
  samples.push({ wall: Date.now(), pts: info.videoClock, bytes: info.stats.videoBytes, drop: info.stats.videoDropped });
}

await fetch(s.endpoints.stop, { method: 'DELETE' }).catch(() => {});

const first = samples[0];
const last = samples.at(-1);
const dWall = last.wall - first.wall;
const dPts = last.pts - first.pts;
const dBytes = last.bytes - first.bytes;
const stalls = samples.filter((x) => x.pts === samples[0].pts).length;
const rate = dPts / dWall;
const kbps = Math.round((dBytes * 8) / dWall);

console.log(`\nwindow              : ${(dWall / 1000).toFixed(1)}s`);
console.log(`video PTS advance   : ${dPts} ms`);
console.log(`producer rate       : ${rate.toFixed(3)}x real time   ${rate > 0.95 ? 'OK' : 'TOO SLOW'}`);
console.log(`video bitrate       : ${kbps} kbit/s`);
console.log(`bytes dropped       : ${last.drop}`);
console.log(`stalled samples     : ${stalls} of ${samples.length}`);

const verdict = rate < 0.95
  ? 'SERVER-SIDE: FFmpeg cannot produce this in real time.'
  : 'Producer is fine, so any stutter is client-side decode.';
console.log(`\n${verdict}`);
process.exit(rate < 0.95 ? 1 : 0);
