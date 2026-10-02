# syntax=docker/dockerfile:1.7
# =============================================================================
# CyberStream - production image
#
# Ships three things the app cannot work without:
#   * ffmpeg with the mpeg1video and libmp3lame encoders
#   * yt-dlp for resolving YouTube URLs
#   * the Node runtime and production dependencies
#
# The build is multi-stage so the runtime image carries no npm cache, no
# sources and no test tooling.
# =============================================================================

# ---------------------------------------------------------------- deps stage
FROM node:22-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json* ./

# `--ignore-scripts` because the postinstall hook (vendoring JSMpeg) needs
# scripts/ and public/, which are copied later - and because running lifecycle
# scripts of dependencies at install time is a supply-chain risk we do not need.
# This app has no native modules that require a build step.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --ignore-scripts --no-audit --no-fund; \
    else \
      npm install --omit=dev --ignore-scripts --no-audit --no-fund; \
    fi


# ------------------------------------------------------------- build stage
# Only produces the vendored player asset; nothing is copied from here except
# public/ and the pruned dependency tree.
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund --ignore-scripts

COPY scripts ./scripts
# Vendors public/vendor/jsmpeg.min.js (checksum-pinned, no CDN at runtime).
RUN node scripts/vendor.mjs

COPY src ./src
COPY public ./public
COPY .env.example ./.env.example

# Drop dev dependencies from the tree we are about to copy.
RUN npm prune --omit=dev --ignore-scripts


# ------------------------------------------------------------ runtime stage
FROM node:22-bookworm-slim AS runtime

# ffmpeg provides the encoders. tini reaps zombies and forwards signals, so the
# graceful shutdown in server.js actually runs on `docker stop`.
# python3 is required by yt-dlp, which has no static build.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      tini \
      ca-certificates \
      python3 \
      python3-pip \
 && rm -rf /var/lib/apt/lists/*

# pip rather than apt: Debian's yt-dlp is months behind and regularly fails to
# resolve current YouTube formats. `--break-system-packages` is required by
# Debian's PEP 668 marker.
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp \
 && yt-dlp --version

WORKDIR /app

ENV NODE_ENV=production \
    LOG_PRETTY=false \
    LOG_LEVEL=info \
    FFMPEG_PATH=ffmpeg \
    YT_DLP_PATH=/usr/local/bin/yt-dlp \
    NODE_OPTIONS=--max-old-space-size=768 \
    TMPDIR=/tmp

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/public         ./public
COPY --from=build /app/src            ./src
COPY --from=build /app/scripts        ./scripts
COPY --from=build /app/package.json   ./package.json
COPY --from=build /app/.env.example   ./.env.example

# FFmpeg needs somewhere to write; sessions create per-session temp dirs here.
RUN mkdir -p /tmp/cyberstream && chown -R node:node /tmp/cyberstream /app

# Never run the transcoder as root.
USER node

EXPOSE 8080
VOLUME ["/tmp/cyberstream"]

# -freetype/-fontconfig are loaded by the thumbnail path; libass is used by
# FFmpeg's drawtext filter if an operator enables subtitles.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
# `--env-file-if-exists` warns on stderr when there is no .env, which is noise in
# a container where configuration comes from the environment. Only use the file
# when the operator actually mounted one.
CMD ["sh", "-c", "if [ -f .env ]; then exec node --env-file=.env src/server.js; else exec node src/server.js; fi"]
