/**
 * Single place that knows how the resolver wants sources parsed, so the API
 * route, the session store and the CLI scripts cannot drift apart.
 */
import { config } from '../config/index.js';

export function parseOptions(overrides = {}) {
  return {
    allowDirectPorts: overrides.allowDirectPorts ?? config.youtube.allowDirectMediaUrls,
    allowedPorts: overrides.allowedPorts ?? config.youtube.directMediaPorts,
    allowPrivateHosts: overrides.allowPrivateHosts ?? config.youtube.allowPrivateMediaHosts,
  };
}
