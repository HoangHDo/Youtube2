/**
 * Process bootstrap: HTTP server, WebSocket relay, Socket.IO control plane,
 * reaper, and an orderly shutdown that leaves no FFmpeg process behind.
 */
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config/index.js';
import { logger } from './lib/logger.js';
import { createApp } from './app.js';
import { attachVideoWebSocket } from './realtime/video.socket.js';
import { attachControlSocket } from './realtime/control.socket.js';
import { startReaper, shutdownAll, sessionStore } from './lib/session-store.js';
import { purgeResolveTemp } from './lib/resolver.js';
import { probeFfmpeg, probeYtDlp } from './lib/doctor.js';
import { reapOrphans, pruneForeignStateFiles, pruneStaleSessionDirs } from './lib/orphan-reaper.js';
import { VERSION } from './version.js';

const SHUTDOWN_GRACE_MS = 8000;

export async function start() {
  const app = createApp();
  const server = createServer(app);

  // Long-lived media sockets must not be cut by default timeouts.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0;

  const video = attachVideoWebSocket(server);
  const control = attachControlSocket(server);
  const stopReaper = startReaper();

  const ffmpeg = await probeFfmpeg();
  if (ffmpeg.ok) {
    logger.info(
      { version: ffmpeg.version, path: config.video.ffmpegPath },
      'ffmpeg ready',
    );
  } else {
    logger.warn({ err: ffmpeg.error }, 'ffmpeg is not usable - streams will fail');
  }

  const ytDlp = await probeYtDlp();
  if (ytDlp.ok) {
    logger.info({ version: ytDlp.version, path: config.youtube.ytDlpPath }, 'yt-dlp ready');
  } else {
    // Not fatal: direct media URLs still work without it.
    logger.warn({ err: ytDlp.error }, 'yt-dlp unavailable - YouTube sources will fail');
  }

  // Clean up after a previous run that was killed rather than shut down.
  const reaped = await reapOrphans();
  if (reaped > 0) logger.warn({ reaped }, 'reaped orphaned ffmpeg processes from a previous run');
  await pruneForeignStateFiles();
  // In dual-file mode FFmpeg writes its outputs into per-session directories, so
  // a killed run leaves real megabytes behind that no session will ever claim.
  const swept = await pruneStaleSessionDirs();
  if (swept > 0) logger.warn({ swept }, 'removed session temp directories from a previous run');

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  logger.info(
    {
      version: VERSION,
      url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
      node: process.version,
      env: config.env,
      ffmpeg: config.video.ffmpegPath,
      ytDlp: config.youtube.ytDlpPath,
    },
    'cyberstream listening',
  );

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, sessions: sessionStore.size }, 'shutting down');

    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();

    try {
      await shutdownAll(`signal:${signal}`);
      stopReaper();
      control.close();
      video.close();
      await purgeResolveTemp();
      await new Promise((resolve) => server.close(resolve));
      clearTimeout(force);
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err: err.message }, 'shutdown failed');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.on(signal, () => void shutdown(signal));
  }

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: reason?.message ?? String(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'uncaught exception');
    void shutdown('uncaughtException');
  });

  return { app, server, shutdown };
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint() || process.env.CYBERSTREAM_FORCE_START === '1') {
  start().catch((err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'failed to start');
    process.exit(1);
  });
}
