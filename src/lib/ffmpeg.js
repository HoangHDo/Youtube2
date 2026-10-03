/**
 * FFmpeg argument construction + process supervision.
 *
 * Design notes
 * ------------
 * * One FFmpeg process produces *both* outputs, so video and audio come out of
 *   the same decode pass: identical presentation timebase, no second process,
 *   no second download of the source, and roughly half the CPU of two
 *   processes. That matters for more than CPU - two processes have two
 *   independent start-up latencies, which leaves the audio and video live edges
 *   permanently offset by a few hundred milliseconds, and since neither
 *   transport can be rewound the browser has no way to correct it.
 *
 *   Three ways of getting two outputs out of one process are tried in order:
 *     multi-pipe  - MPEG-TS on fd 3, MP3 on fd 4 (POSIX only)
 *     dual-file   - MPEG-TS and MP3 written to two files that this process
 *                   tails; works everywhere, including Windows
 *     dual-stdout - two processes, one output each. Last resort: it is the only
 *                   option if writing two files is not permitted, and it is the
 *                   one mode where the two streams can drift apart.
 *
 *   `dual-file` writes real bytes to disk, so a session that is killed rather
 *   than shut down leaves them behind. `pruneStaleSessionDirs` in
 *   src/lib/orphan-reaper.js collects those at boot, and only ones untouched for
 *   over an hour - a live session's directory is written to continuously, so its
 *   mtime stays fresh and can never look abandoned.
 * * Arguments are always an argv array handed to spawn() with shell:false.
 *   There is no command line to quote and nothing to inject through.
 * * The input URL is passed after `-i` and comes from a validated source; it is
 *   additionally neutralised against leading-dash option injection.
 */
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config/index.js';
import { childLogger } from './logger.js';
import { registerChild, unregisterChild } from './orphan-reaper.js';
import { FileTailer } from './file-tailer.js';
import { redactUrls } from './redact.js';

const BOOT_GRACE_MS = 6000;

export const FFMPEG_STRATEGIES = Object.freeze(['multi-pipe', 'dual-file', 'dual-stdout']);

/**
 * Builds the argv as three named sections.
 *
 * Keeping them separate is what makes the dual-process fallback correct: each
 * output needs the full input section in front of it, and it is very easy to
 * get wrong by slicing one flat array.
 *
 * @param {object} o
 * @param {string} o.input            direct media URL or local file path
 * @param {Record<string,string>} [o.headers]
 * @param {object} [o.video]
 * @param {object} [o.audio]
 * @param {number} [o.durationMs]     used for `-t` when a hard cap is wanted
 * @returns {{input: string[], videoOutput: string[], audioOutput: string[]}}
 */
