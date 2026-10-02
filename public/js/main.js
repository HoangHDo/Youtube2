/**
 * CyberStream frontend entry point.
 *
 * Responsibilities
 *   - own the session lifecycle (create -> play -> stop)
 *   - translate player + control events into the overlay state machine
 *   - keep the URL bar, transport, meters and sidebar in sync
 */
import { api, ApiError, apiOrigin, configureApi, isRemote, loadApiConfig } from './api.js';
import { VideoPlayer, PLAYER_STATE } from './player.js';
import { CatalogView } from './catalog.js';
import { bus, toast } from './ui.js';
import { $, cleanPasted, debounce, esc, normaliseInput, throttle, store } from './dom.js';

const SETTINGS_KEY = 'cyberstream.settings';

/**
 * How long to wait for the browser to act on a full screen request before
 * telling the user it did not happen.
 */
const FULLSCREEN_TIMEOUT_MS = 1500;

/**
 * Rejects if `promise` has not settled within `ms`.
 *
 * The timer is always cleared, including on the timeout path, so a late
 * settlement cannot produce an unhandled rejection.
 */
function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const VIEW = Object.freeze({
  IDLE: 'nosignal',
  CONNECTING: 'connecting',
  BUFFERING: 'buffering',
  PLAYING: 'playing',
  ENDED: 'ended',
  STOPPED: 'stopped',
  ERROR: 'error',
});

class App {
  constructor() {
    this.el = {
      urlForm: $('#url-form'),
      urlInput: $('#url-input'),
      loadBtn: $('#load-btn'),
      pauseBtn: $('#pause-btn'),
      pasteBtn: $('#paste-btn'),
      overlayPasteBtn: $('#overlay-paste'),
      urlbar: $('.urlbar'),
      stage: $('#stage'),
      statusPill: $('#status-pill'),
      videoWrap: $('#video-wrap'),
      overlay: $('#overlay'),
      overlayTitle: $('#overlay-title'),
      overlaySub: $('#overlay-sub'),
      overlayActions: $('#overlay-actions'),
      overlayPlay: $('#overlay-play'),
      overlayStop: $('#overlay-stop'),
      spinner: $('#spinner'),
      spinnerText: $('#spinner-text'),
      meter: $('#meter'),
      meterBuffer: $('#meter-buffer'),
      meterBar: $('#meter-bar-fill'),
      meterLatency: $('#meter-latency'),
      quality: $('#quality-badge'),
      nowTitle: $('#now-title'),
      nowSub: $('#now-sub'),
      audioEl: $('#audio-el'),
      audioState: $('#audio-state'),
      catalogSearch: $('#catalog-search'),
      apiSource: $('#api-source'),
    };

    const saved = store.get(SETTINGS_KEY, {});
    this.settings = {
      // 'standard' is 720p. An empty string means "let the server decide",
      // which is the honest default: the server knows its own ceiling, and
      // hard-coding a preset here would silently override it.
      quality: '',
      sync: true,
      autoplay: true,
      remember: false,
      ...saved,
    };
    // Migrate the pre-rename preset name, so an existing preference keeps its
    // meaning instead of quietly becoming "server default".
    if (this.settings.quality === 'medium') this.settings.quality = 'standard';

    this.serverConfig = null;
    this.session = null;
    this.socket = null;
    this.view = VIEW.IDLE;
    this.startedAt = 0;
    this.abortController = null;
    this.bufferSamples = [];
    this.pipVideo = null;

    this.player = new VideoPlayer({
      canvas: $('#video-canvas'),
      audioEl: this.el.audioEl,
      syncEnabled: this.settings.sync,
      autoplay: this.settings.autoplay,
    });

    this.catalog = new CatalogView();
  }

  async init() {
    loadApiConfig();
    this.renderApiSource();
    this.bindUi();
    await this.detectWasmDecoder();
    this.bindPlayer();
    this.bindControl();

    try {
      this.serverConfig = await api.config();
      this.renderQualityBadge();
      this.fillQualityOptions();
    } catch (err) {
      toast('Cannot reach the streaming server.', { tone: 'error' });
      this.setApiSource('error');
    }

    try {
      await this.catalog.load();
    } catch {
      // An empty feed is survivable: the URL bar still works.
    }

    this.setView(VIEW.IDLE);
    this.updateTransportEnabled();
    // Drives the live meters (buffer, latency, drift).
    this.ticker = setInterval(() => this.tick(), 1000);

    // A ?session=&token= link means "join this stream"; it has to be tried after
    // the server config is known (for `st`) and before the idle view is shown, so
    // the viewer lands straight in the stream rather than on a dashboard they
    // then have to act on. Failures are handled inside and leave the idle view.
    await this.adoptFromLink();
  }

  /**
   * JSMpeg can use a WebAssembly decoder, but only if `jsmpeg.wasm` is served
   * next to the player. Upstream compiles it with a pinned emscripten and does
   * not publish the artifact, so we probe once and fall back to the JS decoder.
   */
  async detectWasmDecoder() {
    if (!window.JSMpeg?.WASMModule?.IsSupported?.()) return;
    try {
      const res = await fetch('/vendor/jsmpeg.wasm', { method: 'HEAD', cache: 'no-store' });
      const ready = res.ok;
      this.player.wasmReady = ready;
      if (ready) {
        console.info('[cyberstream] using the JSMpeg WebAssembly decoder');
      }
    } catch {
      this.player.wasmReady = false;
    }
  }

