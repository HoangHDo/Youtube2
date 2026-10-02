import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildFfmpegArgs,
  buildFfmpegSections,
  buildHeaderArg,
  buildVideoFilter,
  mpeg1FrameRate,
  QUALITY_PRESETS,
  videoConfigFor,
} from '../src/lib/ffmpeg.js';
import { config } from '../src/config/index.js';

const MUXED = {
  muxed: true,
  video: { url: 'https://cdn.example/video.mp4', headers: {} },
};

const SPLIT = {
  muxed: false,
  video: { url: 'https://cdn.example/v.mp4', headers: { 'user-agent': 'V' } },
  audio: { url: 'https://cdn.example/a.webm', headers: { 'user-agent': 'A' } },
};

describe('buildFfmpegArgs', () => {
  it('produces one input and two outputs in a single process', () => {
    const args = buildFfmpegArgs({ sources: MUXED });
    assert.equal(args.filter((a) => a === '-i').length, 1);
    assert.ok(args.includes('mpeg1video'), 'MPEG-1 video encoder');
    assert.ok(args.includes('mpegts'), 'MPEG-TS muxer');
    assert.ok(args.includes('libmp3lame'), 'MP3 encoder');
    assert.ok(args.includes('mp3'), 'MP3 muxer');
  });

  it('targets fd 3 for video and fd 4 for audio in multi-pipe mode', () => {
    const args = buildFfmpegArgs({ sources: MUXED });
    assert.ok(args.includes('pipe:3'));
    assert.ok(args.includes('pipe:4'));
  });

  it('maps each output to the right stream', () => {
    const args = buildFfmpegArgs({ sources: MUXED });
    const videoMap = args.indexOf('0:v:0');
    const audioMap = args.indexOf('0:a:0?');
    const tsTarget = args.indexOf('pipe:3');
    const mp3Target = args.indexOf('pipe:4');
    assert.ok(videoMap < tsTarget, 'video map precedes its muxer');
    assert.ok(tsTarget < audioMap, 'audio map starts after the video output');
    assert.ok(audioMap < mp3Target, 'audio map precedes its muxer');
  });

  it('maps input 1 for audio when the source is split', () => {
    const args = buildFfmpegArgs({ sources: SPLIT });
    assert.equal(args.filter((a) => a === '-i').length, 2, 'two inputs');
    assert.ok(args.includes('0:v:0'), 'video comes from input 0');
    assert.ok(args.includes('1:a:0?'), 'audio comes from input 1');
  });

  it('repeats -headers before each input, since it is an input option', () => {
    const args = buildFfmpegArgs({ sources: SPLIT });
    const headers = args.map((a, i) => (a === '-headers' ? i : -1)).filter((i) => i >= 0);
    assert.equal(headers.length, 2, 'one -headers per input');
    for (const at of headers) {
      const inputAt = args.indexOf('-i', at);
      assert.ok(inputAt > at && inputAt - at <= 2, 'header is immediately before its -i');
    }
  });

  it('tolerates sources with no audio track', () => {
    assert.ok(buildFfmpegArgs({ sources: MUXED }).includes('0:a:0?'), 'trailing ? makes the map optional');
  });

  it('handles a video-only split source', () => {
    const args = buildFfmpegArgs({ sources: { ...SPLIT, audio: null } });
    assert.ok(args.includes('0:a:0?'), 'falls back to input 0 optional audio');
  });

  it('disables B-frames to avoid reordering latency', () => {
    const args = buildFfmpegArgs({ sources: MUXED });
    assert.equal(args[args.indexOf('-bf') + 1], '0');
  });

  it('emits a keyframe every GOP frames to bound resync time', () => {
    const args = buildFfmpegArgs({ sources: MUXED });
    const gop = args[args.indexOf('-g') + 1];
    assert.equal(gop, args[args.indexOf('-keyint_min') + 1]);
    assert.equal(args[args.indexOf('-sc_threshold') + 1], '0', 'no scene-cut keyframes');
  });

  it('uses low-delay flags, not discardcorrupt as a codec flag', () => {
    const args = buildFfmpegArgs({ sources: MUXED });
    // discardcorrupt belongs to -fflags; putting it in -flags aborts decoding.
    assert.equal(args[args.indexOf('-flags') + 1], 'low_delay');
    assert.ok(args[args.indexOf('-fflags') + 1].includes('discardcorrupt'));
  });

  it('never sets -fflags +nobuffer, which empties the output', () => {
    // Verified empirically: on FFmpeg 8.x, `+nobuffer` starves the muxer and
    // the MPEG-TS output is 0 bytes while FFmpeg still exits 0.
    for (const args of [
      buildFfmpegArgs({ sources: MUXED }),
      buildFfmpegArgs({ sources: SPLIT }),
      buildFfmpegArgs({ sources: MUXED, durationMs: 30_000 }),
    ]) {
      assert.ok(!args[args.indexOf('-fflags') + 1].includes('nobuffer'));
    }
  });

  it('paces a known-length source in real time and does not pace a live one', () => {
    // Without -re a transcoder races ahead and dumps the whole video at once.
    assert.ok(buildFfmpegArgs({ sources: MUXED, durationMs: 30_000 }).includes('-re'));
    assert.ok(!buildFfmpegArgs({ sources: MUXED, durationMs: 0 }).includes('-re'));
  });

  it('applies -re to each input of a split source', () => {
    const sections = buildFfmpegSections({ sources: SPLIT, durationMs: 30_000 });
    const inputs = sections.input.filter((a) => a === '-i').length;
    assert.equal(inputs, 2);
    // One -re per input, and each must precede its own -i.
    const res = sections.input.map((a, i) => (a === '-re' ? i : -1)).filter((i) => i >= 0);
    assert.equal(res.length, 2);
    for (const at of res) {
      assert.ok(sections.input.indexOf('-i', at) > at, '-re precedes -i');
    }
  });

  it('adds reconnect options for remote inputs only', () => {
    assert.ok(buildFfmpegArgs({ sources: MUXED }).includes('-reconnect'));
    const local = buildFfmpegArgs({
      sources: { muxed: true, video: { url: 'C:/tmp/file.mp4', headers: {} } },
    });
    assert.ok(!local.includes('-reconnect'), 'a local file cannot reconnect');
  });

  it('rejects inputs that could be read as options', () => {
    assert.throws(
      () => buildFfmpegArgs({ sources: { muxed: true, video: { url: '-i evil.mp4' } } }),
      /option-like/,
    );
  });

  it('rejects control characters and empty input', () => {
    assert.throws(
      () => buildFfmpegArgs({ sources: { muxed: true, video: { url: 'a\nb' } } }),
      /control characters/,
    );
    assert.throws(
      () => buildFfmpegArgs({ sources: { muxed: true, video: { url: '' } } }),
      /empty input/,
    );
    assert.throws(
      () => buildFfmpegArgs({ sources: { muxed: true, video: { url: 'x'.repeat(5000) } } }),
      /too long/,
    );
  });

  it('rejects a malformed sources object', () => {
    assert.throws(() => buildFfmpegArgs({ sources: null }), /no sources/);
    assert.throws(() => buildFfmpegArgs({ sources: { muxed: true } }), /empty input/);
  });

  it('never quotes or escapes: argv is passed through verbatim', () => {
    const args = buildFfmpegArgs({
      sources: { muxed: true, video: { url: 'https://h/a b.mp4?x=1&y=2' } },
    });
    const i = args.indexOf('-i');
    assert.equal(args[i + 1], 'https://h/a b.mp4?x=1&y=2', 'one argv element, no shell quoting');
  });
});

