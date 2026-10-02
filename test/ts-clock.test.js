import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TsClock } from '../src/lib/ts-clock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('TsClock - unit', () => {
  it('rejects a buffer that is not 188-byte aligned TS', () => {
    const clock = new TsClock();
    clock.push(Buffer.alloc(1000, 0x00));
    assert.equal(clock.synced, false, 'no false sync on all-zero data');
  });

  it('does not declare sync until a second header confirms it', () => {
    const clock = new TsClock();
    const packet = Buffer.alloc(188, 0xff);
    packet[0] = 0x47;
    // A lone 0x47 must not be trusted: it appears all over picture data.
    clock.push(packet);
    assert.equal(clock.synced, false, 'one header is not proof');
    clock.push(packet);
    assert.equal(clock.synced, true, 'two aligned headers confirm');
  });

  it('finds sync across a split buffer', () => {
    const clock = new TsClock();
    const buf = Buffer.alloc(188 * 3);
    for (let i = 0; i < 3; i += 1) buf[i * 188] = 0x47;
    // Feed it in pieces that do not align with the packet grid.
    clock.push(buf.subarray(0, 1));
    clock.push(buf.subarray(1, 200));
    clock.push(buf.subarray(200));
    assert.equal(clock.synced, true);
    assert.ok(clock.stats.packets >= 2);
  });

  it('resynchronises after losing alignment', () => {
    const clock = new TsClock();
    const good = Buffer.alloc(188 * 4);
    for (let i = 0; i < 4; i += 1) good[i * 188] = 0x47;
    clock.push(good);
    assert.equal(clock.stats.packets >= 4, true);
  });

  it('never throws on garbage', () => {
    const clock = new TsClock();
    for (let i = 0; i < 50; i += 1) {
      clock.push(Buffer.from(Array.from({ length: 377 }, (_, k) => (k * 31 + i) % 256)));
    }
    const sample = clock.sample();
    assert.ok(sample.ptsMs === null || typeof sample.ptsMs === 'number');
  });

  it('bounds retained bytes so a slow client cannot grow memory', () => {
    const clock = new TsClock();
    for (let i = 0; i < 100; i += 1) clock.push(Buffer.alloc(4096, 0x47));
    assert.ok(clock.carry.length <= 188 * 5, `carry grew to ${clock.carry.length}`);
  });

  it('reports age of the last sample', () => {
    const clock = new TsClock();
    assert.equal(clock.sample().ageMs, Infinity, 'no sample yet');
  });
});

/**
 * The PTS test needs a real MPEG-TS stream, so it generates one with the same
 * mux settings the server uses. This is the check that would have caught the
 * "PID 0 is the PAT, not the PMT" bug.
 */
