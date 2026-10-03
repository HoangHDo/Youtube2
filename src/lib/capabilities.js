import { childLogger } from './logger.js';

const log = childLogger({ mod: 'capabilities' });

/**
 * What this deployment can actually do, as established by the boot probes.
 *
 * The probes in server.js run once at startup and were previously only logged.
 * That made a missing dependency invisible from outside the process: the service
 * reported itself healthy and Render declared the deploy successful, while every
 * YouTube URL then failed at resolve time - a long way from the cause.
 *
 * These are kept so `/api/health`, `/api/config` and the UI can report them.
 *
 * Note the deliberate split between the two health endpoints:
 *
 *   liveness  - is the process up? Always true once listening, so a monitor or
 *               orchestrator never restart-loops a service that is merely
 *               degraded. An unavailable dependency is not a reason to restart
 *               the same code again.
 *   readiness - can it do its job? False when a dependency the primary feature
 *               needs is absent, which is the signal worth alerting on.
 */

const state = {
  ffmpeg: { ok: false, checked: false, version: null, error: null },
  ytDlp: { ok: false, checked: false, version: null, error: null },
};

/**
 * Is this process running from the bundled Docker image?
 *
 * The image sets `CYBERSTREAM_IMAGE=1`; nothing else does. That makes the one
 * overwhelmingly common cause of a missing dependency *detectable from the
 * inside* rather than guessable from the outside.
 *
 * The failure it explains: a host such as Render defaults a Node service to its
 * own native runtime and runs `npm start`, so the image is never built and
 * yt-dlp is simply not installed. The deploy reports success, the app serves
 * pages, and every YouTube URL fails at resolve time - which reads like a broken
 * link rather than a deployment mistake.
 *
 * @returns {boolean}
 */
export function inBundledImage() {
  return process.env.CYBERSTREAM_IMAGE === '1';
}

/**
 * Records a probe result.
 * @param {'ffmpeg'|'ytDlp'} name
 * @param {{ok:boolean, version?:string, error?:string}} result
 */
export function recordProbe(name, result) {
  if (!state[name]) throw new Error(`unknown capability: ${name}`);
  state[name] = {
    ok: Boolean(result.ok),
    checked: true,
    version: result.version ?? null,
    error: result.error ?? null,
  };
}

/**
 * Can this deployment resolve a YouTube URL?
 *
 * This is the question a user actually asks when the app loads, so it gates the
 * whole YouTube path rather than only the resolve step: without yt-dlp there is
 * no video ID, no direct media URL and nothing to stream.
 */
export function canResolveYouTube() {
  return state.ytDlp.ok === true;
}

/** @returns {{ffmpeg:object, ytDlp:object, canResolveYouTube:boolean, ready:boolean, degraded:boolean}} */
export function snapshot() {
  const canResolve = canResolveYouTube();
  return {
    ffmpeg: { ...state.ffmpeg },
    ytDlp: { ...state.ytDlp },
    canResolveYouTube: canResolve,
    // Ready means: able to serve the primary use case. A deployment with no
    // yt-dlp can still stream direct media URLs, which is why this is separate
    // from liveness rather than folded into it. Unprobed counts as not ready,
    // since readiness is a claim about capability and nothing has been shown yet.
    ready: state.ffmpeg.ok && canResolve,
    // Degraded means: something we *checked* is broken. Not the same as
    // "not ready" - an unprobed deployment is not yet known to be degraded, and
    // a missing yt-dlp on its own must not be masked by an unprobed ffmpeg.
    degraded:
      (state.ffmpeg.checked && !state.ffmpeg.ok)
      || (state.ytDlp.checked && !state.ytDlp.ok),
  };
}

/**
 * One-line explanation of what is missing, for logs and error messages.
 * @returns {string|null}
 */
export function degradationReason() {
  const parts = [];
  if (state.ffmpeg.checked && !state.ffmpeg.ok) {
    parts.push('ffmpeg is not usable (streams cannot be transcoded at all)');
  }
  if (state.ytDlp.checked && !state.ytDlp.ok) {
    parts.push(
      'yt-dlp is missing (every YouTube URL will fail to resolve; direct media URLs still work)',
    );
    // Say *why* it is missing when we can tell, because "install yt-dlp" is the
    // wrong instruction for someone who already has a Dockerfile that bundles
    // it and simply is not running it.
    if (!inBundledImage()) {
      parts.push(
        'this process is not running from the bundled Docker image (CYBERSTREAM_IMAGE is unset), ' +
          'so the host is probably using its own native runtime and never installed yt-dlp - ' +
          'deploy the Dockerfile, or set Runtime to Dockerfile on the service',
      );
    } else {
      parts.push(
        'this is the bundled image, so yt-dlp should already be present - ' +
          'the image may be stale, or YT_DLP_PATH may be pointing somewhere wrong',
      );
    }
  }
  return parts.length ? parts.join('; ') : null;
}

/** Test seam: forget every recorded probe. */
export function resetProbes() {
  for (const name of Object.keys(state)) {
    state[name] = { ok: false, checked: false, version: null, error: null };
  }
  log.debug('probe state reset');
}