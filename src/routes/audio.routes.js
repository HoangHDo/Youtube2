/**
 * HTTP transport for the MP3 audio track.
 *
 * Plain chunked `audio/mpeg` - the format an <audio controls> element can
 * consume directly. No seek index, no caching, no buffering proxy in front:
 * whatever FFmpeg produces goes straight to the socket.
 *
 * Flow control: the browser is allowed to fall a little behind (its own media
 * pipeline buffers), but not without limit. If a client stops reading we shed
 * audio chunks and tell it over the control channel, rather than stalling the
 * FFmpeg pipe and taking the video down with it.
 */
import { Router } from 'express';
import { requireViewer, NO_STORE } from '../middleware/auth.js';
import { AUDIO_HIGH_WATER, SESSION_STATE } from '../lib/session-store.js';
import { childLogger } from '../lib/logger.js';

const FIRST_BYTE_TIMEOUT_MS = 30_000;

export function createAudioRouter() {
  const router = Router();
  const log = childLogger({ mod: 'audio' });

  router.get('/stream/:sessionId/audio.mp3', requireViewer, (req, res) => {
    const session = req.streamSession;

    res.status(200);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', NO_STORE);
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // tell nginx/proxies not to buffer
    res.setHeader('X-Session-Id', session.id);
    res.setHeader('X-Audio-Format', `mp3; bitrate=${res.req.app.locals.audioBitrateHint ?? ''}`);
    // A live stream has no length and no range support; saying so explicitly
    // stops browsers from trying to seek.
    res.setHeader('Accept-Ranges', 'none');
    res.flushHeaders?.();

    if (req.method === 'HEAD') return res.end();

    if (
      session.missingTracks.audio === 'no-such-track' ||
      (session.state === SESSION_STATE.ENDED && !session.hasAudio)
    ) {
      log.info({ session: session.id }, 'audio requested but source has no audio track');
      res.setHeader('Content-Type', 'application/json');
      return res
        .status(404)
        .json({ error: 'no_audio_track', message: 'This video has no audio track.' });
    }

    let bytes = 0;
    let dropped = 0;
    let closed = false;
    let firstByteTimer = setTimeout(() => {
      if (bytes === 0 && !closed) {
        log.warn({ session: session.id }, 'no audio data arrived in time');
        session.emit('overflow', { kind: 'audio-start', at: Date.now() });
        finish('start-timeout');
      }
    }, FIRST_BYTE_TIMEOUT_MS);
    firstByteTimer.unref?.();

    const subscriber = {
      write(chunk) {
        if (closed) return;
        // Shed before the socket buffer grows without bound.
        if (res.writableLength > AUDIO_HIGH_WATER) {
          dropped += chunk.length;
          session.stats.audioDropped += chunk.length;
          session.maybeNotifyOverflow('audio');
          return;
        }
        bytes += chunk.length;
        if (bytes === chunk.length) {
          clearTimeout(firstByteTimer);
          firstByteTimer = null;
        }
        res.write(chunk);
      },
      close(reason) {
        finish(reason);
      },
    };

    function finish(reason) {
      if (closed) return;
      closed = true;
      if (firstByteTimer) clearTimeout(firstByteTimer);
      session.removeSubscriber(subscriber);
      log.debug(
        { session: session.id, bytes, dropped, reason },
        'audio subscriber closed',
      );
      try {
        if (!res.writableEnded) res.end();
      } catch {
        /* socket already gone */
      }
    }

    req.on('close', () => finish('client-gone'));
    res.on('error', () => finish('response-error'));

    if (!session.addAudioSubscriber(subscriber)) {
      // Session was already terminal; addAudioSubscriber closed the stream.
      return undefined;
    }

    log.info({ session: session.id, state: session.state }, 'audio subscriber attached');
    return undefined;
  });

  /** Cheap liveness probe for a session that already holds a viewer token. */
  router.get('/stream/:sessionId/status', requireViewer, (req, res) => {
    res.setHeader('Cache-Control', NO_STORE);
    res.json(req.streamSession.info());
  });

  return router;
}