export function buildFfmpegSections({
  sources,
  video = config.video,
  audio = config.audio,
  durationMs = 0,
  videoTarget = 'pipe:3',
  audioTarget = 'pipe:4',
  // Which inputs this process needs. The single-process mode wants both; the
  // dual-process fallback gives each process only the input it actually maps,
  // which is both faster and keeps `-re` attached to the right stream.
  mode = 'both',
}) {
  const { muxed, video: videoSource, audio: audioSource } = normaliseSources(sources);
  const wantsVideo = mode !== 'audio';
  const wantsAudio = mode !== 'video';
  const useSplitInputs = !muxed && mode === 'both' && Boolean(audioSource);

  const inputArgs = [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'warning',
    '-nostats',

    // ---- input: minimise latency and survive flaky networks ----
    // `discardcorrupt` is a *format* flag (fflags); `low_delay` is a *codec*
    // flag. Passing discardcorrupt to -flags makes the decoder abort.
    //
    // NB: `+nobuffer` is deliberately NOT set. It looks like a latency flag but
    // on several FFmpeg builds (8.x here) it starves the muxer and the output
    // ends up completely empty. `-re`, a small `-muxdelay` and a short GOP are
    // what actually control latency.
    '-fflags', '+genpts+discardcorrupt',
    '-flags', 'low_delay',
    '-probesize', String(video.probeSize),
    '-analyzeduration', String(video.analyzeDuration),
    '-max_delay', '5000000',
    '-err_detect', 'ignore_err',
  ];

  // Real-time pacing. Without it FFmpeg transcodes as fast as the CPU allows,
  // which (a) pushes the entire video to the viewer in seconds instead of
  // playing it, and (b) in dual-process mode lets the cheap audio encoder race
  // ahead of the video encoder, so the two streams drift apart continuously.
  // `-re` makes the input clock the master, which is what a live stream needs.
  // Skipped for live sources, where the demuxer is already paced and forcing
  // `-re` would only cause reconnect churn.
  const pace = durationMs > 0;

  // The input this process actually reads: video for the video output, audio
  // for the audio output. In single-process mode it is the video input and the
  // audio may be a second input.
  const primary = wantsVideo ? videoSource : audioSource ?? videoSource;
  if (isRemote(primary.url)) inputArgs.push(...networkArgs(video));
  if (pace) inputArgs.push('-re');
  pushHeader(inputArgs, primary.headers);
  inputArgs.push('-i', assertSafeInput(primary.url));

  if (wantsAudio && useSplitInputs) {
    // Second input: the audio-only stream. `-headers` is an *input* option, so
    // it must be repeated immediately before its own `-i`.
    if (isRemote(audioSource.url)) inputArgs.push(...networkArgs(video));
    if (pace) inputArgs.push('-re');
    pushHeader(inputArgs, audioSource.headers);
    inputArgs.push('-i', assertSafeInput(audioSource.url));
  }

  if (pace) {
    // Applied after every input: it caps the *output*, which is what we want.
    inputArgs.push('-t', String((durationMs / 1000).toFixed(3)));
  }

  // Input index of the audio stream. In dual mode the audio process only has
  // the audio stream, so it is input 0 there even for a split source.
  const audioMapIndex = useSplitInputs ? 1 : 0;

  // ---- output 1: MPEG-1 video inside MPEG-TS ----
  const videoOutput = [
    '-map', '0:v:0',
    '-sn', '-dn',
    '-vf', buildVideoFilter(video),
    '-c:v', 'mpeg1video',
    '-q:v', String(video.q),
    '-pix_fmt', 'yuv420p',
    // Must match the fps filter above or the muxer will flag a frame-rate
    // change on every packet.
    '-r', mpeg1FrameRate(video.fps),
    '-g', String(video.gop),
    '-keyint_min', String(video.gop),
    '-sc_threshold', '0',
    '-bf', '0',                 // no B-frames: B-frames add reordering latency
    '-threads', String(video.threads),
    '-max_muxing_queue_size', String(video.maxMuxingQueue),
    '-f', 'mpegts',
    '-muxdelay', String(video.muxDelay),
    '-muxpreload', '0',
    '-flush_packets', '1',
    videoTarget,
  ];

  // ---- output 2: MP3 audio ----
  const audioOutput = [
    '-map', `${audioMapIndex}:a:0?`, // `?` = tolerate sources with no audio
    '-vn', '-sn', '-dn',
    // async resample keeps the audio timeline locked to the input clock, which
    // is what stops the MP3 from drifting against the video over long clips.
    '-af', 'aresample=async=1:first_pts=0',
    '-c:a', 'libmp3lame',
    '-b:a', audio.bitrate,
    '-ar', String(audio.sampleRate),
    '-ac', String(audio.channels),
    // Be explicit about the layout: a source that reports "unspecified"
    // channels makes libmp3lame fail, and browsers reject such an MP3.
    '-channel_layout', audio.channels === 1 ? 'mono' : 'stereo',
    '-write_xing', '0',        // no seek table: it would add a few hundred ms
    '-id3v2_version', '0',
    '-flush_packets', '1',
    '-f', 'mp3',
    audioTarget,
  ];

  return { input: inputArgs, videoOutput, audioOutput };
}

function networkArgs(video) {
  return [
    '-rw_timeout', String(video.rwTimeoutUs),
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '4',
  ];
}

function pushHeader(args, headers) {
  const arg = buildHeaderArg(headers);
  if (arg) args.push('-headers', arg);
}

/** Accepts both the split form and the older single-URL form. */
function normaliseSources(sources) {
  if (!sources) throw new Error('ffmpeg: no sources');
  if (sources.video?.url) {
    return {
      muxed: sources.muxed === true,
      video: { url: sources.video.url, headers: sources.video.headers ?? {} },
      audio: sources.audio?.url
        ? { url: sources.audio.url, headers: sources.audio.headers ?? {} }
        : null,
    };
  }
  return {
    muxed: true,
    video: { url: sources.url, headers: sources.headers ?? {} },
    audio: null,
  };
}

