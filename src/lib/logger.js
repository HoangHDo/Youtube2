import pino from 'pino';
import { config } from '../config/index.js';

const redact = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["sec-websocket-protocol"]',
    '*.token',
    '*.viewerToken',
    'config.security.streamToken',
    'youtube.extraArgs',
  ],
  censor: '[redacted]',
};

export const logger = pino({
  level: config.log.level,
  base: { service: 'cyberstream' },
  redact,
  timestamp: pino.stdTimeFunctions.isoTime,
  // Human-friendly output in development. In production we deliberately log
  // newline-delimited JSON to stdout for the container runtime to collect.
  ...(config.log.pretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname,service',
            messageFormat: '{if module}[{module}] {end}{msg}',
          },
        },
      }
    : {}),
});

export function childLogger(bindings) {
  return logger.child(bindings);
}