describe('buildFfmpegSections', () => {
  it('splits into input, video and audio sections', () => {
    const s = buildFfmpegSections({ sources: MUXED, videoTarget: 'pipe:1', audioTarget: 'pipe:2' });
    assert.deepEqual(s.videoOutput.slice(-1), ['pipe:1']);
    assert.deepEqual(s.audioOutput.slice(-1), ['pipe:2']);
    assert.ok(s.input.includes('-i'));
  });

  it('gives each dual-process output only the input it maps', () => {
    // The Windows fallback runs two processes. Each must read just its own
    // stream: sharing one input section would make the audio process probe and
    // pace against the video stream too.
    const video = buildFfmpegSections({
      sources: SPLIT, videoTarget: 'pipe:1', mode: 'video',
    });
    const audio = buildFfmpegSections({
      sources: SPLIT, audioTarget: 'pipe:1', mode: 'audio',
    });

    assert.equal(video.input.filter((a) => a === '-i').length, 1);
    assert.equal(audio.input.filter((a) => a === '-i').length, 1);
    assert.ok(video.input.includes('https://cdn.example/v.mp4'));
    assert.ok(audio.input.includes('https://cdn.example/a.webm'));
    assert.ok(video.videoOutput.includes('0:v:0'));
    // In dual mode the audio is the only input, so it maps from index 0.
    assert.ok(audio.audioOutput.includes('0:a:0?'));
  });

  it('keeps both inputs in single-process mode', () => {
    const s = buildFfmpegSections({ sources: SPLIT, durationMs: 30_000 });
    assert.equal(s.input.filter((a) => a === '-i').length, 2);
    assert.ok(s.videoOutput.includes('0:v:0'));
    assert.ok(s.audioOutput.includes('1:a:0?'), 'audio maps from the second input');
  });

  it('accepts the older single-url form', () => {
    const s = buildFfmpegSections({ sources: { url: 'x.mp4', headers: {} } });
    assert.ok(s.input.includes('x.mp4'));
    assert.ok(s.audioOutput.includes('0:a:0?'));
  });

  it('places -t after the inputs so it caps the output, not the input', () => {
    const s = buildFfmpegSections({ sources: SPLIT, durationMs: 5000 });
    const t = s.input.indexOf('-t');
    assert.ok(t > s.input.lastIndexOf('-i'), '-t follows every -i');
  });
});

