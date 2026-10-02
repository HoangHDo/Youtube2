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

/** @returns {{ffmpeg:object, ytDlp:object, canResolveYouTube:boolean, ready:boolean}} */
export function snapshot() {
  const canResolve = canResolveYouTube();
  return {
    ffmpeg: { ...state.ffmpeg },
    ytDlp: { ...state.ytDlp },
    canResolveYouTube: canResolve,
    // Ready means: able to serve the primary use case. A deployment with no
    // yt-dlp can still stream direct media URLs, which is why this is separate
    // from liveness rather than folded into it.
    ready: state.ffmpeg.ok && canResolve,
    degraded: state.ffmpeg.checked && (!state.ffmpeg.ok || !canResolve),
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