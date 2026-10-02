# CyberStream

Stream a YouTube video into a web browser in real time.

FFmpeg transcodes the source into **MPEG-1 video inside MPEG-TS** (delivered over
`wss://` to a [JSMpeg](https://github.com/phoboslab/jsmpeg) canvas) and **MP3
audio** (delivered over plain HTTP to a standard `<audio controls>` element),
with the two streams kept in sync in the browser.

```
  YouTube URL ──► yt-dlp ──► FFmpeg ──┬──► MPEG-TS ──► WebSocket ──► JSMpeg ──► <canvas>
                                       └──► MP3     ──► HTTP      ──► <audio>
                                                  (Socket.IO carries state + clock)
```

---

## Contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Project layout](#project-layout)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [Deployment](#deployment)
- [Security](#security)
- [Performance](#performance)
- [Reliability and cleanup](#reliability-and-cleanup)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Legal](#legal)

---

## Quick start

### Requirements

| Dependency | Why | Install |
|---|---|---|
| Node.js ≥ 20.11 | server (uses `--env-file-if-exists`) | [nodejs.org](https://nodejs.org) |
| FFmpeg **with `mpeg1video` and `libmp3lame`** | transcoding | `brew install ffmpeg` / `apt install ffmpeg` / [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) |
| yt-dlp | resolves YouTube URLs to direct media URLs | `npm run tools` (downloads to `./bin`) |

Check your FFmpeg has both encoders — the app refuses to start cleanly without
them, and says so:

```bash
ffmpeg -encoders | grep -E 'mpeg1video|libmp3lame'
```

### Run it

```bash
npm install          # also vendors the JSMpeg player (checksum-pinned)
npm run tools        # downloads yt-dlp into ./bin  (once)
cp .env.example .env # optional; every value has a default
npm start            # http://localhost:8080
```

Paste a URL, or press **TRY DEMO**.

> **Use Docker if you would rather not install FFmpeg locally** — the image
> already contains FFmpeg, yt-dlp and a non-root user:
> ```bash
> docker compose up --build
> ```

### Verify the pipeline without a browser

```bash
npm run smoke                 # FFmpeg -> MPEG-TS + MP3, byte counts, PTS check
node scripts/e2e-check.mjs    # full round trip through a running server
```

When playback looks wrong, the first question is *which side* is at fault, and
the two are indistinguishable from the browser — a picture that is not advancing
looks the same whether the encoder or the decoder is behind. This measures the
server side, so a rate near `1.000x` clears the producer and leaves the client:

```bash
node scripts/producer-rate.mjs http://localhost:8080 <videoId> 20
```

---

## How it works

### One FFmpeg process, two outputs

The important design decision: **a single FFmpeg process produces both
streams**, so:

* the two outputs share one decode pass — roughly half the CPU of two processes;
* they share one presentation timebase, so their live edges are the same instant
  by construction and they cannot drift apart.

That second point is not a nicety. Neither transport can be rewound — they are
live pipes — so if the two outputs ever come from different processes, their
start-up latencies leave a permanent A/V offset that the browser has no way to
observe (see [A/V sync](#av-sync) below) and therefore no way to correct.

```
ffmpeg -fflags +genpts+discardcorrupt -flags low_delay \
       -re -i <source> \
       -map 0:v:0 -c:v mpeg1video -q:v 12 -r 25 -g 12 -bf 0 \
       -f mpegts -muxdelay 0.1 pipe:3 \
       -map 0:a:0? -c:a libmp3lame -b:a 128k -f mp3 pipe:4
```

FFmpeg is spawned via `spawn()` with an argument array and `shell: false`. There
is no command line to quote and nothing to inject through.

#### Getting two outputs out of one process, per platform

Getting one process to write two things needs two *sinks*, and the available
sinks differ by platform. Three strategies are tried in order, and the first that
produces data wins:

| Strategy | Video sink | Audio sink | Where it works |
|---|---|---|---|
| `multi-pipe` | fd 3 | fd 4 | POSIX |
| `dual-file` | a file the server tails | a file the server tails | everywhere, including Windows |
| `dual-stdout` | stdout of process 1 | stdout of process 2 | last resort — **not** sample-locked |

`multi-pipe` is the cleanest, but a Windows child process cannot inherit handles
above stderr (`pipe:3` fails with `Bad file descriptor`; the C runtime only sets
up 0/1/2). `dual-file` gets the same single-timeline guarantee by having FFmpeg
write two files into the session's temp directory while the server follows them
(`src/lib/file-tailer.js`, a poll-based reader with bounded chunks).

`dual-stdout` — two processes — is kept only as a fallback for when writing two
files is not permitted. It is the one mode where the streams can drift, and
because the resulting offset is uncorrectable from the browser, a session
reporting it is a bug to report rather than a condition to tune around.

Failures that another strategy cannot fix (a dead source URL, a missing codec)
abort immediately instead of relaunching FFmpeg once per strategy.

### Latency settings, and why

| Setting | Value | Reason |
|---|---|---|
| `-re` | on for known-length sources | Without it FFmpeg races ahead and the whole video arrives in ~0.1 s instead of playing. It also keeps the audio encoder from outrunning the video encoder. Omitted for live sources, which are already paced. |
| `-muxdelay` / `-muxpreload` | `0.1` / `0` | The MPEG-TS muxer defaults to 0.7 s of pre-buffering. |
| `-g` / `-keyint_min` | 12 frames (0.48 s @ 25 fps) | Bounds how long JSMpeg needs to resync after dropped data. |
| `-bf 0` | no B-frames | B-frames require reordering, which is pure added latency. |
| `-flush_packets 1` | on | Pushes data out immediately rather than in bursts. |
| `-write_xing 0` | off | The MP3 seek table would add a few hundred ms of dead air. |

Two flags that look like latency optimisations but are **not** used, because
measurement showed otherwise:

* `-fflags +nobuffer` **empties the output entirely** on FFmpeg 8.x. The muxer
  starves, FFmpeg still exits 0, and you get a silently blank stream. This is
  asserted in `test/ffmpeg-args.test.js` so it cannot come back.
* `-fflags discardcorrupt` in `-flags` aborts decoding outright.

### Frame rates

MPEG-1 only defines a fixed set of frame rates (23.976, 24, 25, 29.97, 30, 50,
59.94, 60). A configured value such as 20 fps makes the encoder fail *after* the
stream already exists, so `VIDEO_FPS` is snapped to the nearest legal rate.

### Adaptive YouTube sources

YouTube rarely offers a progressive (muxed) stream any more. `--dump-single-json`
returns the selected formats under `requested_formats` with a direct URL for
each — but no top-level URL, because yt-dlp was told not to download.

Rather than letting yt-dlp download and merge the whole file (minutes of delay
for something the user asked to watch *now*), the resolver hands FFmpeg **two
inputs** and maps video from one and audio from the other:

```
-i <video url> -i <audio url> ... -map 0:v:0 ... -map 1:a:0? ...
```

Each input gets its own `-headers`, because `-headers` is an input option.
yt-dlp is always invoked with `--no-download`, so it never writes to disk.

#### The height cap has to cover the adaptive branch too

The default selector prefers a progressive format, but most videos have none
above 360p, so in practice it lands on the adaptive branch. A cap that only
applies to `best[...]` therefore falls straight through to `bestvideo`, which
takes whatever YouTube considers best — usually **4K AV1**.

That is a serious problem here, because FFmpeg then has to *decode* 4K AV1 in
real time, and when it cannot, the video output falls permanently behind the
(trivially cheap) audio output. Measured on a 24-core desktop, identical output
settings, only the source differing:

| Source | Producer rate |
|---|---|
| 4K AV1 (itag 401) | see note below |
| 720p AVC (itag 136) | 1.00× real time |

So the default selector caps the *adaptive* branches too, and prefers AVC within
the cap because it is by far the cheapest source to decode:

```
best[ext=mp4][height<=720][acodec!=none][vcodec!=none]/
best[height<=720][acodec!=none][vcodec!=none]/
bestvideo[height<=720][vcodec^=avc1]+bestaudio/
bestvideo[height<=720][vcodec^=vp9]+bestaudio/
bestvideo[height<=720]+bestaudio/
best[height<=720]/
bestvideo*+bestaudio/best          <- safety net; not height-capped
```

> Note: a producer-rate figure of "0.70×" for the 4K source was originally
> measured with a broken PTS parser (see [A/V sync](#av-sync)) and was an
> artefact, not a real decode bottleneck. The source cap is still correct and
> worth keeping — it removes a very large, very expensive decode — but the
> 720p source is what the app was already managing at 1.00×.

### A/V sync

#### The part that is not measurable in the browser

The two playheads **do not share a zero**:

* `audio.currentTime` counts from the first MP3 byte *that particular element
  received*;
* the video playhead counts from when JSMpeg attached.

So `audio.currentTime - videoPlayhead` is an arbitrary constant that depends on
when each transport happened to attach. It can easily read "3 seconds" on a
perfectly synchronised stream. Only the *change* in that difference is real
information, and only that is worth correcting. (An earlier version of this
project tried to drive the difference to zero; it dutifully tore down and
reconnected the audio transport roughly once a second, forever, in pursuit of a
number that was never wrong.)

Absolute alignment therefore has to be established **upstream**, and it is: the
single FFmpeg process described above puts both outputs on one timeline.

#### What the controller actually does

It compares playhead against playhead, calibrates the constant once, and then
corrects the departure from it:

| Measured drift | Action |
|---|---|
| `< 60 ms` | nothing (inaudible) |
| `>= 60 ms` | nudge `audio.playbackRate` by 2 %, at most once per 1.5 s, clamped to ±6 % |
| audio buffer `< 2 s` | do not speed the element up; recover the buffer first |

The calibration constant is **held**, not re-derived each tick, and it is moved
only when the player reports a genuine discontinuity — a reconnect, a stall, a
manual restart. Re-baselining on a large-looking drift instead would silently
absorb the very error the controller exists to report.

The buffer rule matters more than it looks. The `<audio>` element refills at
exactly 1×, so raising `playbackRate` draws down a buffer that only refills at
1×. Doing that to a thin buffer starves the element, a starved element falls
further behind, and the correction becomes a positive feedback loop that ends
with the audio permanently stalled. For the same reason playback does not start
until ~3 s of audio is buffered: an element that begins with nothing buffered has
no margin at all, so a single delivery hiccup puts it permanently behind — which
looks exactly like the two streams being misaligned, and is not.

For the same reason the audio element is started only once the video is
established, so both begin near the same live edge.

Measured over 60 s of playback: drift settles to **≈ −37 ms** and stays inside
±40 ms, with the audio buffer flat at 2.3 s and no stalls.

#### The server-side clock

Independently, the server parses **PTS out of the MPEG-TS it just produced**
(`src/lib/ts-clock.js`: PAT → PMT → video PID → PES header) and pushes it to the
client at 2 Hz over Socket.IO. That clock is what lets the UI distinguish "the
decoder is stalled" from "in sync with silence", and it is normalised to start
at zero.

Two details in that parser are load-bearing, and both are regression-tested
against `ffprobe`:

* **The PTS field position is calibrated, not assumed.** The nominal offset is 8
  bytes into the PES header, but FFmpeg's MPEG-TS muxer has been observed
  emitting an extra header byte, which shifts it by one. A wrong window does not
  produce nonsense — it produces a *plausible* number whose span is 70 % of the
  truth, so neither monotonicity nor a sanity band detects it. The first frames
  are used to learn which window has a steady frame delta, and every later sample
  is checked against the learned frame duration.
* **Values are converted out of the 90 kHz timebase** into the milliseconds the
  field is named for. Emitting raw ticks makes every consumer wrong by 90×.

The parser also collects *every* PID a PMT advertises as MPEG-1 video rather than
keeping a single one: a PMT section that straddles a packet boundary can make the
byte walk land on nonsense, and a last-write-wins field would then hold a PID with
no packets at all.

### Recovery

Each transport recovers on its own, with bounded exponential backoff, so one
failing never takes the other down:

* **Video** — the WebSocket is rebuilt and a fresh JSMpeg player is created,
  forcing a new demuxer and a new keyframe wait.
* **Audio** — the `<audio>` element is re-pointed at the same URL, rejoining the
  live edge.
* **Session ended** — the server pushes `session:state` over Socket.IO; the UI
  shows a distinct "ended" state rather than a frozen frame.

A re-baseline of the A/V calibration happens only at these discontinuities, and
only there — see [A/V sync](#av-sync).

If a viewer falls behind, the server sheds data instead of buffering without
bound. Shed bytes are rounded to **whole 188-byte TS packets** — dropping an
arbitrary byte count would shift every following packet out of alignment and
break that viewer's decoder permanently (`alignChunk` in
`src/realtime/video.socket.js`, covered by `test/align-chunk.test.js`).

### Pause and resume

A pause button in the transport bar holds the current frame and silences the
audio. It does **not** stop FFmpeg: the process belongs to the session, not to
this viewer, so pausing must not darken anyone else watching the same stream.

**Resume rejoins the live edge rather than continuing from the pause point.**
That is the one design decision here, and it is forced by the architecture.
Neither transport can be rewound, so "resume where I stopped" would mean playing
back a backlog that only grows — the viewer falls further behind with every
second paused, the server starts shedding data for them once their send queue
fills, and the A/V sync described above is thrown away. Re-attaching both
transports puts them back on the same edge, so sync is re-established rather than
merely hoped for. The cost is that the paused span is skipped, so the UI says so:
the sub-line counts up (`Paused — 33s behind live`) and resuming reports how far
the picture actually jumped forward.

That jump is deliberately *not* the pause duration. A frame that was already
behind the live edge when the viewer paused is caught up as well, so reporting
only how long the button was held understates the movement.

Three things keep the two transports from diverging, which is the failure mode
that matters most here:

* **The native audio controls drive the whole player.** `<audio controls>`
  ships its own play/pause button, and before this existed, pressing it paused
  only the audio while the video kept running — the exact desync the rest of the
  player works to prevent, reachable from a control the user is expected to use.
  It is now treated as a request for the whole player, with a guard so the
  player's own programmatic changes are not mistaken for the user.
* **The paused state is sticky.** A reconnect finishing, a buffer filling, the
  audio element reporting `playing` — each would otherwise report PLAYING and
  quietly un-pause a frozen picture. Guarding `setState` means one choke point
  rather than a check at every call site. `buffering` and `degraded` still
  surface, because a viewer should learn a transport is unhealthy while paused;
  only the terminal states and the pause itself override it.
* **The reconnect paths and the decode watchdog ignore a pause.** A paused
  decoder makes the server shed data, so a dropped socket is *expected* while
  paused; reconnecting would rejoin the live edge and resume playback without
  being asked.

The A/V calibration is re-based on resume, since both playheads jump.

### Pasting a link

The URL bar has a **Paste** button (and so does the empty-state overlay, since
that is where you are when you have nothing loaded and something to paste). It
uses the async Clipboard API, which is permission-gated and can fail for
several unrelated reasons, so the outcomes are told apart because the useful
next action differs:

| Outcome | What the user sees |
|---|---|
| A link was pasted | the field is filled, the text selected, focus left in the field so Enter submits |
| Clipboard empty, or nothing URL-shaped | amber button flash + "There is no link on the clipboard." |
| Permission denied / blocked context | amber flash + "press Ctrl+V instead" |
| No Clipboard API at all | amber flash + "press Ctrl+V instead" |

The button never keeps focus, so <kbd>Enter</kbd> still submits the form
afterwards.

The pasted text is tidied before it lands (`cleanPasted` in
`public/js/dom.js`, covered by `test/dom.test.js`) because a copied link is
rarely a bare URL. It handles:

* trailing newlines (a terminal, `curl`) and surrounding whitespace;
* angle brackets and straight or curly quotes (a mail client quoting a link);
* zero-width joiners and a BOM (chat apps, rich-text editors);
* `&amp;` in a query string (copied out of rendered HTML);
* a link embedded in a line of prose, with sentence punctuation after it;
* `youtu.be/…`, `/embed/…` and `/shorts/…`, all rewritten to a canonical
  `watch?v=` URL so the rest of the app sees one shape;
* a bare 11-character video id.

A URL it does not recognise is passed through untouched for the server to
reject, rather than being silently rewritten.

### Full screen

There are two entry points — the transport bar and the topbar — driving the same
action, with their icons and labels kept in step from the `fullscreenchange`
event rather than from the click. That matters because the user can also leave
full screen with <kbd>Escape</kbd> or the browser's own gesture, and a button
that still reads "enter" at that point is worse than no button.

The fullscreen target is the **stage**, not the canvas: the stage contains the
transport bar and the `<audio controls>` element, and fullscreening the canvas
alone would hide both, leaving a viewer who went full screen unable to see the
audio controls or stop the stream.

The suggested feed is hidden in full screen. It is a child of the stage, so it
would otherwise come along and take a third of the screen for a list of videos
nobody can act on while watching one; the reclaimed space goes to the picture.
The transport bar and audio element stay.

Viewport sizing comes from the `:fullscreen` pseudo-class only, because only a
real fullscreen element *is* the viewport — a class-driven `100vh` would push
the transport bar off the bottom of an ordinary page. The `is-fullscreen` class
the app sets from `fullscreenchange` carries the content rules (hide the feed,
edge-to-edge canvas), which are the same either way and can be verified without
a real fullscreen transition.

`requestFullscreen()` is raced against a short timeout. Chrome can leave the
returned promise pending forever when the document is unfocused or the user
gesture has already been consumed; awaiting it unguarded hangs the click handler
and the button simply stops responding. Racing it turns "stuck" into a visible
message.

---

## Project layout

```
.
├── src/
│   ├── server.js                 bootstrap, graceful shutdown, self-checks
│   ├── app.js                    express app, CSP, static hosting
│   ├── config/index.js           env parsing + validation (zod), fails fast
│   ├── lib/
│   │   ├── ffmpeg.js             argv construction, strategies, supervision
│   │   ├── resolver.js           yt-dlp -> direct media URL(s)
│   │   ├── youtube.js            URL/ID parsing, SSRF guards
│   │   ├── session-store.js      session lifecycle, fan-out, reaping
│   │   ├── ts-clock.js           MPEG-TS demuxer (PAT/PMT/PES -> PTS)
│   │   ├── file-tailer.js        follows a file FFmpeg is appending to
│   │   ├── orphan-reaper.js      kills ffmpeg left by a crashed server
│   │   ├── catalog.js            curated feed (server-side data)
│   │   ├── doctor.js             ffmpeg / yt-dlp capability probes
│   │   ├── ids.js                capability tokens, constant-time compare
│   │   ├── redact.js             strips signed URLs out of logged/quoted text
│   │   └── logger.js             pino (pretty in dev, JSON in prod)
│   ├── middleware/
│   │   ├── security.js           helmet CSP, origin guard, rate limits
│   │   ├── auth.js               viewer/owner token checks
│   │   └── error-handler.js      one JSON error shape
│   ├── routes/
│   │   ├── api.routes.js         sessions, catalog, health, validate
│   │   └── audio.routes.js       chunked MP3 over HTTP
│   └── realtime/
│       ├── video.socket.js       raw ws relay for MPEG-TS
│       └── control.socket.js     Socket.IO: state, meta, clock, overflow
├── public/
│   ├── index.html                dashboard markup
│   ├── css/                      design tokens, layout, components
│   ├── js/
│   │   ├── main.js               app state machine, wiring
│   │   ├── player.js             JSMpeg + <audio>, reconnect logic
│   │   ├── av-sync.js            drift measurement and rate correction
│   │   ├── api.js                typed API client
│   │   ├── catalog.js            feed / queue / history / saved
│   │   ├── dom.js, ui.js         helpers, toasts
│   └── vendor/jsmpeg.min.js      pinned by commit + SHA-256, no CDN
├── test/                         216 tests, incl. real FFmpeg + real HTTP
├── scripts/                      setup and diagnostics
├── Dockerfile                    multi-stage, non-root, healthcheck
├── render.yaml                  Render Blueprint: pins runtime: docker
├── docker-compose.yml            app (+ optional Caddy TLS profile)
└── Caddyfile                     wss:// reverse proxy, buffering disabled
```

---

## Configuration

Every variable is optional; defaults are shown in [`.env.example`](.env.example).
The file is validated at boot by a schema, so a typo fails immediately with a
readable message instead of surfacing as a mystery later.

| Variable | Default | Notes |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |
| `ALLOWED_ORIGINS` | `http://localhost:8080,…` | CSRF guard for the API |
| `PUBLIC_ORIGIN` | – | Set behind a proxy so generated URLs are correct |
| `STREAM_TOKEN` | – | Optional extra server-wide key (see [Security](#security)) |
| `MAX_SESSIONS` | `32` | Concurrent streams per process |
| `MAX_SESSION_MS` | `7200000` | Hard cap; FFmpeg exits on its own |
| `ORPHAN_GRACE_MS` | `30000` | Time a stream survives with no viewers |
| `RATE_LIMIT_CREATE_PER_MIN` | `10` | Per-IP session creation limit |
| `VIDEO_WIDTH` / `VIDEO_HEIGHT` | `1280` / `720` | Default output. A **ceiling**, not a target: the stream is never scaled above the source's own resolution |
| `VIDEO_MAX_WIDTH` / `VIDEO_MAX_HEIGHT` | `1920` / `1080` | Ceiling for a client-chosen preset. Separate from the default, so a 720p default does not silently clamp the 1080p preset back to 720p |
| `VIDEO_FPS` | `25` | Snapped to a legal MPEG-1 rate |
| `VIDEO_Q` | `10` | mpeg1video quantiser, 1 best … 31 worst (see [Quality](#quality)) |
| `GOP` | `12` | Keyframe interval in frames |
| `MUX_DELAY` | `0.1` | MPEG-TS mux delay, seconds |
| `AUDIO_BITRATE` | `128k` | |
| `YT_DLP_PATH` | `yt-dlp` | Point at `./bin/yt-dlp` if vendored |
| `YT_DLP_CLIENTS` | – | Leave empty; pinning clients goes stale |
| `YT_DLP_FORMAT` | – | Override the format selector (see below) |
| `ALLOW_DIRECT_MEDIA_URLS` | `false` | Allow non-YouTube media URLs |
| `DIRECT_MEDIA_PORTS` | `80,443` | `any` to disable the port allow-list |
| `ALLOW_PRIVATE_MEDIA_HOSTS` | `false` | Allow loopback/LAN sources (dev only) |
| `TS_CLOCK_ENABLED` | `true` | MPEG-TS PTS clock |
| `LOG_LEVEL` / `LOG_PRETTY` | `info` / `true` | Pretty logs in dev, JSON in prod |

---

## API reference

All responses are JSON; errors share one shape:
`{ "error": "code", "message": "human readable" }`.

### `POST /api/sessions`

```bash
curl -X POST http://localhost:8080/api/sessions \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=aqz-KE-bpKQ"}'
```

Resolves the source, starts FFmpeg, and returns the endpoints plus tokens:

```json
{
  "sessionId": "8aKn8R93e9p0zuEGLHpSTVYKgZZDbnVW",
  "state": "live",
  "title": "Big Buck Bunny",
  "duration": 635,
  "splitSource": true,
  "strategy": "multi-pipe",
  "hasVideo": true, "hasAudio": true,
  "missingTracks": { "video": null, "audio": null },
  "tokens": { "viewerToken": "…", "ownerToken": "…" },
  "endpoints": {
    "video": "wss://host/ws/video?token=…&sessionId=…",
    "audio": "https://host/api/stream/<id>/audio.mp3?token=…",
    "stop":  "https://host/api/stream/<id>?token=<ownerToken>"
  }
}
```

`missingTracks` is the authoritative signal about tracks. `hasVideo`/`hasAudio`
only report what has *arrived* so far — FFmpeg frequently emits the first audio
chunk before the first video chunk, so a client that trusted `hasVideo` at boot
would never start the video. Clients start both transports and switch off
whichever `missingTracks` reports as absent.

### `GET /api/stream/:sessionId/audio.mp3`

Chunked `audio/mpeg`, `Cache-Control: no-store`, `X-Accel-Buffering: no`,
`Accept-Ranges: none` (a live stream has no length and cannot be seeked).
Requires the viewer token. Returns `404 no_audio_track` for silent sources.

### `WS /ws/video?sessionId=…&token=…`

Binary MPEG-TS packets. `perMessageDeflate` is off (media is already
compressed). Heartbeat pings every 20 s; dead sockets are terminated. A close
code of `1000` means the stream finished.

### `DELETE /api/stream/:sessionId`

Stops the stream and kills FFmpeg. Requires the **owner** token.

### Other endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/config` | non-secret runtime config for the client |
| `GET /api/health` | liveness, session count, memory |
| `GET /api/catalog` | curated feed |
| `POST /api/resolve/validate` | validate a URL without starting FFmpeg |
| `GET /api/sessions` | operational view (counts only) |
| `WS /control` | Socket.IO: `session:state`, `session:meta`, `session:clock` (2 Hz), `session:overflow` |

---

## Deployment

### Docker Compose

```bash
docker compose up --build                 # http://localhost:8080
```

The image is Debian-based with FFmpeg, yt-dlp and Node, runs as the `node` user,
and ships a healthcheck. Size is dominated by FFmpeg's codec libraries
(~1 GB); `--no-install-recommends` is already applied.

### On Render, use the Dockerfile — not the native runtime

`render.yaml` is included and selects `runtime: docker` explicitly. This matters
more than it looks:

> With a Dockerfile at the repo root but no Blueprint, Render treats a Node
> service as a **native** service and runs `npm start`. The image is never built,
> so the two dependencies this app cannot work without are simply absent.

The deploy then reports success and fails every YouTube URL at resolve time:

```
{"err":"\"yt-dlp\" is not on PATH","msg":"yt-dlp unavailable"}
```

Direct media URLs still work, which makes the failure look selective and
misleading. Check which runtime is actually in use by looking for the start
command in the boot log: the image runs
`if [ -f .env ]; then exec node --env-file=.env ...`, whereas the native runtime
runs the `npm start` script. If you see `npm start`, the image was not used.

Either deploy via the Blueprint (`render.yaml` in the repo root, "Apply" in the
dashboard) or set **Runtime → Dockerfile** in the service settings by hand.

`healthCheckPath` is `/api/health`, which is a *liveness* probe and deliberately
returns 200 even when a dependency is missing — a monitor must not restart-loop a
degraded build, since restarting cannot install anything. Use
`/api/health/ready` for the honest signal: it returns **503** when FFmpeg is
unusable or yt-dlp is missing, with a `reason`.

### Verifying a deployment

```bash
curl -s https://your-host/api/health         # ok:true, degraded, canResolveYouTube
curl -s https://your-host/api/health/ready   # 503 + reason when a dependency is missing
```

`degraded: true` with `canResolveYouTube: false` is the signature of a native
runtime without yt-dlp. The UI shows the same warning on load, so a user is told
before they paste a URL instead of concluding their own link is broken.

No `ALLOWED_ORIGINS` is needed: the origin guard always allows a request whose
`Origin` matches the `Host` it was sent to, so the app works on its own domain, a
custom domain, or a per-deploy preview URL with no reconfiguration. The
allow-list exists for the case where the frontend is hosted separately, and the
same-origin exemption costs nothing in CSRF protection — a cross-site request
necessarily carries a foreign `Origin`. See [Security](#security).

### Behind TLS

Browsers refuse `ws://` on a secure page, so a public deployment effectively
requires HTTPS — the video WebSocket must be `wss://`.

```bash
export SITE_ADDRESS=stream.example.com
docker compose --profile tls up -d --build
```

Caddy obtains a certificate automatically and proxies both transports. Its
config disables response buffering, which would otherwise add seconds of
latency and defeat the point.

### Scaling

Sessions are isolated per process, so the model is: one Node process per
transcoder budget, behind a load balancer, with `MAX_SESSIONS` and the CPU limit
in `docker-compose.yml` sized to the machine. **Session affinity is required** —
a session's HTTP and WebSocket traffic must reach the same process. There is no
shared state between processes by design.

---

## Security

**Capability tokens, not accounts.** Each session gets a 256-bit viewer token
(read) and a separate owner token (stop). Both are compared in constant time.
Session ids are 192 bits of entropy, so they are not guessable or enumerable,
and unknown ids return a uniform `404` so existence cannot be probed.

**This is not an identity system.** Anyone holding a session id and its token can
watch that stream. If the server should not be open to the internet, put real
authentication in front of it — the `Caddyfile` has a commented `basicauth`
block ready.

Other measures:

* **No shell, ever.** FFmpeg and yt-dlp are spawned with an argv array and
  `shell: false`. User input is validated and *rebuilt* into a fresh URL before
  it is used, so `;`, `|`, newlines, `file://`, quote tricks and option injection
  (`-i evil`) cannot survive. Covered by `test/youtube.test.js` and
  `test/ffmpeg-args.test.js`.
* **SSRF guards** for direct media URLs: port allow-list, no embedded
  credentials, and rejection of loopback, link-local (`169.254.169.254` cloud
  metadata), private and CGNAT ranges.
* **CSRF origin guard** — the API only answers requests whose `Origin` is
  allow-listed *or* is the very origin the request was addressed to. Same-origin
  requests cannot be forged by a cross-site page (which necessarily carries a
  foreign `Origin`), so allowing them costs nothing and means the app works on
  any host without configuration. The scheme is checked as well as the host, so
  an HTTPS deployment does not accept an `http://` origin on the same name.
  Verified: a page served from an unlisted origin gets `403`.
* **Rate limits** on session creation (per IP, IPv6-normalised so a single
  client cannot rotate addresses within its prefix) and a global budget.
* **Strict CSP** — no inline script, no `eval`, no CDN. JSMpeg is vendored and
  checksum-pinned, so the only third-party origin allowed is YouTube's image
  CDN for thumbnails.
* **Header injection** — `-headers` values have CR/LF stripped, so a hostile
  `User-Agent` cannot smuggle in an extra HTTP directive.
* **Signed URLs never reach a log or the page.** Both FFmpeg and yt-dlp echo the
  URL they were given when an input fails, and for a resolved YouTube stream
  that URL is *signed*: it carries the fetching machine's IP address, an expiry
  and a signature. Quoting that text verbatim — in an error message rendered
  into the page, or in `logs/server.log` — republishes a working credential for
  whoever can read it. Everything that quotes subprocess stderr is scrubbed by
  `redactUrls` (`src/lib/redact.js`, covered by `test/redact.test.js`), which
  keeps the host — the part that actually diagnoses the fault — and drops the
  path, query, signature and IP.
* **Bounded resources** — 8 kB JSON bodies, 256 kB WebSocket frames, session
  caps, lifetime caps, per-viewer send buffers.

`ALLOW_CLIENT_TOKEN_BOOTSTRAP` (default on) lets a same-origin page read
`STREAM_TOKEN` from `/api/config`. It is CSRF hardening, not authentication;
set it to `false` if you inject the token yourself.

---

### Quality

The default output is **1280×720 at q10**, which is what a viewer expects from a
video player. Two things make that safe rather than a regression:

**The output is a ceiling, not a target.** The scale filter is
`min(w,iw):min(h,ih)`, so a 480p-only source comes out at 480p rather than being
stretched to 720p. Upscaling cannot add detail — it just makes the encoder spend
bitrate on interpolated pixels and the decoder spend CPU on more of them. So
"at least 720p, or the maximum the video actually has" falls out of the filter
rather than needing a special case.

**The quantiser is a weak lever, so the resolution is spent where it shows.**
Measured on the encoder this app drives, at 25 fps:

| Output | Bitrate |
|---|---|
| 854×480 | ~700 kbit/s |
| 1280×720 | ~1660 kbit/s |
| 1920×1080 | ~3000 kbit/s |

and at a fixed 720p the quantiser only moved the bitrate from 2154 (q5) to 1419
(q16) — the whole 1..31 range is 1.5×. So 720p at **q10** is the right place to
land: visibly better than q16 for ~15% more bitrate. The old `q5` default was
never needed to hit a bitrate target; it just pushed high-motion sources to
5.8 Mbit/s, which is what made playback choppy in the first place.

| Preset | Output |
|---|---|
| `low` | 854×480 q12 — the escape hatch for a weak machine or a slow link |
| `standard` | 1280×720 q10 — the default |
| `high` | 1920×1080 q12 — needs CPU |

`medium` is still accepted as an alias for `standard`, because a client that had
stored the old name in `localStorage` would otherwise be rejected by the API and
be unable to start a stream at all.

#### Telling a decode problem from a stream problem

Both look identical from the browser: the picture is not advancing. If the
producer is behind, the fix is upstream; if the decoder is behind, the fix is a
smaller frame. The only thing that distinguishes them is the ratio of decoded
media time to wall time, which only the client can measure.

So the player runs a decode watchdog (`_startDecodeWatch` in
`public/js/player.js`): if the decoded-media-to-wall-clock ratio sits below 0.95
over an 8-second window *while the server clock is still advancing and the
socket is open*, the data is arriving fine and the client is the bottleneck. It
then says so — naming the resolution and the actual fix — and steps the quality
down one notch, rather than leaving a silently stuttering picture that the user
has no way to diagnose. A hidden or unfocused tab is excluded, since
`requestAnimationFrame` does not fire there and nothing decodes regardless of
resolution.



* **One decode pass** for both outputs, on every platform (see
  [strategies](#getting-two-outputs-out-of-one-process-per-platform)).
* **720p by default, without upscaling.** See [Quality](#quality) — the output
  is a ceiling, so a lower-resolution source is not blown up to fill it.
* **Bitrate is the smoothness lever.** JSMpeg decodes MPEG-1 in JavaScript, so
  the output bitrate drives whether playback looks even: ~700 kbit/s at 480p,
  ~1660 at 720p, ~3000 at 1080p. Resolution and quantiser are both in Settings,
  and the decode watchdog steps the preset down if a client cannot hold it.
* **Cheap source decode.** The selector caps the source at 720p and prefers AVC
  — decoding 4K AV1 in real time is the one thing here that genuinely cannot
  keep up.
* **`-threads 0`** lets FFmpeg size its own pool; lower it to `2` to share a box.
* **Shed rather than buffer.** Slow clients drop video (bounded by a 1 MiB send
  queue) instead of growing Node's heap; audio sheds past 512 kB. Both notify the
  client over the control channel, and the decoder resyncs at the next keyframe.
* **Progressive formats first.** A progressive YouTube format starts streaming
  immediately; forcing `bestvideo+bestaudio` would make yt-dlp download the whole
  file first.
* **Results cache.** Identical URLs share one yt-dlp call, with reference
  counting so any temp file is reclaimed only when the last consumer releases it.

---

## Reliability and cleanup

Every session is reaped. Nothing is left running:

* **Orphaned sessions** — when the last viewer detaches, the stream survives
  `ORPHAN_GRACE_MS` (so a page reload does not restart the transcode) and is then
  stopped.
* **Orphaned processes** — every FFmpeg child is recorded in a pid file. On boot,
  anything still alive from a previous run is killed. Two safeguards: the pid
  must still exist, *and* its image name must still be `ffmpeg` — pids get
  recycled, and a stale entry must never point at an unrelated process. The
  decoy case is asserted in `test/orphan-reaper.test.js`.
* **Lifetime cap** — `MAX_SESSION_MS`, after which FFmpeg exits on its own.
* **Unresponsive startup** — a session that produces no data within
  `BOOT_TIMEOUT_MS` fails instead of lingering.
* **Temp files** — per-session directories are removed on teardown; the
  resolver's scratch directory is purged on shutdown.
* **Graceful shutdown** — `SIGINT`/`SIGTERM` stop all sessions, close sockets,
  purge temp files, and exit within 8 s. The container runs under `tini` so
  signals actually arrive.
* **Dead WebSockets** — 20 s heartbeat; unresponsive clients are terminated.
* **Media never dies with a subscriber** — a write failure or a slow reader
  detaches that one viewer instead of stalling FFmpeg's pipe.

---

## Testing

```bash
npm test          # 117 tests
```

No mocks: the suite spawns real FFmpeg, serves a real HTTP fixture, opens real
WebSockets and asserts on real bytes.

| Suite | Covers |
|---|---|
| `youtube.test.js` | URL forms, rejections, SSRF classification |
| `ffmpeg-args.test.js` | argv structure, option injection, `-re`/fflags invariants, MPEG-1 frame rates |
| `ts-clock.test.js` | TS demuxer, including against an FFmpeg-produced stream |
| `align-chunk.test.js` | packet alignment under arbitrary chunking and shedding |
| `orphan-reaper.test.js` | pid recycling safety, real child registration |
| `integration.test.js` | sessions, auth, MP3 headers/frames, WS relay + packet grid, stop → process gone, reaper, caps, rate limits |

Useful scripts:

```bash
npm run smoke              # FFmpeg pipeline only, no server
node scripts/e2e-check.mjs # full round trip against a running server
npm run catalog:verify     # every feed entry still resolves and has artwork
npm run tools:check        # report ffmpeg / yt-dlp availability
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ffmpeg is not usable` at boot | encoder missing | `ffmpeg -encoders \| grep mpeg1video` |
| `yt-dlp is not installed` | not on PATH | `npm run tools`, set `YT_DLP_PATH` |
| `Requested format is not available` | YouTube withheld progressive formats | leave `YT_DLP_CLIENTS` empty; the selector has `best` fallbacks |
| Video works, audio silent | autoplay policy | press play on the `<audio>` element; the UI shows `press play` |
| Blank canvas, no error | the WASM decoder is missing | JSMpeg needs `jsmpeg.wasm`, which upstream does not publish. The app detects this and uses the JS decoder. Do not pass `disableWebAssembly: false` without the file — JSMpeg then waits for it forever and never opens the socket |
| `403 origin_not_allowed` | origin not allow-listed | add it to `ALLOWED_ORIGINS` |
| `too many sessions` | cap reached | raise `MAX_SESSIONS`, or wait for the reaper |
| Drift keeps re-syncing | the two outputs came from different processes | check `"strategy"` in `GET /api/sessions`. `dual-stdout` is the only mode where the streams can drift, and the offset is not correctable from the browser; `multi-pipe` and `dual-file` hold a single timeline |
| Video looks choppy / stutters | the *client* cannot decode this size in real time | the app detects this and steps the preset down, saying so. To choose manually, pick `low` in Settings. Confirm the producer is innocent with `node scripts/producer-rate.mjs` — a rate near 1.000 means the stutter is decode-side |
| Paused, and the picture froze but the audio kept going | would mean the two transports diverged | they cannot: the native audio controls drive the whole player, and the paused state is sticky against reconnect and buffer events. If you see it, it is a bug worth reporting |
| Audio drifts behind over time | the `<audio>` element is starving | the app already waits for ~3 s of buffer before starting and refuses to speed the element up while the buffer is thin. If it still happens, the machine or the source is not keeping up |
| `Error opening output file … No such file or directory` | session temp dir missing | a `dual-file` bug that is fixed; if it reappears, check that `%TEMP%` is writable |
| Port already in use | — | `PORT=8081 npm start` |

---

## Legal

This tool transcodes video the user supplies. That is your responsibility, not
the project's:

* Only stream content you have the right to stream. The bundled catalogue is
  Blender Foundation films (CC-BY) precisely so the demo path is unambiguous.
* Respect YouTube's Terms of Service and the law in your jurisdiction.
* Do not use this to redistribute copyrighted material or to circumvent
  technical protection measures.
* The per-session tokens are a capability, not DRM. They are not an access
  control system, and the app is not designed to withstand a determined
  adversary.
* You are responsible for complying with export controls, content moderation
  obligations and DMCA-type takedown procedures where they apply.

## License

MIT for this project's own code. The vendored `public/vendor/jsmpeg.min.js`
carries its own licence — see `public/vendor/jsmpeg.LICENSE`.
