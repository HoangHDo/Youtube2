import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config/index.js';
import { logger } from './lib/logger.js';
import { securityHeaders, originGuard, globalLimiter } from './middleware/security.js';
import { errorHandler, notFound } from './middleware/error-handler.js';
import { createApiRouter } from './routes/api.routes.js';
import { createAudioRouter } from './routes/audio.routes.js';
import { VERSION } from './version.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // rate limits + protocol detection behind a proxy
  app.disable('x-powered-by');
  app.locals.audioBitrateHint = config.audio.bitrate;

  app.use(securityHeaders());
  app.use(originGuard());
  app.use(express.json({ limit: config.security.maxJsonBody, strict: true }));
  app.use(globalLimiter());

  // Request logging, minus the noise of the two streaming endpoints.
  app.use((req, res, next) => {
    const isStream = req.path.includes('/audio.mp3') || req.path.startsWith('/api/session');
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      if (isStream) return;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      logger.debug({ method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms) }, 'http');
    });
    next();
  });

  app.use('/api', createApiRouter({ version: VERSION }));
  app.use('/api', createAudioRouter());

  // Static frontend. `index.html` must never be cached, hashed assets can be.
  app.use(
    express.static(join(root, 'public'), {
      index: 'index.html',
      etag: true,
      maxAge: config.isProduction ? '1h' : 0,
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
        if (filePath.includes(`${join('public', 'vendor')}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );

  app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

  app.use(notFound);
  app.use(errorHandler(logger));

  return app;
}