/**
 * The argv for a single FFmpeg process writing MPEG-TS to fd 3 and MP3 to fd 4.
 * @returns {string[]}
 */
export function buildFfmpegArgs(opts) {
  const { input, videoOutput, audioOutput } = buildFfmpegSections(opts);
  return [...input, ...videoOutput, ...audioOutput];
}

/**
 * MPEG-1 video is only defined for a fixed set of frame rates. Asking the
 * encoder for anything else fails at runtime with "MPEG-1/2 does not support
 * N fps" *after* the stream has already been created, so we snap the
 * configured value to the nearest legal rate instead.
 */
const MPEG1_FRAME_RATES = Object.freeze([24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60]);

export function mpeg1FrameRate(fps) {
  const wanted = Number(fps) || 25;
  let best = MPEG1_FRAME_RATES[0];
  for (const rate of MPEG1_FRAME_RATES) {
    if (Math.abs(rate - wanted) < Math.abs(best - wanted)) best = rate;
  }
  // Render the common integer rates without a decimal tail.
  return Number.isInteger(best) ? String(best) : best.toFixed(3);
}

/** scale + fps + square pixels. No commas inside expressions: they separate filters. */
export function buildVideoFilter(video = config.video) {
  const w = evenNumber(video.width);
  const h = evenNumber(video.height);
  return [
    // `min(w,iw)` / `min(h,ih)` cap the output at the configured box *and* at the
    // source's own dimensions, so a 480p-only video is not blown up to 720p.
    // Upscaling cannot add detail - it just makes the encoder spend bitrate on
    // interpolated pixels and the decoder spend CPU on more of them.
    //
    // `force_original_aspect_ratio=decrease` then fits the capped box to the
    // source aspect, and `force_divisible_by=2` keeps the dimensions even, which
    // MPEG-1 requires.
    //
    // The min() calls are quoted so the `,` between their arguments cannot be
    // read as a filter-graph separator.
    `scale=w='min(${w},iw)':h='min(${h},ih)':` +
      'force_original_aspect_ratio=decrease:force_divisible_by=2',
    `fps=${mpeg1FrameRate(video.fps)}`,
    'setsar=1',
  ].join(',');
}

/**
 * FFmpeg's -headers takes CRLF separated `Name: value` lines. Header names and
 * values are filtered here so a malicious `User-Agent` cannot smuggle in CRLF
 * and extra directives.
 */
export function buildHeaderArg(headers = {}) {
  const lines = [];
  for (const [rawName, rawValue] of Object.entries(headers ?? {})) {
    if (typeof rawValue !== 'string') continue;
    if (!/^[A-Za-z0-9-]{1,64}$/.test(rawName)) continue;
    const value = rawValue.replace(/[\r\n]+/g, ' ').slice(0, 512);
    if (!value) continue;
    lines.push(`${rawName}: ${value}`);
  }
  return lines.length ? `${lines.join('\r\n')}\r\n` : '';
}

function evenNumber(n) {
  const v = Math.trunc(Number(n) || 1280);
  return v % 2 === 0 ? v : v - 1;
}

function isRemote(input) {
  return /^https?:\/\//i.test(input);
}

/**
 * Validates an input URL and returns it unchanged.
 *
 * Nothing derived from user input ever reaches FFmpeg without passing through
 * here, so the argv can be assembled by a plain array push with no escaping.
 */
function assertSafeInput(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('ffmpeg: empty input');
  }
  if (input.length > 4096) {
    throw new Error('ffmpeg: input too long');
  }
  // An input that starts with "-" would be parsed as an option. `-i` takes the
  // next argv element literally, so this is belt and braces.
  if (input.startsWith('-')) {
    throw new Error('ffmpeg: refusing option-like input');
  }
  if (/[\r\n\0]/.test(input)) {
    throw new Error('ffmpeg: control characters in input');
  }
  return input;
}

/**
 * Supervises the FFmpeg process(es) for one session and emits binary chunks.
 *
 * Events: 'video' (Buffer), 'audio' (Buffer), 'log' (string),
 *         'exit' ({code, signal, strategy}), 'fatal' (Error), 'meta' ({...})
 */