describe('buildHeaderArg', () => {
  it('joins headers with CRLF and terminates the last line', () => {
    const arg = buildHeaderArg({ 'user-agent': 'UA/1.0', referer: 'https://x/' });
    assert.equal(arg, 'user-agent: UA/1.0\r\nreferer: https://x/\r\n');
  });

  it('strips CR/LF so a header cannot inject extra directives', () => {
    const arg = buildHeaderArg({ 'user-agent': 'UA\r\nX-Evil: 1' });
    const lines = arg.split('\r\n');
    // The text is still present, but flattened onto the single value line...
    assert.ok(arg.includes('X-Evil: 1'));
    // ...so it can never become a directive of its own.
    assert.equal(lines.filter((l) => /^x-evil/i.test(l)).length, 0);
    assert.equal(lines.length, 2, 'exactly one header line plus the terminator');
  });

  it('drops header names that are not tokens', () => {
    assert.equal(buildHeaderArg({ 'bad header': 'x' }), '');
    assert.equal(buildHeaderArg({ 'x-y': 42 }), '');
  });

  it('returns an empty string when there is nothing to send', () => {
    assert.equal(buildHeaderArg({}), '');
    assert.equal(buildHeaderArg(), '');
  });
});

describe('buildVideoFilter', () => {
  it('scales, fixes the frame rate and squares the pixels', () => {
    const filter = buildVideoFilter();
    assert.ok(filter.includes('scale='));
    assert.ok(filter.includes('fps='));
    assert.ok(filter.includes('setsar=1'));
  });

  it('uses no commas inside expressions, which would split the graph', () => {
    const scale = buildVideoFilter().split(',')[0];
    assert.ok(!scale.slice('scale='.length).includes(','));
  });

  it('produces even dimensions, which MPEG-1 requires', () => {
    assert.match(buildVideoFilter(), /scale=w='min\(\d+,iw\)':h='min\(\d+,ih\)'/);
  });

  it('never scales above the source resolution', () => {
    // The configured box is a ceiling, not a target. Upscaling cannot add
    // detail - it just makes the encoder spend bitrate on interpolated pixels
    // and the decoder spend CPU on more of them. `min(w,iw)` is what enforces
    // that, and it is easy to "simplify" back into a plain `scale=w:h`.
    const filter = buildVideoFilter();
    assert.ok(filter.includes("min("), 'the scale filter must clamp to the input size');
    assert.ok(
      filter.includes("min(${config.video.width},iw)") ||
        filter.includes(`min(${evenOf(config.video.width)},iw)`),
      'width must be clamped with min(w,iw)',
    );
    assert.ok(
      filter.includes("min(${config.video.height},ih)") ||
        filter.includes(`min(${evenOf(config.video.height)},ih)`),
      'height must be clamped with min(h,ih)',
    );
  });

  it('honours a per-session video config instead of the server default', () => {
    // buildFfmpegSections already accepted a `video` override, but the scale
    // filter ignored it and always read config.video, so a per-session quality
    // request silently produced the server's resolution.
    const filter = buildVideoFilter({ ...config.video, width: 426, height: 240, fps: 24 });
    assert.match(filter, /min\(426,iw\)/);
    assert.match(filter, /min\(240,ih\)/);
    assert.match(filter, /fps=24/);
  });

  it('carries the override all the way into the emitted ffmpeg args', () => {
    const sections = buildFfmpegSections({
      sources: MUXED,
      video: videoConfigFor('low'),
    });
    const filter = sections.videoOutput[sections.videoOutput.indexOf('-vf') + 1];
    const p = QUALITY_PRESETS.low;
    assert.ok(filter.includes(`min(${p.width},iw)`), `filter was: ${filter}`);
    assert.ok(filter.includes(`min(${p.height},ih)`), `filter was: ${filter}`);
    assert.equal(sections.videoOutput[sections.videoOutput.indexOf('-q:v') + 1], String(p.q));
  });

  it('offers 720p as the standard preset and 1080p as high', () => {
    // 720p is the default a viewer expects; the smaller preset is the escape
    // hatch for a machine that cannot hold it.
    assert.equal(QUALITY_PRESETS.standard.width, 1280);
    assert.equal(QUALITY_PRESETS.standard.height, 720);
    assert.equal(QUALITY_PRESETS.high.width, 1920);
    assert.ok(
      QUALITY_PRESETS.low.width < QUALITY_PRESETS.standard.width,
      'low must be cheaper than standard',
    );
  });

  it('defaults the server to 720p', () => {
    assert.equal(config.video.width, 1280);
    assert.equal(config.video.height, 720);
  });
});