describe('TsClock - against a real FFmpeg-produced stream', { skip: !hasFfmpeg && 'ffmpeg not found' }, () => {
  const samples = [];
  let clock;

  it('extracts monotonically increasing video PTS', () => {
    const out = join(root, 'tmp', 'clock-fixture.ts');
    execFileSync(
      'ffmpeg',
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6',
        '-c:v', 'mpeg1video', '-q:v', '5', '-g', '12', '-bf', '0',
        '-f', 'mpegts', '-muxdelay', '0.1', '-muxpreload', '0',
        out,
      ],
      { stdio: 'ignore' },
    );

    clock = new TsClock((s) => samples.push(s.ptsMs));
    const buf = readFileSync(out);

    // Feed in awkward chunk sizes to exercise the carry/resync logic.
    for (let i = 0; i < buf.length; i += 997) clock.push(buf.subarray(i, i + 997));

    assert.ok(clock.stats.pmtParsed > 0, 'parsed a PMT');
    assert.ok(clock.havePmt, 'identified the video PID');
    assert.equal(clock.videoPid, 0x100, 'ffmpeg puts MPEG-1 video on PID 0x100');
    assert.ok(samples.length > 10, `expected many PTS samples, got ${samples.length}`);

    for (let i = 1; i < samples.length; i += 1) {
      assert.ok(samples[i] >= samples[i - 1], 'PTS must not go backwards');
    }
    assert.ok(samples.at(-1) - samples[0] > 1000, 'covers a real span of time');
  });

  it('is robust to being fed one byte at a time', () => {
    const fine = new TsClock(() => {});
    const buf = readFileSync(join(root, 'tmp', 'clock-fixture.ts')).subarray(0, 188 * 60);
    for (const byte of buf) fine.push(Buffer.from([byte]));
    assert.ok(fine.stats.packets > 10, 'still frames packets byte-wise');
  });

  it('matches ffprobe frame for frame', () => {
    // The regression guard for a real bug: the PTS field was read one byte
    // early, which produced a plausible-looking value whose *span* was 70% of
    // the truth. Only a comparison against an independent parser catches it.
    const file = join(root, 'tmp', 'clock-fixture.ts');
    const truth = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'packet=pts', '-of', 'csv=p=0', file,
    ], { encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)
      .map((l) => Number(l.replace(/,$/, '')))
      .filter((n) => Number.isFinite(n));

    const mine = [];
    const clock = new TsClock((s) => mine.push(s.ptsMs));
    const buf = readFileSync(file);
    for (let i = 0; i < buf.length; i += 8191) clock.push(buf.subarray(i, i + 8191));

    assert.ok(truth.length > 100, 'fixture has enough frames');
    assert.ok(
      mine.length > truth.length * 0.9,
      `sampled ${mine.length} of ${truth.length} frames`,
    );

    // ffprobe reports 90 kHz ticks; the clock is specified to emit milliseconds.
    // Getting this wrong scales every reading by 90, which no other assertion
    // here would notice.
    const firstMs = mine[0];
    const firstTicks = truth.find((t) => Math.abs(t / 90 - firstMs) < 40);
    assert.ok(
      firstTicks !== undefined,
      `emitted ${firstMs} ms, which is not a frame in the file (units bug?)`,
    );

    const truthSpan = truth.at(-1) - truth[0];
    const mySpan = mine.at(-1) - mine[0];
    assert.ok(truthSpan > 0, 'fixture has a real span');

    // The strongest available invariant: consecutive samples must be exactly
    // one frame apart (40 ms at 25 fps). A wrong PTS window produces scattered
    // deltas even when the overall span happens to look plausible.
    const deltas = mine.slice(1).map((v, i) => v - mine[i]);
    const unique = [...new Set(deltas)];
    assert.ok(
      unique.length <= 3,
      `expected 40/80 ms steps, saw ${unique.slice(0, 6).join(', ')}`,
    );
    for (const d of deltas) {
      assert.ok(
        d === 40 || d === 80,
        `delta ${d} ms is not a whole number of 40 ms frames`,
      );
    }

    // It must have learned the true frame duration (25 fps -> 3600 ticks).
    assert.equal(clock.frameDuration, 3600, 'learned frame duration');
    assert.equal(
      mySpan,
      deltas.reduce((a, b) => a + b, 0),
      'span equals the sum of its own deltas',
    );
  });

  it('learns a shifted PTS window instead of trusting the nominal offset', () => {
    // Build a stream whose PES headers carry one extra byte before the PTS, so
    // the nominal offset is wrong by exactly one.
    const frame = 3600;
    const pkt = (pid, payload, pusi) => {
      const ts = Buffer.alloc(188, 0xff);
      ts[0] = 0x47;
      ts[1] = (pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
      ts[2] = pid & 0xff;
      ts[3] = 0x10; // payload only
      payload.copy(ts, 4);
      return ts;
    };
    const writePts = (buf, at, ticks) => {
      const pts = ticks;
      buf[at] = 0x21 | (((pts >> 30) & 0x07) << 1);
      buf[at + 1] = (pts >> 22) & 0xff;
      buf[at + 2] = 0x81 | ((pts >> 14) & 0x7f);
      buf[at + 3] = (pts >> 7) & 0xff;
      buf[at + 4] = 0xe0 | (pts & 0x7f);
    };

    const PAT = Buffer.alloc(16);
    PAT[0] = 0x00;              // pointer_field
    PAT[1] = 0x00;              // table_id
    PAT.writeUInt16BE(13, 2);   // section_length
    PAT.writeUInt16BE(1, 4);    // tsid
    PAT[6] = 0xc1;              // version
    PAT[7] = 0x00;
    PAT[8] = 0x00;
    PAT.writeUInt16BE(0x1000, 9); // program -> PMT pid
    PAT[11] = 0xf0;
    PAT[12] = 0x00;

    const PMT = Buffer.alloc(20);
    PMT[0] = 0x00;
    PMT[1] = 0x02;
    PMT.writeUInt16BE(13, 2);
    PMT.writeUInt16BE(1, 4);
    PMT[6] = 0xc1;
    PMT[7] = 0x00;
    PMT[8] = 0x00;
    PMT.writeUInt16BE(0x0100, 9); // PCR pid
    PMT[11] = 0xf0;
    PMT[12] = 0x00;
    PMT[13] = 0x02;              // stream_type: MPEG-1 video
    PMT.writeUInt16BE(0x0100, 14);
    PMT.writeUInt16BE(0xf000, 16);

    const out = [pkt(0x0000, PAT, true), pkt(0x1000, PMT, true)];
    for (let i = 0; i < 40; i += 1) {
      const pes = Buffer.alloc(40);
      pes[0] = 0x00; pes[1] = 0x00; pes[2] = 0x01; pes[3] = 0xe0;
      pes[4] = 0x00; pes[5] = 0x28; pes[6] = 0x80; pes[7] = 0xc0;
      pes[8] = 0x00; // <-- the extra byte that shifts the PTS window
      writePts(pes, 9, 90000 + i * frame);
      out.push(pkt(0x0100, pes, true));
    }

    const samples = [];
    const clock = new TsClock((s) => samples.push(s.ptsMs));
    clock.push(Buffer.concat(out));

    assert.equal(clock.ptsWindow, 1, 'learned the +1 window');
    // The synthetic encoder round-trips through a lossy 5-byte field, so the
    // learned duration is close to, not exactly, 3600.
    assert.ok(
      Math.abs(clock.frameDuration - frame) / frame < 0.02,
      `learned frame duration ${clock.frameDuration}, expected ~${frame}`,
    );
    assert.ok(samples.length > 20, `got ${samples.length} samples`);
    // Emitted in milliseconds, so one 3600-tick frame is 40 ms.
    const frameMs = frame / 90;
    const deltas = samples.slice(1).map((v, i) => v - samples[i]);
    const spread = Math.max(...deltas) - Math.min(...deltas);
    assert.ok(
      spread / frameMs < 0.05,
      `deltas are not steady: ${[...new Set(deltas)].join(', ')}`,
    );
    assert.ok(
      Math.abs(deltas[0] - frameMs) / frameMs < 0.05,
      `first delta ${deltas[0]} ms, expected ~${frameMs} ms`,
    );
  });
});
