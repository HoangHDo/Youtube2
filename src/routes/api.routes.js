import { Router } from 'express';
import { z } from 'zod';
import { config, publicBaseUrl } from '../config/index.js';
import { catalogPayload } from '../lib/catalog.js';
import { sessionStore, SESSION_STATE } from '../lib/session-store.js';
import { createLimiter } from '../middleware/security.js';
import { requireOwner, requireViewer } from '../middleware/auth.js';
import { childLogger } from '../lib/logger.js';
import { thumbnailFor, parseSource } from '../lib/youtube.js';
import { parseOptions } from '../lib/parse-options.js';
import { newViewerToken } from '../lib/ids.js';
import { QUALITY_PRESETS, videoConfigFor } from '../lib/ffmpeg.js';
import {
  snapshot as snapshotCapabilities,
  degradationReason,
  canResolveYouTube,
} from '../lib/capabilities.js';

const log = childLogger({ mod: 'api' });

const createBody = z.object({
  url: z.string().min(3).max(2048),
  // Optional client hints, all clamped server-side.
  autoplay: z.boolean().optional(),
  // `medium` is accepted as an alias for `standard`. The preset was renamed when
  // the default moved to 720p, but a client that had already stored `medium` in
  // localStorage would otherwise be rejected outright and be unable to start a
  // stream at all - the one failure a user cannot work around from the UI.
  quality: z.enum(['low', 'standard', 'high', 'medium']).optional(),
});