/** buildVideoFilter rounds dimensions down to even; mirror that in assertions. */
function evenOf(n) {
  const v = Math.trunc(Number(n) || 1280);
  return v % 2 === 0 ? v : v - 1;
}

describe('videoConfigFor', () => {
  it('returns the server default for an absent or unknown quality', () => {
    assert.equal(videoConfigFor(undefined), config.video);
    assert.equal(videoConfigFor(null), config.video);
    assert.equal(videoConfigFor('ultra'), config.video);
    assert.equal(videoConfigFor({ evil: true }), config.video);
  });

  it('applies the requested preset', () => {
    const v = videoConfigFor('high');
    assert.equal(v.q, QUALITY_PRESETS.high.q);
    assert.equal(v.gop, QUALITY_PRESETS.high.gop);
  });

  it('never exceeds the resolution ceiling the operator configured', () => {
    // The cap exists so a client cannot talk the server into a larger frame
    // than the operator allows. The ceiling is VIDEO_MAX_*, deliberately not
    // VIDEO_WIDTH/HEIGHT: those are the *default* output, and using them as the
    // ceiling silently clamped the 1080p preset back to 720p.
    for (const name of Object.keys(QUALITY_PRESETS)) {
      const v = videoConfigFor(name);
      assert.ok(
        v.width <= config.video.maxWidth,
        `${name} width ${v.width} exceeds ceiling ${config.video.maxWidth}`,
      );
      assert.ok(
        v.height <= config.video.maxHeight,
        `${name} height ${v.height} exceeds ceiling ${config.video.maxHeight}`,
      );
    }
  });

  it('keeps the ceiling at or above the default output', () => {
    // A misconfigured pair (VIDEO_MAX_WIDTH below VIDEO_WIDTH) must not make the
    // operator's own default unreachable.
    assert.ok(config.video.maxWidth >= config.video.width);
    assert.ok(config.video.maxHeight >= config.video.height);
  });

  it('lets the shipped presets actually differ', () => {
    // Regression guard: when the ceiling equalled the default, every preset
    // above the default collapsed onto it and the quality menu became a no-op.
    const shapes = new Set(
      Object.keys(QUALITY_PRESETS).map((n) => {
        const v = videoConfigFor(n);
        return `${v.width}x${v.height}`;
      }),
    );
    assert.equal(
      shapes.size,
      Object.keys(QUALITY_PRESETS).length,
      `presets collapsed to ${[...shapes].join(', ')}`,
    );
  });

  it('still accepts the pre-rename "medium" name', () => {
    // The preset was renamed medium -> standard when the default moved to 720p.
    // A client that had stored `medium` in localStorage would otherwise be
    // rejected by the API and unable to start a stream at all - the one failure
    // a user cannot work around from the UI.
    const alias = videoConfigFor('medium');
    assert.equal(alias.width, QUALITY_PRESETS.standard.width);
    assert.equal(alias.height, QUALITY_PRESETS.standard.height);
    assert.equal(alias.q, QUALITY_PRESETS.standard.q);
  });

  it('keeps every preset dimension even, as MPEG-1 requires', () => {
    for (const [name, preset] of Object.entries(QUALITY_PRESETS)) {
      assert.equal(preset.width % 2, 0, `${name} width must be even`);
      assert.equal(preset.height % 2, 0, `${name} height must be even`);
    }
  });

  it('uses frame rates that are already legal MPEG-1 rates', () => {
    // mpeg1FrameRate() snaps to the nearest of eight fixed rates, and the lowest
    // of them is 23.976. A preset asking for, say, 15 fps is silently snapped
    // *up*, producing a more expensive encode than the caller asked for - so a
    // preset must name a rate it will actually get.
    for (const [name, preset] of Object.entries(QUALITY_PRESETS)) {
      const snapped = Number(mpeg1FrameRate(preset.fps));
      assert.ok(
        Math.abs(snapped - preset.fps) < 0.001,
        `${name} asks for ${preset.fps} fps but would be encoded at ${snapped}`,
      );
    }
  });

  it('keeps the low preset genuinely cheaper than the high preset', () => {
    // Guards the ordering the menu implies. A regression here (e.g. a "low"
    // preset at the same pixel count as "high") would be invisible in the UI.
    //
    // The comparison is on *pixel count*, because that is what actually drives
    // the bitrate. Measured on this encoder at 25fps: 480p ~700 kbit/s,
    // 720p ~1600, 1080p ~3000 - while at a fixed 720p the quantiser only moved
    // the bitrate by 1.5x across its entire 1..31 range. Requiring a worse
    // quantiser as well would push the "low" preset into visibly poor quality
    // for no meaningful saving.
    const pixels = (p) => p.width * p.height;
    assert.ok(pixels(QUALITY_PRESETS.low) < pixels(QUALITY_PRESETS.standard));
    assert.ok(pixels(QUALITY_PRESETS.standard) < pixels(QUALITY_PRESETS.high));
    // The bitrate must still be strictly ordered, which is what the menu claims.
    assert.ok(QUALITY_PRESETS.low.q >= QUALITY_PRESETS.standard.q);
    assert.ok(QUALITY_PRESETS.standard.q <= QUALITY_PRESETS.high.q);
  });

  it('leaves the audio config alone', () => {
    // Quality is a video knob; changing it must not alter the MP3 settings.
    const args = buildFfmpegArgs({ sources: MUXED, video: videoConfigFor('low') });
    const b = args[args.indexOf('-b:a') + 1];
    assert.equal(b, config.audio.bitrate);
  });
});