/**
 * Per-session quality presets.
 *
 * These are deliberately small overrides of `config.video` rather than a second
 * config system: the operator's env values remain the default and the ceiling,
 * and a request can only ask for one of these known-good shapes. `q` is lower
 * is better in MPEG-1 quantiser terms, and `gop` is kept short at every preset
 * so a client that sheds packets still resyncs within half a second.
 *
 * Frame rates are already legal MPEG-1 rates. That is not a detail: MPEG-1
 * defines no rate below 23.976, so a "low" preset asking for 15 fps would be
 * snapped *up* to 23.976 by mpeg1FrameRate() and cost more CPU than requested.
 * The savings between presets come from resolution and quantiser instead.
 *
 * Anything not listed falls back to the server default.
 */
export const QUALITY_PRESETS = Object.freeze({
  // `low` is the escape hatch for a weak machine or a slow link, not the
  // default. The default is 720p because that is what a viewer expects; the
  // smaller preset exists for when 720p will not hold real time.
  low: { width: 854, height: 480, fps: 25, q: 12, gop: 12 },
  standard: { width: 1280, height: 720, fps: 25, q: 10, gop: 12 },
  high: { width: 1920, height: 1080, fps: 25, q: 12, gop: 15 },
});

/**
 * Resolves a requested quality name into a video config object. Returns the
 * server default untouched for an absent or unknown value, so a bad request
 * can never widen the operator's configured ceiling.
 */
export function videoConfigFor(quality) {
  // `medium` was the old name for the 720p preset. Accept it so a client that
  // stored it in localSettings before the rename still gets 720p rather than
  // silently falling back to the server default.
  const name = quality === 'medium' ? 'standard' : quality;
  const preset = QUALITY_PRESETS[name];
  if (!preset) return config.video;
  return {
    ...config.video,
    ...preset,
    // Clamp to the operator's *ceiling*, not to their default output.
    //
    // These used to be the same number, which quietly made the upper presets
    // useless: with a 720p default, "1080p" was clamped straight back to 720p
    // and the menu offered a choice that did nothing. Shipping a preset *is* the
    // operator sanctioning that resolution; what a client must not be able to do
    // is exceed the ceiling.
    width: Math.min(preset.width, config.video.maxWidth),
    height: Math.min(preset.height, config.video.maxHeight),
  };
}

export class Transcoder extends EventEmitter {
  /**
   * @param {object} opts
   * @param {{muxed?:boolean, video:{url:string,headers?:object}, audio?:{url:string,headers?:object}}|{url:string,headers?:object}} opts.sources
   * @param {() => Promise<object>} [opts.refreshSources] re-resolve the source;
   *   used when the signed media link is rejected, which no output strategy can fix
   */
  constructor({ sources, durationMs = 0, log, sessionId, outputDir, quality = null, refreshSources = null }) {
    super();
    this.sources = sources;
    this.refreshSources = refreshSources;
    this.durationMs = durationMs;
    this.log = log ?? childLogger({ mod: 'ffmpeg' });
    this.sessionId = sessionId;
    this.outputDir = outputDir ?? null;
    this.quality = quality;

    // A per-session quality override wins over the server default for the video
    // output only; audio is unaffected.
    this.video = videoConfigFor(quality);
    this.opts = { sources, durationMs, video: this.video };
    this.strategy = null;
    this.args = buildFfmpegArgs(this.opts);
    this.procs = new Map(); // 'video' | 'audio' | 'shared' | 'progress' -> ChildProcess
    this.started = false;
    this.stopped = false;
    this.hasVideo = false;
    this.hasAudio = false;
    this.bytes = { video: 0, audio: 0 };
    this.sawFirstByte = false;
    this.stderrTail = [];
  }