  /* -------------------------------------------------------------- wiring -- */
  bindUi() {
    this.el.urlForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      this.startFromInput();
    });

    this.el.urlInput.addEventListener(
      'input',
      debounce(() => this.validateInline(), 450),
    );

    $('#demo-btn')?.addEventListener('click', () => {
      const demo = this.catalog.demo;
      const url = demo?.url ?? 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
      this.el.urlInput.value = url;
      this.start(url);
    });

    // Two paste entry points - the URL bar and the empty-state overlay - both
    // run the same clipboard read, so either one behaves identically.
    for (const btn of [this.el.pasteBtn, this.el.overlayPasteBtn]) {
      btn?.addEventListener('click', () => this.pasteFromClipboard());
    }

    $('#restart-btn')?.addEventListener('click', () => this.player.restartBoth());
    $('#resync-btn')?.addEventListener('click', () => {
      const ok = this.player.resync();
      toast(ok ? 'Audio and video re-aligned.' : 'No video clock yet.', {
        tone: ok ? 'ok' : 'warn',
        timeout: 2500,
      });
    });
    $('#skip-back')?.addEventListener('click', () => {
      // Nudging a live MP3 element backwards just stalls it; the honest action
      // is to rejoin the live edge.
      this.player.restartAudio();
      toast('Rejoined the live audio edge.', { tone: 'info', timeout: 2000 });
    });
    this.el.pauseBtn?.addEventListener('click', () => {
      this.player.togglePause();
      this._syncPauseUi();
    });

    $('#mute-video')?.addEventListener('click', (ev) => {
      const muted = !this.el.audioEl.muted;
      this.player.setMuted(muted);
      ev.currentTarget.setAttribute('aria-pressed', String(!muted));
      ev.currentTarget.setAttribute('aria-label', muted ? 'Unmute audio' : 'Mute audio');
    });
    $('#picture-btn')?.addEventListener('click', () => this.togglePip());
    $('#link-btn')?.addEventListener('click', () => this.copyShareLink());
    $('#overlay-stop')?.addEventListener('click', () => this.stopStream({ user: true }));

    this.player.addEventListener('video:decodebound', (ev) => {
      // The stream is arriving fine; the machine cannot decode it at this size.
      // Say so, and name the fix, instead of letting the picture stutter
      // silently - otherwise the only visible symptom is "it looks bad" and the
      // user has no idea which control to touch.
      const { width, height } = ev.detail;
      const size = width && height ? `${width}×${height}` : 'this resolution';
      toast(
        `This device cannot decode ${size} in real time — the picture is dropping frames. Dropping to 480p.`,
        { tone: 'warn', timeout: 6000 },
      );
      this._dropQualityForDecode();
    });

    // Both full screen entry points drive the same action and stay in sync.
    $('#fullscreen-btn')?.classList.add('js-fullscreen-toggle');
    $('#fullscreen-video-btn')?.classList.add('js-fullscreen-toggle');
    for (const btn of document.querySelectorAll('.js-fullscreen-toggle')) {
      btn.addEventListener('click', () => this.toggleFullscreen());
    }
    // Escape and the browser's own gestures also change the state, so the
    // buttons cannot infer it from their own click alone.
    document.addEventListener('fullscreenchange', () => this._syncFullscreenState());
    this._syncFullscreenState();

    $('#settings-btn')?.addEventListener('click', () => this.openSettings());
    $('#api-configure')?.addEventListener('click', () => this.openApiDialog());

    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => this.selectTab(tab));
    }

    bus.on('play:item', (item) => {
      this.catalog.addToQueue(item);
      this.el.urlInput.value = item.url;
      this.start(item.url, { title: item.title, thumb: item.thumb, id: item.id });
    });

    bus.on('toast', ({ message, tone, title }) => toast(message, { tone, title }));

    document.addEventListener('visibilitychange', () => {
      // A backgrounded tab is the classic source of a stalled WebSocket. On the
      // way back, re-baseline the A/V controller against where the decoder
      // actually is. hardResync() lives on the AvSync instance the player
      // owns (player.sync), not on the player itself.
      if (!document.hidden) this.player?.sync?.hardResync?.();
    });
  }

  bindPlayer() {
    this.player.addEventListener('state', (ev) => {
      const { state } = ev.detail;
      if (state === PLAYER_STATE.PLAYING) {
        this.setStatus('live', 'Live');
        this.setView(VIEW.PLAYING);
        this.setStreamEnded(false);
        this.describePlayback('Streaming now');
      } else if (state === PLAYER_STATE.BUFFERING) {
        this.setStatus('buffering', 'Buffering');
        this.setView(VIEW.BUFFERING, { keepCanvas: true });
      } else if (state === PLAYER_STATE.DEGRADED) {
        this.setStatus('buffering', 'Partial');
        this.showAudioState('degraded', ev.detail.transport === 'video' ? 'audio ok' : 'video ok', 'warn');
      } else if (state === PLAYER_STATE.CONNECTING) {
        this.setStatus('connecting', 'Connecting');
        this.setView(VIEW.CONNECTING);
      } else if (state === PLAYER_STATE.PAUSED) {
        // The picture is held but the stream is still running, so the status
        // says "paused" rather than "live" - and the sub-line carries how far
        // behind the live edge the held frame is, which is the thing a viewer
        // actually wants to know after pausing.
        this.setStatus('paused', 'Paused');
        this.setView(VIEW.PLAYING, { keepCanvas: true });
        this.setStreamEnded(false);
        this.describePlayback('Paused');
      } else if (state === PLAYER_STATE.ERROR) {
        this.setStatus('error', 'Error');
        this.setView(VIEW.ERROR, { message: ev.detail.message });
      }
    });

    // Paused is a live state, not a final one: the gap behind the live edge
    // grows every second, so it is refreshed rather than set once.
    this.player.addEventListener('player:paused', () => {
      this._syncPauseUi();
      this._startBehindLiveTicker();
    });
    this.player.addEventListener('player:resumed', (ev) => {
      this._stopBehindLiveTicker();
      this._syncPauseUi();
      // The jump is how far the picture moves forward, which is not the same as
      // how long the button was held: a frame that was already behind live
      // before the pause is caught up too.
      const secs = Math.round(ev.detail.jumpedMs / 1000);
      toast(
        secs >= 2 ? `Resumed at the live edge — jumped ${secs}s forward.` : 'Resumed at the live edge.',
        { tone: 'info', timeout: 2500 },
      );
    });

    this.player.addEventListener('video:up', (ev) => {
      this.el.videoWrap.dataset.hasVideo = 'true';
      this.startedAt ||= performance.now();
      const boot = ev.detail.bootMs;
      this.setStatus('live', 'Live');
      this.setView(VIEW.PLAYING);
      this.describePlayback('Streaming now');
      if (boot > 4000) {
        toast(`Video connected in ${(boot / 1000).toFixed(1)}s.`, { tone: 'info', timeout: 3000 });
      }
    });

    this.player.addEventListener('video:down', () => {
      this.showAudioState('video reconnecting', 'warn');
    });
    this.player.addEventListener('video:retrying', (ev) => {
      this.setStatus('buffering', 'Reconnecting');
      if (ev.detail.attempt > 1) {
        this.showAudioState(`video retry ${ev.detail.attempt}`, 'warn');
      }
    });
    this.player.addEventListener('video:error', (ev) => {
      this.showAudioState('video error', 'error');
      if (ev.detail.message) toast(ev.detail.message, { tone: 'error' });
    });
    this.player.addEventListener('video:failed', () => {
      toast('Video stream could not be recovered. Audio may still be playing.', {
        tone: 'error',
        title: 'Video lost',
      });
      this.setStatus('buffering', 'Audio only');
    });

    this.player.addEventListener('audio:state', (ev) => {
      const map = {
        loading: ['loading', ''],
        ready: ['ready', 'ok'],
        playing: ['playing', 'ok'],
        paused: ['paused', ''],
        stalled: ['stalling', 'warn'],
      };
      const [label, tone] = map[ev.detail.state] ?? ['ready', ''];
      this.showAudioState(label, tone);
    });
    // Autoplay is off in settings, so the audio is attached but deliberately not
    // started. Say so, rather than letting the viewer think the stream is mute.
    this.player.addEventListener('audio:awaiting-play', () => {
      this.showAudioState('press play to start audio', 'warn');
      this.describePlayback('Ready');
    });
    this.player.addEventListener('audio:retrying', (ev) => {
      this.showAudioState(`audio retry ${ev.detail.attempt}`, 'warn');
    });
    this.player.addEventListener('audio:blocked', () => {
      this.showAudioState('press play', 'warn');
      this.setStatus('buffering', 'Tap play');
    });
    this.player.addEventListener('video:unavailable', () => {
      this.showAudioState('no video track', 'warn');
      this.describePlayback('Audio only');
    });
    this.player.addEventListener('audio:unavailable', () => {
      this.showAudioState('no audio track', 'warn');
      this.describePlayback('Video only');
    });
    this.player.addEventListener('audio:error', () => {
      this.showAudioState('audio error', 'error');
    });
    this.player.addEventListener('audio:failed', () => {
      toast('Audio stream could not be recovered.', { tone: 'error', title: 'Audio lost' });
    });
    this.player.addEventListener('degraded', (ev) => {
      toast(
        ev.detail.transport === 'video'
          ? 'Video dropped, audio continues. Retrying…'
          : 'Audio stalled, video continues. Retrying…',
        { tone: 'warn', timeout: 3000 },
      );
    });
    this.player.addEventListener('sync:done', () => {
      this.showAudioState('resynced', 'ok');
    });
  }

  bindControl() {
    // No URI argument: passing one makes socket.io parse the string as a
    // *namespace*, and a path like "/control" is not a valid namespace. The
    // engine path is what actually selects the control channel.
    this.socket = window.io?.({
      path: '/control',
      transports: ['websocket', 'polling'],
      reconnectionDelay: 800,
      reconnectionDelayMax: 8000,
    });

    if (!this.socket) return;

    this.socket.on('connect', () => {
      this.subscribe();
    });
    this.socket.on('connect_error', (err) => {
      // Media does not depend on this channel, so this is informational only.
      console.warn('[cyberstream] control channel unavailable:', err?.message);
    });
    this.socket.on('session:state', (payload) => this.onServerState(payload));
    this.socket.on('session:meta', (payload) => this.onServerMeta(payload));
    this.socket.on('session:clock', (payload) => this.player.onServerClock(payload));
    this.socket.on('session:overflow', (payload) => this.onOverflow(payload));
    this.socket.on('disconnect', () => {
      if (this.session && !this.session.finished) {
        this.showAudioState('control offline', 'warn');
      }
    });
  }

  subscribe() {
    if (!this.session) return;
    this.socket.emit(
      'subscribe',
      {
        sessionId: this.session.sessionId,
        token: this.session.tokens.viewerToken,
        st: this.serverConfig?.streamToken ?? undefined,
      },
      (ack) => {
        if (ack && !ack.ok) {
          console.warn('[cyberstream] control subscribe refused:', ack.error);
        }
      },
    );
  }

  /* ------------------------------------------------------------- start -- */
  startFromInput() {
    const raw = this.el.urlInput.value;
    const url = normaliseInput(raw);
    if (!url) {
      this.markInvalid();
      toast('Paste a YouTube URL or video ID first.', { tone: 'warn' });
      this.el.urlInput.focus();
      return;
    }
    this.start(url);
  }

  async validateInline() {
    const url = normaliseInput(this.el.urlInput.value);
    if (!url) {
      this.el.urlbar.classList.remove('is-invalid');
      return;
    }
    try {
      const info = await api.validate(url);
      this.el.urlbar.classList.remove('is-invalid');
      this.el.urlInput.title = info.title ?? info.url;
    } catch {
      // Do not nag while typing: only a hard parse failure is worth a hint.
      this.el.urlbar.classList.add('is-invalid');
    }
  }

  markInvalid() {
    this.el.urlbar.classList.add('is-invalid');
    setTimeout(() => this.el.urlbar.classList.remove('is-invalid'), 1200);
  }

  /**
   * Copies the clipboard into the URL field.
   *
   * The clipboard read is permission-gated and can fail for several unrelated
   * reasons - denied permission, an insecure context, no clipboard API at all,
   * or simply nothing text-shaped on the clipboard. They are told apart here
   * because the useful next action differs: a permission problem wants a
   * keyboard hint, an empty clipboard wants the user to copy something first.
   *
   * The pasted text is trimmed and stripped of the stray whitespace and
   * zero-width characters that come along with a copy from a browser address
   * bar or a chat app, all of which `normaliseInput` would otherwise reject.
   */
  async pasteFromClipboard() {
    const btn = this.el.pasteBtn;
    const input = this.el.urlInput;
    btn?.classList.remove('is-ok', 'is-bad');

    // Never leave focus on the button: Enter should still submit the form.
    input.focus();

    if (!navigator.clipboard?.readText) {
      this._flashPaste('is-bad');
      toast('This browser will not let a page read the clipboard — press Ctrl+V instead.', {
        tone: 'warn',
        timeout: 4000,
      });
      return;
    }

    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      this._flashPaste('is-bad');
      toast(
        denied
          ? 'Clipboard access was blocked — press Ctrl+V to paste.'
          : 'Could not read the clipboard — press Ctrl+V instead.',
        { tone: 'warn', timeout: 4000 },
      );
      return;
    }

    const cleaned = cleanPasted(text);
    if (!cleaned) {
      this._flashPaste('is-bad');
      toast('There is no link on the clipboard.', { tone: 'warn', timeout: 2500 });
      return;
    }

    input.value = cleaned;
    // Show what landed rather than leaving the caret at the end of a long URL.
    input.setSelectionRange(0, cleaned.length);
    this.el.urlbar.classList.remove('is-invalid');
    this._flashPaste('is-ok');
    this.validateInline();
  }

  /** Briefly colours the paste buttons to acknowledge the outcome. */
  _flashPaste(cls) {
    const btns = [this.el.pasteBtn, this.el.overlayPasteBtn].filter(Boolean);
    if (!btns.length) return;
    for (const btn of btns) btn.classList.add(cls);
    clearTimeout(this._pasteFlashTimer);
    this._pasteFlashTimer = setTimeout(() => {
      for (const btn of btns) btn.classList.remove(cls);
    }, 1400);
  }

  async start(url, hint = {}) {
    if (this.abortController) this.abortController.abort();
    this.abortController = new AbortController();

    // Tear the previous stream down first: one stream at a time per tab.
    if (this.session) await this.stopStream({ silent: true });

    this.setBusy(true);
    this.setStatus('connecting', 'Resolving');
    this.setView(VIEW.CONNECTING, { message: 'Resolving video formats…' });
    this.el.overlayStop.hidden = true;
    this.el.nowTitle.textContent = hint.title ?? 'Loading…';
    this.el.nowSub.textContent = 'Starting FFmpeg…';
    this.el.videoWrap.dataset.hasVideo = 'false';
    this.clearStreamEnded();

    const t0 = performance.now();
    try {
      // Quality and autoplay come from the settings dialog; both were display
      // only until now, so the stream ignored whatever the user picked.
      const session = await api.createSession(url, {
        signal: this.abortController.signal,
        quality: this.settings.quality,
        autoplay: this.settings.autoplay,
      });
      this.adoptSession(session, hint, t0);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      this.handleStartError(err);
    } finally {
      this.setBusy(false);
    }
  }

  adoptSession(session, hint, t0) {
    this.session = {
      sessionId: session.sessionId,
      tokens: session.tokens,
      endpoints: session.endpoints,
      title: session.title ?? hint.title ?? 'Untitled stream',
      thumbnail: session.thumbnail ?? hint.thumb ?? null,
      isLive: session.isLive,
      duration: session.duration,
      hasAudio: session.hasAudio,
      hasVideo: session.hasVideo,
      missingTracks: session.missingTracks ?? { video: null, audio: null },
      strategy: session.strategy,
      // Both of these are read by describePlayback() and the quality badge; the
      // API returns them but the client session object used to drop them, which
      // is why the "adaptive source" hint never appeared.
      splitSource: session.splitSource ?? false,
      quality: session.quality ?? this.settings.quality ?? null,
      width: session.width ?? null,
      height: session.height ?? null,
      fps: session.fps ?? null,
      owner: true,
      finished: false,
    };

    const item = {
      id: session.videoId ?? session.sessionId,
      title: this.session.title,
      subtitle: hint.subtitle ?? 'Recently played',
      duration: this.session.duration ? fmt(session.duration) : 'live',
      thumb: this.session.thumbnail ?? hint.thumb ?? '',
      url: hint.url ?? `https://www.youtube.com/watch?v=${session.videoId}`,
    };
    // `remember: false` is a promise the settings dialog makes to the user, so
    // it has to actually keep the URL out of local history.
    if (this.settings.remember) this.catalog.pushHistory(item);
    this.catalog.setActive(item.id);
    this.catalog.addToQueue(item);

    this.el.nowTitle.textContent = this.session.title;
    this.el.nowSub.textContent = 'Connecting streams…';
    this.el.overlayStop.hidden = false;
    this.setStatus('connecting', 'Connecting');
    this.renderQualityBadge(session);

    this.player.start({
      sessionId: this.session.sessionId,
      videoUrl: session.endpoints.video,
      audioUrl: session.endpoints.audio,
      // Both transports start optimistically; a missing track is switched off
      // when the server tells us it will never produce one.
      missingTracks: this.session.missingTracks,
    });

    this.applyMissingTracks(this.session.missingTracks);

    this.subscribe();
    this.updateTransportEnabled();

    const ms = Math.round(performance.now() - t0);
    if (ms < 1500) {
      toast(`Stream ready in ${ms}ms.`, { tone: 'ok', timeout: 2500 });
    }
  }

  handleStartError(err) {
    this.setBusy(false);
    this.setStatus('error', 'Error');
    this.setView(VIEW.ERROR, { message: err?.message ?? 'Could not start the stream.' });
    this.el.overlayStop.hidden = true;
    this.el.nowTitle.textContent = '— Failed to load —';
    this.el.nowSub.textContent = err?.message ?? 'Unknown error';
    toast(err?.message ?? 'Could not start the stream.', {
      tone: 'error',
      title: err instanceof ApiError ? `Error ${err.status || ''}`.trim() : 'Failed',
    });
  }

  /* -------------------------------------------------------------- stop -- */
  async stopStream({ user = false, silent = false } = {}) {
    const session = this.session;
    this.player.stop();
    this.setStreamEnded(true);
    this.el.videoWrap.dataset.hasVideo = 'false';
    this.session = null;
    // The gap-behind-live ticker only makes sense while a stream is running.
    this._stopBehindLiveTicker();
    this._syncPauseUi();

    if (session) {
      try {
        // Best effort: the server also reaps on its own timer.
        await fetch(session.endpoints.stop, { method: 'DELETE', cache: 'no-store' });
      } catch {
        if (user) toast('Could not confirm the stop; the server will reap it shortly.', {
          tone: 'warn',
          timeout: 4000,
        });
      }
    }

    this.catalog.setActive(null);
    this.updateTransportEnabled();
    this.clearBufferStats();

    if (silent) return;

    if (user) {
      this.setStatus('ready', 'Ready');
      this.setView(VIEW.STOPPED);
      this.el.nowTitle.textContent = '— Stream stopped —';
      this.el.nowSub.textContent = 'Ready to play';
    }
  }

  /* ------------------------------------------------- server control events -- */
  onServerState(payload) {
    if (!this.session || payload.sessionId !== this.session.sessionId) return;

    if (payload.state === 'live') {
      this.setStatus('connecting', 'Live');
      return;
    }
    if (payload.state === 'stopping') {
      this.finishStream('Stream stopped by the server.');
      return;
    }
    if (payload.state === 'ended') {
      this.finishStream('Source finished.');
      return;
    }
    if (payload.state === 'failed') {
      this.setStatus('error', 'Error');
      this.setView(VIEW.ERROR, { message: payload.error?.message ?? 'The stream failed.' });
      this.el.nowSub.textContent = payload.error?.message ?? 'Failed';
      toast(payload.error?.message ?? 'The stream failed.', { tone: 'error' });
      this.updateTransportEnabled();
    }
  }

  onServerMeta(payload) {
    if (!this.session || payload.sessionId !== this.session.sessionId) return;
    if (payload.title) {
      this.session.title = payload.title;
      this.el.nowTitle.textContent = payload.title;
    }
    if (payload.missingTracks) this.applyMissingTracks(payload.missingTracks);
    this.renderQualityBadge(payload);
  }

  /** FFmpeg tells us which outputs it will never fill (silent/silent-video sources). */
  applyMissingTracks(missing = {}) {
    if (!this.session) return;
    this.session.missingTracks = missing;
    if (missing.video === 'no-such-track' && this.player.hasVideo) {
      this.player.disableVideo();
    }
    if (missing.audio === 'no-such-track' && this.player.hasAudio) {
      this.player.disableAudio();
    }
  }

  onOverflow(payload) {
    if (payload.kind === 'video') {
      this.setStatus('buffering', 'Catching up');
      this.showAudioState('video shedding', 'warn');
    } else if (payload.kind === 'audio') {
      this.showAudioState('audio shedding', 'warn');
    } else if (payload.kind === 'audio-start') {
      this.setView(VIEW.BUFFERING, { message: 'No audio data yet…' });
    }
  }

  finishStream(message) {
    this.player.markFinished();
    this.player.stop({ keepState: true });
    this.setStreamEnded(true);
    this.setStatus('ended', 'Ended');
    this.setView(VIEW.ENDED, { message });
    this.el.nowSub.textContent = message;
    this.updateTransportEnabled();
  }

  setStreamEnded(on) {
    if (this.session) this.session.finished = on;
  }
  clearStreamEnded() {
    if (this.session) this.session.finished = false;
  }

  /* ------------------------------------------------------------- view -- */
  setView(mode, { message, keepCanvas = false } = {}) {
    this.view = mode;
    this.el.overlay.dataset.mode = mode;

    const titleMap = {
      [VIEW.IDLE]: 'No Signal',
      [VIEW.CONNECTING]: 'Connecting',
      [VIEW.BUFFERING]: 'Buffering',
      [VIEW.ENDED]: 'Stream Ended',
      [VIEW.STOPPED]: 'Stopped',
      [VIEW.ERROR]: 'Stream Error',
    };

    this.el.spinner.hidden = mode !== VIEW.CONNECTING && mode !== VIEW.BUFFERING;
    this.el.meter.hidden = mode === VIEW.IDLE || mode === VIEW.ERROR;
    this.el.overlayActions.hidden = mode !== VIEW.IDLE;
    this.el.overlayPlay.hidden = mode === VIEW.CONNECTING;

    if (mode === VIEW.PLAYING) {
      if (keepCanvas) this.el.overlay.dataset.mode = mode;
      return;
    }

    if (titleMap[mode]) this.el.overlayTitle.textContent = titleMap[mode];
    this.el.overlaySub.textContent =
      message ??
      {
        [VIEW.IDLE]: 'Paste a YouTube URL above or pick a video below to start.',
        [VIEW.CONNECTING]: 'Resolving video formats…',
        [VIEW.BUFFERING]: 'Waiting for the first frame…',
        [VIEW.ENDED]: 'The source finished playing.',
        [VIEW.STOPPED]: 'You stopped this stream.',
        [VIEW.ERROR]: 'Something went wrong.',
      }[mode] ??
      '';

    if (mode === VIEW.CONNECTING) this.el.spinnerText.textContent = 'Starting stream…';
    if (mode === VIEW.BUFFERING) this.el.spinnerText.textContent = 'Buffering…';
  }

  /**
   * Keeps the secondary line under the title honest about what is actually
   * happening, instead of leaving a stale "Connecting" behind.
   */
  describePlayback(prefix) {
    if (!this.session) return;
    const cfg = this.serverConfig?.media;
    const bits = [];
    // The live session's own dimensions, not the server default: with a quality
    // override in play they differ, and showing the default would be a lie.
    const w = this.session.width ?? cfg?.width;
    const h = this.session.height ?? cfg?.height;
    if (w && h) bits.push(`${w}×${h} · MPEG-1/TS`);
    if (this.session.splitSource) bits.push('adaptive source');
    if (this.session.quality) bits.push(`${this.session.quality} quality`);
    if (!this.player.hasAudio) bits.push('no audio track');
    if (!this.player.hasVideo) bits.push('no video track');
    // While paused both playheads are frozen, so the drift figure describes a
    // state that is no longer running. Showing it would be worse than showing
    // nothing: it invites the reader to trust a number about a picture that is
    // not advancing.
    if (!this.player.paused) {
      const drift = this.player.sync.snapshot();
      if (drift.calibrated) bits.push(`sync ${drift.driftMs >= 0 ? '+' : ''}${drift.driftMs}ms`);
    }
    this.el.nowSub.textContent = bits.length ? `${prefix} · ${bits.join(' · ')}` : prefix;
  }

  setStatus(state, text) {
    this.el.statusPill.dataset.state = state;
    this.el.statusPill.querySelector('.status-pill__text').textContent = text;
  }

  /* --------------------------------------------------------- pause / ui -- */
  /**
   * Mirrors the player's paused flag onto the button and the sub-line.
   *
   * The sub-line matters: pausing a live stream is only safe because resume
   * rejoins the live edge, and that is invisible unless the UI says how far
   * behind the viewer now is. Without it, "paused" looks like a local freeze
   * and users reasonably expect to continue where they stopped.
   */
  _syncPauseUi() {
    const paused = this.player.paused;
    const btn = this.el.pauseBtn;
    if (btn) {
      btn.classList.toggle('is-active', paused);
      btn.setAttribute('aria-pressed', String(paused));
      const label = paused ? 'Resume at the live edge' : 'Pause';
      btn.setAttribute('aria-label', label);
      btn.title = label;
      btn.querySelector('.tbtn__icon-pause').hidden = paused;
      btn.querySelector('.tbtn__icon-play').hidden = !paused;
    }
    if (paused) this._renderBehindLive();
    else this._setPauseSub(null);
  }

  _startBehindLiveTicker() {
    this._stopBehindLiveTicker();
    this._behindLiveTimer = setInterval(() => this._renderBehindLive(), 1000);
  }

  _stopBehindLiveTicker() {
    if (this._behindLiveTimer) clearInterval(this._behindLiveTimer);
    this._behindLiveTimer = null;
  }

  _renderBehindLive() {
    const behind = this.player.behindLiveMs();
    if (behind === null) {
      this._setPauseSub('Paused');
      return;
    }
    const secs = Math.round(behind / 1000);
    this._setPauseSub(
      secs < 1 ? 'Paused — at the live edge' : `Paused — ${secs}s behind live`,
    );
  }

  _setPauseSub(text) {
    if (text === null) this.describePlayback('Streaming now');
    else this.describePlayback(text);
  }

  showAudioState(label, tone = '') {
    const el = this.el.audioState;
    el.textContent = label;
    el.dataset.tone = tone;
    el.hidden = !label;
    if (label) {
      clearTimeout(this._audioStateTimer);
      this._audioStateTimer = setTimeout(() => {
        el.hidden = true;
      }, 4000);
    }
  }

  setBusy(busy) {
    this.el.loadBtn.classList.toggle('is-busy', busy);
    this.el.loadBtn.disabled = busy;
  }

  updateTransportEnabled() {
    const live = Boolean(this.session);
    for (const id of ['#restart-btn', '#resync-btn', '#skip-back', '#link-btn', '#pause-btn']) {
      const el = $(id);
      if (el) el.disabled = !live;
    }
    // Mute/PiP/fullscreen act on the local decoder, so they are valid as soon as
    // anything is playing. Stop and share are owner/URL concerns: a viewer who
    // arrived on a share link must not be offered a stop button that the server
    // will refuse anyway.
    const owner = Boolean(this.session?.owner);
    this.el.overlayStop.hidden = !owner;
    const share = $('#link-btn');
    if (share) share.disabled = !live || !owner;
  }

  /* ------------------------------------------------------------ meters -- */
  tick() {
    if (!this.session || this.view === VIEW.IDLE) return;

    const audio = this.el.audioEl;
    // Buffer ahead: how much audio the browser has but has not played yet.
    let buffered = 0;
    try {
      if (audio.buffered.length) buffered = audio.buffered.end(audio.buffered.length - 1) - audio.currentTime;
    } catch {
      buffered = 0;
    }
    this.bufferSamples.push(Math.max(0, buffered));
    if (this.bufferSamples.length > 8) this.bufferSamples.shift();

    const avg =
      this.bufferSamples.reduce((a, b) => a + b, 0) / (this.bufferSamples.length || 1);

    this.el.meterBuffer.textContent = `${avg.toFixed(1)}s`;
    this.el.meterBar.style.width = `${Math.min(100, (avg / 6) * 100)}%`;

    const sync = this.player.sync.snapshot();
    const latency = this.estimateLatency(avg);
    this.el.meterLatency.textContent = latency === null ? '—' : `~${latency.toFixed(1)}s`;

    if (this.el.quality.hidden === false) {
      // This badge is refreshed every tick, so it has to carry the resolution
      // itself: renderQualityBadge() sets it once and is immediately overwritten.
      // Without this the chosen quality would have no persistent display.
      const w = this.session.width;
      const h = this.session.height;
      const dims = w && h ? `${esc(String(w))}×${esc(String(h))} ` : '';
      this.el.quality.innerHTML = `<b>${esc(String(this.session.strategy ?? '—'))}</b> ${dims}· drift ${
        sync.driftMs
      }ms · rate ${sync.rate}`;
    }
  }

  /**
   * End-to-end latency is not directly observable from the browser, so we
   * report the honest lower bound we *can* measure: mux delay plus the audio
   * the browser is holding back.
   */
  estimateLatency(bufferedSeconds) {
    if (!this.serverConfig) return null;
    return (this.serverConfig.media?.muxDelayMs ?? 100) / 1000 + bufferedSeconds;
  }

  clearBufferStats() {
    this.bufferSamples = [];
    this.el.meterBuffer.textContent = '—';
    this.el.meterLatency.textContent = '—';
    this.el.meterBar.style.width = '0%';
  }

  renderQualityBadge(session = null) {
    const cfg = this.serverConfig?.media;
    if (!cfg) return;
    const strategy = session?.strategy ?? this.session?.strategy;
    // Prefer what this session is actually producing; fall back to the server
    // default before a session exists.
    const src = session ?? this.session;
    const w = src?.width ?? cfg.width;
    const h = src?.height ?? cfg.height;
    const fps = src?.fps ?? cfg.fps;
    const parts = [`<b>${esc(String(w))}×${esc(String(h))}</b> ${esc(String(fps))}fps`];
    // bitrate and strategy both originate from configuration/transcoder state,
    // so they are escaped rather than trusted into innerHTML.
    parts.push(esc(String(cfg.audio.bitrate)));
    if (strategy) parts.push(esc(String(strategy)));
    this.el.quality.innerHTML = parts.filter(Boolean).join(' · ');
    this.el.quality.hidden = false;
  }

  /* ------------------------------------------------------------ extras -- */
  /**
   * Copies a link that actually replays this stream.
   *
   * The viewer token has to travel in the query string: the media endpoints are
   * consumed by a WebSocket and an `<audio>` element, neither of which can send
   * an Authorization header, and the same is true of the session lookup on load.
   * It is a bearer credential, so the link grants viewing of this one stream and
   * nothing else - it is not the owner token and cannot stop the session.
   */
  async copyShareLink() {
    if (!this.session) return;
    const url = new URL(location.origin + location.pathname);
    url.searchParams.set('session', this.session.sessionId);
    url.searchParams.set('token', this.session.tokens.viewerToken);
    if (this.serverConfig?.streamToken) url.searchParams.set('st', this.serverConfig.streamToken);
    try {
      await navigator.clipboard.writeText(url.toString());
      toast('Viewer link copied to clipboard.', { tone: 'ok', timeout: 2500 });
    } catch {
      toast(url.toString(), { title: 'Viewer link', timeout: 12000 });
    }
  }

  /**
   * Adopts a stream from a `?session=&token=` share link.
   *
   * Runs once at startup. A 404 here is the normal case for an expired session
   * and is reported quietly rather than as an error, since most visits have no
   * link at all.
   */
  async adoptFromLink() {
    const params = new URLSearchParams(location.search);
    const id = params.get('session');
    const token = params.get('token');
    if (!id || !token) return;

    // Do not keep the credential in the address bar or in history.
    window.history.replaceState(null, '', location.origin + location.pathname);

    let info;
    try {
      info = await api.session(id, token);
    } catch (err) {
      toast(err?.message ?? 'That shared stream is no longer available.', {
        tone: 'error',
        title: 'Link expired',
      });
      return;
    }

    if (info.state === 'ended' || info.state === 'failed' || info.state === 'stopping') {
      toast('That stream has already finished.', { tone: 'warn', title: 'Nothing to play' });
      return;
    }

    const st = params.get('st') ?? this.serverConfig?.streamToken ?? undefined;
    const base = st ? `?token=${encodeURIComponent(token)}&st=${encodeURIComponent(st)}` : `?token=${encodeURIComponent(token)}`;

    this.session = {
      sessionId: info.sessionId,
      tokens: { viewerToken: token },
      // A viewer never owns the stream, so the stop control stays hidden.
      owner: false,
      title: info.title ?? 'Shared stream',
      thumbnail: info.thumbnail ?? null,
      duration: info.duration ?? null,
      isLive: info.isLive ?? false,
      hasAudio: info.hasAudio ?? true,
      hasVideo: info.hasVideo ?? true,
      missingTracks: info.missingTracks ?? { video: null, audio: null },
      strategy: info.strategy ?? null,
      splitSource: info.splitSource ?? false,
      quality: info.quality ?? null,
      width: info.width ?? null,
      height: info.height ?? null,
      fps: info.fps ?? null,
      finished: false,
    };

    this.el.nowTitle.textContent = this.session.title;
    this.el.nowSub.textContent = 'Joining shared stream…';
    this.setStatus('connecting', 'Connecting');
    this.setView(VIEW.CONNECTING);
    this.renderQualityBadge();
    this.el.overlayStop.hidden = true;

    this.player.start({
      sessionId: this.session.sessionId,
      videoUrl: `/ws/video?sessionId=${encodeURIComponent(info.sessionId)}${base}`,
      audioUrl: `/api/stream/${encodeURIComponent(info.sessionId)}/audio.mp3${base}`,
      missingTracks: this.session.missingTracks,
    });
    this.applyMissingTracks(this.session.missingTracks);
    this.subscribe();
    this.updateTransportEnabled();
    toast('Joined a shared stream (view only).', { tone: 'info', timeout: 3000 });
  }

  async togglePip() {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }
      // A canvas is not a video element, so PiP needs a captureStream bridge.
      const canvas = $('#video-canvas');
      if (!canvas?.captureStream) {
        toast('Picture-in-picture is not supported here.', { tone: 'warn' });
        return;
      }
      const video = document.createElement('video');
      video.srcObject = canvas.captureStream(30);
      video.muted = true;
      video.playsInline = true;
      await video.play();
      this.pipVideo = video;
      await video.requestPictureInPicture();
      video.addEventListener('leavepictureinpicture', () => {
        video.srcObject = null;
        this.pipVideo = null;
      });
    } catch (err) {
      toast(err?.message ?? 'Picture-in-picture failed.', { tone: 'warn' });
    }
  }

  /**
   * Toggles full screen for the player.
   *
   * The *stage* is the target rather than the bare canvas: it contains the
   * transport bar and the `<audio controls>` element, and fullscreening the
   * canvas alone would hide both - leaving a viewer who went full screen unable
   * to see the audio controls the brief requires, or to stop the stream.
   *
   * The state is tracked from the `fullscreenchange` event rather than assumed
   * from the click, because the user can also leave full screen with Escape or
   * the browser's own gesture, and a button that still reads "enter" at that
   * point is worse than no button.
   */
  async toggleFullscreen() {
    const target = this.el.stage ?? document.documentElement;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      if (!target.requestFullscreen) {
        toast('This browser does not support full screen.', { tone: 'warn' });
        return;
      }
      // `requestFullscreen()` does not reliably settle: when the document is not
      // focused, or the user gesture has already been consumed, Chrome can
      // leave the returned promise pending forever. Awaiting it unguarded hangs
      // the click handler, so the button looks dead and never recovers. Racing
      // it against a short timer turns "stuck" into a visible message.
      await withTimeout(
        target.requestFullscreen({ navigationUI: 'hide' }),
        FULLSCREEN_TIMEOUT_MS,
        'Full screen was blocked by the browser.',
      );
    } catch (err) {
      toast(err?.message ?? 'Could not enter full screen.', { tone: 'warn' });
    }
  }

  /**
   * Keeps both full screen buttons' icons and labels in step with reality, and
   * mirrors the state onto the stage as a class.
   *
   * The class is not redundant with `:fullscreen`. The pseudo-class is the
   * mechanism that hides the page chrome, but it is unavailable in embedded or
   * partially-implemented contexts, and it cannot be exercised without actually
   * entering full screen. Driving layout from a class as well means the same
   * rules apply either way, and the layout can be tested directly.
   */
  _syncFullscreenState() {
    const active = document.fullscreenElement === this.el.stage;
    this.el.stage?.classList.toggle('is-fullscreen', active);
    for (const btn of document.querySelectorAll('.js-fullscreen-toggle')) {
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
      const label = btn.querySelector('.tbtn__icon-collapse')
        ? (active ? 'Exit full screen' : 'Play video full screen')
        : (active ? 'Exit full screen' : 'Toggle fullscreen');
      btn.setAttribute('aria-label', label);
      btn.title = label;
      const expand = btn.querySelector('.tbtn__icon-expand');
      const collapse = btn.querySelector('.tbtn__icon-collapse');
      if (expand) expand.hidden = active;
      if (collapse) collapse.hidden = !active;
    }
  }

  selectTab(tab) {
    for (const other of document.querySelectorAll('.tab')) {
      const active = other === tab;
      other.classList.toggle('is-active', active);
      other.setAttribute('aria-selected', String(active));
    }
    for (const panel of document.querySelectorAll('.panel')) {
      const active = panel.id === `panel-${tab.dataset.panel}`;
      panel.classList.toggle('is-active', active);
      panel.hidden = !active;
    }
  }

  /**
   * Builds the quality menu from the presets the server advertises, so the
   * labels always match what FFmpeg will actually be asked to produce and the
   * menu can never offer a resolution above the operator's ceiling.
   */
  fillQualityOptions() {
    const sel = $('#set-quality');
    if (!sel) return;
    const qualities = this.serverConfig?.media?.qualities ?? null;
    const hints = { low: 'smoothest', standard: 'recommended', high: 'sharpest' };
    const entries = Object.entries(qualities ?? {});
    if (!entries.length) {
      // No advertised presets (older server): fall back to the reported default.
      const cfg = this.serverConfig?.media;
      if (cfg) entries.push(['default', { width: cfg.width, height: cfg.height, fps: cfg.fps }]);
    }
    if (!entries.length) {
      // The server config has not loaded, or the request failed. Clearing the
      // select here would leave it empty, and saving from an empty select writes
      // '' - silently destroying the user's saved preference and then sending
      // no quality at all. Leave whatever is already there untouched.
      return false;
    }
    sel.replaceChildren(
      ...entries.map(([name, v]) => {
        const opt = document.createElement('option');
        opt.value = name === 'default' ? '' : name;
        const label = `${name === 'default' ? 'Default' : name} — ${v.width}×${v.height}, ${v.fps}fps`;
        opt.textContent = hints[name] ? `${label} (${hints[name]})` : label;
        return opt;
      }),
    );
    if (![...sel.options].some((o) => o.value === this.settings.quality)) {
      // Prefer the preset that matches the server's own default shape, so a user
      // who has never opened Settings gets the operator's intended quality
      // rather than whatever happens to be listed first.
      const wanted = `${this.serverConfig?.media?.width}x${this.serverConfig?.media?.height}`;
      const match =
        entries.find(([, v]) => `${v.width}x${v.height}` === wanted) ??
        entries.find(([n]) => n === 'standard') ??
        entries[0];
      this.settings.quality = match && match[0] !== 'default' ? match[0] : '';
    }
    return true;
  }

  /**
   * Steps the quality down one notch and restarts the stream.
   *
   * Only ever downward, and only when the current setting is above the cheapest
   * preset. An automatic drop is the right call here because the user cannot
   * diagnose the symptom themselves - the stream is healthy, their machine is
   * not - and a stuttering picture is worse than a smaller one. The toast says
   * what happened, so it is not a silent downgrade.
   */
  async _dropQualityForDecode() {
    const order = ['high', 'standard', 'low'];
    const current = order.indexOf(this.settings.quality);
    const next = current < 0 ? 'low' : order[Math.min(current + 1, order.length - 1)];
    if (next === this.settings.quality) return false; // already at the floor
    this.settings.quality = next;
    store.set(SETTINGS_KEY, this.settings);

    // Restart with the new encoder settings, if there is something running.
    const url = this.el.urlInput.value;
    if (url) {
      const normalised = normaliseInput(url);
      if (normalised) {
        await this.start(normalised, { reason: 'decode-bound' });
        return true;
      }
    }
    return true;
  }

  openSettings() {
    const dialog = $('#settings-dialog');
    const sel = $('#set-quality');
    this.fillQualityOptions();
    // Only mirror the stored setting into the select when that option actually
    // exists. Assigning a value a <select> does not have silently yields '',
    // which would then be saved back as "no preference".
    const wanted = String(this.settings.quality ?? '');
    if ([...sel.options].some((o) => o.value === wanted)) sel.value = wanted;
    $('#set-sync').value = this.settings.sync ? 'on' : 'off';
    $('#set-autoplay').checked = this.settings.autoplay;
    $('#set-remember').checked = this.settings.remember;
    dialog.showModal();
  }

  openApiDialog() {
    const dialog = $('#api-dialog');
    $('#api-input').value = apiOrigin() === location.origin ? '' : apiOrigin();
    dialog.showModal();
  }

  setApiSource(state) {
    const el = this.el.apiSource;
    if (state === 'error') {
      el.textContent = 'unreachable';
      el.dataset.state = 'error';
    } else if (isRemote()) {
      el.textContent = new URL(apiOrigin()).host;
      el.dataset.state = 'remote';
    } else {
      el.textContent = 'Local';
      el.dataset.state = 'local';
    }
  }

  renderApiSource() {
    this.setApiSource('ok');
  }

  /**
   * Persists and applies the settings dialog.
   *
   * `quality` is intentionally not applied to the running stream: the resolution
   * and frame rate are baked into the FFmpeg command line when the session
   * starts, so changing it mid-stream would mean restarting FFmpeg and
   * renegotiating both transports. It applies to the next stream, and the toast
   * says so rather than implying an immediate effect.
   */
  applySettings(next) {
    // An empty quality means "no override", not "clear my preference". If the
    // preset list could not be built (server config still loading, or the
    // request failed) the select reads as empty, and honouring that would wipe a
    // real stored choice on every save.
    const merged = { ...this.settings, ...next };
    if (!merged.quality) merged.quality = this.settings.quality ?? '';
    this.settings = merged;
    store.set(SETTINGS_KEY, this.settings);
    // These two are live controls and take effect immediately.
    this.player.setSyncEnabled(this.settings.sync);
    this.player.setAutoplay(this.settings.autoplay);
    toast(
      this.session ? 'Settings saved. Quality applies to the next stream.' : 'Settings saved.',
      { tone: 'ok' },
    );
  }
}