describe('mpeg1FrameRate', () => {
  it('passes legal MPEG-1 rates through unchanged', () => {
    for (const rate of [24, 25, 30, 50, 60]) {
      assert.equal(mpeg1FrameRate(rate), String(rate));
    }
  });

  it('snaps an illegal rate to the nearest legal one', () => {
    // MPEG-1 has no 5 fps or 20 fps mode; asking for them makes the encoder
    // fail with "MPEG-1/2 does not support N fps" after the stream exists.
    const LEGAL = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
    const asNumber = (s) => Number(s);
    for (const illegal of [5, 20, 26, 100, 12]) {
      const snapped = asNumber(mpeg1FrameRate(illegal));
      assert.ok(
        LEGAL.includes(snapped),
        `${illegal} fps snapped to ${snapped}, which is not a legal MPEG-1 rate`,
      );
    }
    assert.equal(mpeg1FrameRate(26), '25');
    assert.equal(mpeg1FrameRate(100), '60');
  });

  it('keeps the NTSC rates representable', () => {
    assert.equal(mpeg1FrameRate(29.97), '29.970');
    assert.equal(mpeg1FrameRate(23.976), '23.976');
  });

  it('falls back to 25 for nonsense input', () => {
    assert.equal(mpeg1FrameRate(NaN), '25');
    assert.equal(mpeg1FrameRate(undefined), '25');
  });
});