  /** Spawns, trying each strategy until one produces data. */
  async start() {

    // On Windows FFmpeg cannot inherit extra file descriptors: `pipe:3` fails
    // with EBADF because the C runtime only sets up handles 0/1/2. Writing the
    // two outputs to two files gets the same single-timeline behaviour as
    // multi-pipe, so dual-stdout (two processes, two independent start-up
    // latencies, a permanently offset live edge) is only a last resort.
    const order =
      process.platform === 'win32'
        ? ['dual-file', 'multi-pipe', 'dual-stdout']
        : ['multi-pipe', 'dual-file', 'dual-stdout'];

    let lastError = null;
    // At most one fresh link. A URL that is rejected again after being signed
    // for this very connection is not going to be accepted on a third attempt,
    // and an unbounded retry would turn a dead video into a hot loop.
    let refreshAttempted = false;

    for (const strategy of order) {
      if (this.stopped) return null;
      try {
        this.log.info({ strategy, sessionId: this.sessionId }, 'ffmpeg starting');
        await this.tryStrategy(strategy);
        this.strategy = strategy;
        this.started = true;
        this.log.info(
          { strategy, sessionId: this.sessionId, pid: this.pid() },
          'ffmpeg running',
        );
        return strategy;
      } catch (err) {
        lastError = err;
        this.killProcesses();

        if (err.retryWithFreshSource && !refreshAttempted && this.refreshSources) {
          refreshAttempted = true;
          this.log.warn(
            { sessionId: this.sessionId, err: err.message },
            'media link was rejected; resolving it again for this connection',
          );
          try {
            const sources = await this.refreshSources();
            if (this.stopped) return null;
            this.sources = sources;
            // The argv were built once in the constructor, so they have to be
            // rebuilt here or the next attempt would re-fetch the dead URL.
            this.opts = { sources, durationMs: this.durationMs, video: this.video };
            this.args = buildFfmpegArgs(this.opts);
          } catch (refreshErr) {
            this.log.warn(
              { sessionId: this.sessionId, err: refreshErr.message },
              'could not obtain a fresh media link',
            );
            throw err;
          }
          continue;
        }

        if (err.retryWithFreshSource) {
          // The refresh is spent and the new link was refused too. Trying the
          // remaining output strategies would spawn two more processes and wait
          // out their timeouts to re-fetch a URL that is known to be bad: the
          // fault is the link, not the way the outputs are wired.
          this.log.warn(
            { strategy, sessionId: this.sessionId, err: err.message },
            'the media link was refused again after being refreshed',
          );
          throw err;
        }

        if (err.retryWithOtherStrategy === false) {
          this.log.warn(
            { strategy, sessionId: this.sessionId, err: err.message },
            'ffmpeg failed for a reason no other strategy can fix',
          );
          throw err;
        }
        this.log.warn(
          { strategy, sessionId: this.sessionId, err: err.message },
          'ffmpeg strategy failed, trying next',
        );
      }
    }

    throw lastError ?? new Error('ffmpeg: no usable output mode');
  }