function fmt(seconds) {
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/* -------------------------------------------------------------- wiring -- */
const app = new App();
window.cyberstream = app; // handy for debugging in the console

// Bound to the form's `submit`, not the dialog's `close`.
//
// `close` is the more obvious hook but it cannot distinguish Save from the
// "Close" button except by returnValue, and it also fires for Escape and for a
// click on the backdrop - all of which would silently save. `submit` only fires
// for an actual submit, and it fires for both the button and Enter, which makes
// it both simpler and more correct.
$('#settings-dialog form')?.addEventListener('submit', (ev) => {
  const submitter = ev.submitter;
  if (submitter && submitter.value !== 'save') return; // the "Close" button
  app.applySettings({
    quality: $('#set-quality').value,
    sync: $('#set-sync').value === 'on',
    autoplay: $('#set-autoplay').checked,
    remember: $('#set-remember').checked,
  });
});

// Same reasoning as the settings form: bind `submit` and use the submitter's
// value, so Escape and a backdrop click cannot repoint the client at another
// server.
$('#api-dialog form')?.addEventListener('submit', async (ev) => {
  const value = ev.submitter?.value ?? 'save';
  const input = $('#api-input').value.trim();
  try {
    if (value === 'reset') {
      configureApi('');
    } else if (value === 'save' && input) {
      configureApi(input);
    } else {
      return;
    }
    app.renderApiSource();
    const cfg = await api.config();
    app.serverConfig = cfg;
    app.renderQualityBadge();
    // The catalog comes from the (possibly new) server, so the preset list has
    // to be rebuilt from its config too or the menu would describe the old host.
    app.fillQualityOptions();
    await app.catalog.load();
    toast('API endpoint updated.', { tone: 'ok' });
  } catch {
    configureApi('');
    app.renderApiSource();
    toast('That endpoint is not a CyberStream server.', { tone: 'error' });
  }
});

app.init().catch((err) => {
  console.error(err);
  toast('The dashboard failed to start. Check the console.', { tone: 'error' });
});

export { app, VIEW, throttle };