export function createApiRouter({ version }) {
  const router = Router();
  const createLimit = createLimiter();

  /** Non-secret runtime configuration for the client. */
  router.get('/config', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      version,
      // What this deployment can actually do. The client uses this to warn
      // *before* the user pastes a URL, rather than surfacing a resolve failure
      // that looks like a problem with their link.
      capabilities: {
        canResolveYouTube: canResolveYouTube(),
        degraded: snapshotCapabilities().degraded,
        reason: degradationReason(),
      },
      limits: {
        maxSessionMs: config.sessions.maxDurationMs,
        maxSourceDuration: config.youtube.maxSourceDuration,
        allowDirectMediaUrls: config.youtube.allowDirectMediaUrls,
        maxSessions: config.sessions.max,
      },
      media: {
        width: config.video.width,
        height: config.video.height,
        fps: config.video.fps,
        audio: { bitrate: config.audio.bitrate, sampleRate: config.audio.sampleRate },
        muxDelayMs: Math.round(config.video.muxDelay * 1000),
        tsClock: config.video.tsClock,
        // The selectable presets, already clamped to the operator's configured
        // resolution so the client can render the menu without guessing and
        // without ever being able to ask for more than the server allows.
        qualities: Object.fromEntries(
          Object.entries(QUALITY_PRESETS).map(([name]) => {
            const v = videoConfigFor(name);
            return [name, { width: v.width, height: v.height, fps: v.fps }];
          }),
        ),
      },
      paths: { ws: '/ws/video', audio: '/api/stream/:sessionId/audio.mp3' },
      // Only present when the operator opted in; the page uses it as an extra
      // server-wide key. `streamTokenSet` is enough for the UI to adapt.
      streamTokenSet: Boolean(config.security.streamToken),
      streamToken:
        config.security.streamToken && config.security.allowClientTokenBootstrap
          ? config.security.streamToken
          : null,
    });
  });

  router.get('/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // `ok` is liveness, deliberately independent of capability: the process is
    // up and serving. Folding a missing dependency in here would make a
    // platform health check restart the same broken build in a loop, which
    // cannot fix anything. Readiness below is the signal worth alerting on.
    const caps = snapshotCapabilities();
    res.json({
      ok: true,
      version,
      uptimeSec: Math.round(process.uptime()),
      sessions: sessionStore.size,
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      degraded: caps.degraded,
      canResolveYouTube: caps.canResolveYouTube,
    });
  });

  /** Ready probe: FFmpeg usable *and* YouTube URLs resolvable. */
  router.get('/health/ready', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const caps = snapshotCapabilities();
    // The status has to be set before the body is written: `res.json()` sends
    // the headers immediately, so a following `res.status()` is a no-op and the
    // probe would answer 200 while reporting ok:false - which is worse than not
    // reporting at all, because an orchestrator would route traffic to a service
    // that says it cannot serve it.
    res.status(caps.ready ? 200 : 503).json({
      ok: caps.ready,
      ready: caps.ready,
      degraded: caps.degraded,
      reason: degradationReason(),
      ffmpeg: { ...caps.ffmpeg, path: config.video.ffmpegPath },
      ytDlp: { ...caps.ytDlp, path: config.youtube.ytDlpPath },
      sessions: sessionStore.size,
    });
  });

  router.get('/catalog', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(catalogPayload());
  });

  /** Validates a URL without starting FFmpeg (used for live UI feedback). */
  router.post('/resolve/validate', (req, res) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'bad_request', message: 'A url is required.' });
    }
    try {
      const source = parseSource(parsed.data.url, parseOptions());
      res.json({
        ok: true,
        kind: source.kind,
        videoId: source.videoId,
        url: source.url,
        thumbnail: thumbnailFor(source),
      });
    } catch (err) {
      res.status(err.statusCode ?? 400).json({
        error: err.code ?? 'invalid_source',
        message: err.message,
      });
    }
  });

  /** Create a session: resolves the source and boots FFmpeg. */
  router.post('/sessions', createLimit, async (req, res) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'bad_request',
        message: 'Provide a YouTube URL or video id, and a quality of low, standard or high.',
      });
    }

    const session = sessionStore.create({
      input: parsed.data.url,
      requestIp: req.ip,
      quality: parsed.data.quality ?? null,
      ownerSocketId: typeof req.query?.socketId === 'string' ? req.query.socketId : null,
    });

    // Mint a stable viewer token for anonymous views (the creator also gets the
    // owner token in the response).
    session.viewerToken = newViewerToken();

    req.log?.info?.({ session: session.id }, 'session created');

    try {
      await session.start();
    } catch (err) {
      await session.destroy();
      return res.status(err.statusCode ?? 500).json({
        error: err.code ?? 'start_failed',
        message: err.message,
      });
    }

    const base = publicBaseUrl(req);
    const q = new URLSearchParams({ token: session.viewerToken });
    if (config.security.streamToken) q.set('st', config.security.streamToken);

    log.info({ session: session.id, ip: req.ip }, 'stream live');

    res.status(201).json({
      ...session.metaPayload(),
      tokens: {
        viewerToken: session.viewerToken,
        ownerToken: session.ownerToken,
      },
      endpoints: {
        video: `${base.replace(/^http/, 'ws')}/ws/video?${q}&sessionId=${session.id}`,
        audio: `${base}/api/stream/${session.id}/audio.mp3?${q}`,
        stop: `${base}/api/stream/${session.id}?token=${session.ownerToken}${
          config.security.streamToken ? `&st=${config.security.streamToken}` : ''
        }`,
      },
    });
  });

  router.get('/sessions/:sessionId', requireViewer, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(req.streamSession.info());
  });

  /** Stop the stream and kill FFmpeg. */
  router.delete('/stream/:sessionId', requireOwner, (req, res) => {
    const { streamSession: session } = req;
    session.stop('client-request');
    res.json({ ok: true, sessionId: session.id, state: SESSION_STATE.STOPPING });
  });

  router.get('/sessions', (req, res) => {
    // Operational view; counts only, no capability required.
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      count: sessionStore.size,
      sessions: sessionStore.all().map((s) => ({
        id: s.id,
        state: s.state,
        viewers: s.viewerCount,
        uptimeMs: s.startedAt ? Date.now() - s.startedAt : 0,
        strategy: s.transcoder?.strategy ?? null,
      })),
    });
  });

  return router;
}