  tryStrategy(strategy) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok, err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.offAny('firstbyte', onFirst);
        this.offAny('exit', onExit);
        this.offAny('fatal', onFatal);
        resolve(ok ? true : Promise.reject(err ?? new Error('ffmpeg: produced no output')));
      };
      const onFirst = () => finish(true);
      const onExit = ({ code, signal }) => {
        if (!this.sawFirstByte) {
          const err = this.fatalFromStderr(code, signal);
          finish(false, err);
        } else {
          // Normal end of stream.
          this.emit('exit', { code, signal, strategy, ended: true });
          finish(true);
        }
      };
      const onFatal = (err) => finish(false, err);

      this.on('firstbyte', onFirst);
      this.on('exit', onExit);
      this.on('fatal', onFatal);

      // Deliberately NOT unref'd: while we are deciding whether this strategy
      // works, the child process (and this timer) are the only things keeping
      // the event loop alive, and an unref'd timer lets Node exit first.
      const timer = setTimeout(() => {
        if (!this.sawFirstByte) {
          this.killProcesses();
          finish(false, this.fatalFromStderr(null, null));
        }
      }, BOOT_GRACE_MS);

      try {
        if (strategy === 'multi-pipe') this.spawnMultiPipe();
        else if (strategy === 'dual-file') this.spawnDualFile();
        else this.spawnDualStdout();
      } catch (err) {
        finish(false, err);
      }
    });
  }

  /**
   * One process, two output *files*, tailed by this process.
   *
   * Same single-timeline guarantee as multi-pipe, but reachable on Windows,
   * where extra inherited file descriptors do not exist. The two files are
   * created in the system temp directory with the session id in the name so
   * cleanup and the orphan reaper can identify them.
   */
  spawnDualFile() {
    const dir = this.outputDir ?? tmpdir();
    // The session's temp directory is only a path until something needs it to
    // exist, and FFmpeg will not create it: it fails with "Error opening output
    // file ... No such file or directory" if the parent is missing.
    mkdirSync(dir, { recursive: true });
    const base = join(dir, `out-${(this.sessionId ?? 'anon').replace(/[^A-Za-z0-9_-]/g, '')}`);
    this.outputPaths = { video: `${base}.ts`, audio: `${base}.mp3` };

    const sections = buildFfmpegSections({
      ...this.opts,
      videoTarget: this.outputPaths.video,
      audioTarget: this.outputPaths.audio,
    });
    const child = spawn(
      config.video.ffmpegPath,
      [...sections.input, ...sections.videoOutput, ...sections.audioOutput],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false },
    );
    this.procs.set('shared', child);
    this.attachStderr(child);
    this.attachExit(child, 'shared');

    for (const kind of ['video', 'audio']) {
      const tailer = new FileTailer({ path: this.outputPaths[kind] });
      this.tailers ??= new Map();
      this.tailers.set(kind, tailer);
      tailer.on('data', (buf) => {
        this.bytes[kind] += buf.length;
        this.sawFirstByte = true;
        if (kind === 'video') this.hasVideo = true;
        else this.hasAudio = true;
        this.emit(kind, buf);
        this.emit('firstbyte');
      });
      tailer.start();
    }
  }

  /**
   * One process, two extra pipes: fd 3 = MPEG-TS, fd 4 = MP3.
   * Requires a platform where the child inherits handles above stderr (POSIX).
   */
  spawnMultiPipe() {
    const child = spawn(config.video.ffmpegPath, this.args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    this.procs.set('shared', child);
    this.attach(child, 'video', child.stdio[3]);
    this.attach(child, 'audio', child.stdio[4]);

    // fd 0 = null, fd 1 = null, fd 2 = diagnostics, fd 3 = MPEG-TS, fd 4 = MP3.
    this.attachStderr(child);
    this.attachExit(child, 'shared');
  }

  /**
   * Fallback: one process per output, each writing to its own stdout.
   * Costs a second decode pass but works everywhere.
   */
  spawnDualStdout() {
    // Each process gets only the input it maps. Sharing one input section would
    // mean the audio process also probes (and paces against) the video stream.
    const videoSections = buildFfmpegSections({
      ...this.opts,
      videoTarget: 'pipe:1',
      mode: 'video',
    });
    const audioSections = buildFfmpegSections({
      ...this.opts,
      audioTarget: 'pipe:1',
      mode: 'audio',
    });

    const video = spawn(
      config.video.ffmpegPath,
      [...videoSections.input, ...videoSections.videoOutput],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false },
    );
    const audio = spawn(
      config.video.ffmpegPath,
      [...audioSections.input, ...audioSections.audioOutput],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false },
    );

    this.procs.set('video', video);
    this.procs.set('audio', audio);
    this.attach(video, 'video', video.stdout);
    this.attach(audio, 'audio', audio.stdout);
    this.attachStderr(video, 'video');
    this.attachStderr(audio, 'audio');
    this.attachExit(video, 'video');
    this.attachExit(audio, 'audio');
  }

  attach(child, kind, stream) {
    if (!stream) return;
    stream.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.bytes[kind] += buf.length;
      this.sawFirstByte = true;
      if (kind === 'video') this.hasVideo = true;
      else this.hasAudio = true;
      this.emit(kind, buf);
      this.emit('firstbyte');
    });
    stream.on('end', () => {
      // An output that closes before producing anything means the source has no
      // such track (e.g. a silent video for the MP3 output).
      if (this.bytes[kind] === 0) this.emit('output-end', kind);
      this.emit('output-closed', kind);
    });
    stream.on('error', (err) => {
      this.log.warn({ err: err.message, kind }, 'ffmpeg output stream error');
    });
  }

  attachStderr(child, tag = 'main') {
    if (!child.stderr) return;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => {
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.stderrTail.push(trimmed);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
        this.emit('log', trimmed, tag);
      }
    });
  }

  attachExit(child, tag) {
    // Recorded so a crashed/killed server does not leave FFmpeg running.
    registerChild(child, this.sessionId);
    child.on('error', (err) => {
      this.emit('fatal', new Error(`ffmpeg: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      unregisterChild(child.pid);
      this.procs.delete(tag);
      this.emit('exit', { code, signal, child, tag });
      if (!this.sawFirstByte) {
        this.emit('fatal', this.fatalFromStderr(code, signal));
      } else if (this.procs.size === 0) {
        this.emit('done', { code, signal, strategy: this.strategy });
      }
    });
  }

  fatalFromStderr(code, signal) {
    const tail = this.stderrTail.slice(-8).join(' | ');
    // Every message carries a short, redacted tail. Without it "could not open
    // the source" is unactionable - a 403, a 404 and a local permission problem
    // all collapse into the same sentence.
    //
    // It has to be redacted, though. FFmpeg echoes the input URL on any input
    // error, and for YouTube that URL is a *signed* media link carrying the
    // viewer's IP address, an expiry and a signature. These messages reach the
    // browser and the log file, so the raw text would publish a working
    // credential for the fetcher's IP.
    const detail = tail ? ` [ffmpeg: ${redactUrls(tail).slice(-300)}]` : '';
    if (/Bad file descriptor|EBADF/i.test(tail)) {
      return this._fatal(
        new Error(`ffmpeg cannot write to an extra pipe on this platform (fd 3 unavailable).${detail}`),
        { retryWithOtherStrategy: true },
      );
    }
    if (/No such file or directory|Permission denied/i.test(tail)) {
      // Input and output failures share this wording, and they mean opposite
      // things: an unreadable source is the user's URL, an unwritable output is
      // this server's temp directory.
      const which = /Error opening output/i.test(tail) ? 'write its output to' : 'open the source (it may have expired)';
      return this._fatal(
        new Error(`ffmpeg could not ${which}.${detail}`),
        { retryWithOtherStrategy: /Error opening output/i.test(tail) },
      );
    }
    if (/Unknown encoder|Unknown decoder|Could not write header/i.test(tail)) {
      return this._fatal(
        new Error(`ffmpeg is missing a required codec (mpeg1video / libmp3lame).${detail}`),
        { retryWithOtherStrategy: false },
      );
    }
    if (/Error opening input/i.test(tail) && /\b(403|404)\b|Forbidden/i.test(tail)) {
      // The signed media URL was rejected. This is worth one fresh resolve and
      // is not the same fault as a video that cannot be opened at all.
      //
      // A googlevideo URL is not a permanent address: it carries the fetching
      // IP in its `ip`/`ipb` parameters and a signature over it. Resolve and
      // fetch happen in the same process, but they are separate connections,
      // and a host whose egress address is not stable - a NAT pool, a proxy, a
      // redeployed instance behind a shared address - can hand the two
      // different addresses. The URL is then valid for nobody. Asking yt-dlp
      // again gets a link signed for the address *this* connection will use.
      return this._fatal(
        new Error(
          `YouTube rejected the media link for this server (403). Retrying with a fresh link.${detail}`,
        ),
        { retryWithOtherStrategy: true, retryWithFreshSource: true },
      );
    }

    if (/Invalid data found|No such filter|Error opening input/i.test(tail)) {
      return this._fatal(new Error(`ffmpeg rejected the source.${detail}`), {
        retryWithOtherStrategy: false,
      });
    }    if (/Connection|timed out|resolve host|HTTP error/i.test(tail)) {
      return this._fatal(new Error(`Could not reach the source.${detail}`), {
        retryWithOtherStrategy: false,
      });
    }
    // Unknown: worth one more strategy, since an unexplained failure may well
    // be this particular way of wiring the outputs up.
    return this._fatal(
      new Error(
        `ffmpeg produced no output${code !== null ? ` (exit ${code}${signal ? `, ${signal}` : ''})` : ''}.${detail}`,
      ),
      { retryWithOtherStrategy: true },
    );
  }

  /**
   * Tags an error with whether trying a different output strategy could help.
   *
   * Without this, a dead source URL launches FFmpeg once per strategy: three
   * processes, three identical failures, and a log that blames the wrong thing.
   * Only failures that could plausibly be caused by *how* the outputs are wired
   * up are worth retrying.
   */
  _fatal(err, { retryWithOtherStrategy, retryWithFreshSource = false }) {
    err.retryWithOtherStrategy = retryWithOtherStrategy;
    // Separate from the strategy flag: no output strategy can fix a URL that
    // was signed for a different IP address, so the loop below needs to know it
    // must go back to yt-dlp rather than try the next way of writing two files.
    err.retryWithFreshSource = retryWithFreshSource;
    return err;
  }

  /** SIGTERM, then SIGKILL. Safe to call repeatedly. */
  /** SIGTERM, then SIGKILL. Safe to call repeatedly. */
  killProcesses() {
    for (const child of this.procs.values()) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    this.procs.clear();
    this.releaseOutputs();
  }

  /**
   * Stops any file tailers and deletes the files FFmpeg was writing to.
   *
   * Returns a promise that settles once the files are gone (or have given up).
   * Callers that go on to delete the containing directory must await it: the
   * unlink retries run on a timer, and removing the directory first would fail
   * with the files still inside - leaving the directory behind permanently.
   */
  releaseOutputs() {
    if (!this.tailers?.size && !this.outputPaths) return this._released ?? Promise.resolve();
    const tailers = [...(this.tailers?.values() ?? [])];
    this.tailers = new Map();
    this._released = Promise.all(tailers.map((t) => t.stop().catch(() => false))).then(() => true);
    this.outputPaths = null;
    return this._released;
  }

  stop(reason = 'stopped') {
    if (this.stopped) return;
    this.stopped = true;
    this.log.info({ sessionId: this.sessionId, reason }, 'ffmpeg stopping');
    const procs = [...this.procs.values()];
    for (const child of procs) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    const timer = setTimeout(() => {
      for (const child of procs) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, 2000);
    timer.unref?.();

    if (procs.length === 0) {
      clearTimeout(timer);
      this.releaseOutputs();
      return;
    }

    // The output files can only be deleted once FFmpeg has actually let go of
    // them. On Windows an open file cannot be unlinked at all, so releasing
    // them before the process exits leaves them on disk for good - and with
    // them the session's temp directory, which then fails to empty.
    const release = () => {
      clearTimeout(timer);
      this.releaseOutputs();
    };
    let remaining = procs.length;
    for (const child of procs) {
      child.once('exit', () => {
        remaining -= 1;
        if (remaining <= 0) release();
      });
    }
    // Belt and braces: if an 'exit' never arrives, release anyway.
    this._releaseGuard = setTimeout(release, 3000);
    this._releaseGuard.unref?.();
  }

  /**
   * Resolves once every FFmpeg process has exited and its output files have
   * been released.
   *
   * Callers that delete the session's temp directory have to wait for this:
   * on Windows the directory cannot be emptied while FFmpeg still holds its
   * output files open, and the failure is silent.
   */
  async waitForExit(timeoutMs = 4000) {
    // `procs` empties as each child closes (see attachExit), so an empty map
    // means everything has already exited. Without this check the wait below
    // would sit out the whole timeout: the 'exit' events it listens for have
    // already been delivered, and the caller is left blocked for no reason.
    while (this.procs.size > 0) {
      const gone = await new Promise((resolve) => {
        const onExit = () => {
          if (this.procs.size === 0) {
            clearTimeout(guard);
            this.off('exit', onExit);
            resolve(true);
          }
        };
        this.on('exit', onExit);
        const guard = setTimeout(() => {
          this.off('exit', onExit);
          resolve(false);
        }, timeoutMs);
        guard.unref?.();
      });
      if (!gone) break;
    }
    if (this._releaseGuard) {
      clearTimeout(this._releaseGuard);
      this._releaseGuard = null;
    }
    await this.releaseOutputs();
    return this.procs.size === 0;
  }

  onAny(event, fn) {
    this.on(event, fn);
    return () => this.off(event, fn);
  }
  offAny(event, fn) {
    this.off(event, fn);
  }

  pid() {
    return [...this.procs.values()][0]?.pid ?? null;
  }

  snapshot() {
    return {
      strategy: this.strategy,
      hasVideo: this.hasVideo,
      hasAudio: this.hasAudio,
      splitSource: this.opts.sources?.muxed === false,
      bytes: { ...this.bytes },
      // Redacted for the same reason as the error messages: this snapshot is
      // served to the browser on the session's meta channel.
      stderr: this.stderrTail.slice(-5).map((line) => redactUrls(line)),
    };
  }
}
