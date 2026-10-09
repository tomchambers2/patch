# patch-server image — NOT USED IN PRODUCTION.
#
# The server now runs as a native systemd user service (patch-server.service)
# on the Hetzner host. The canonical deploy path is:
#   cd /srv/patch && pnpm run deploy
# which builds packages/server via tsc and restarts the systemd service.
#
# This Dockerfile is retained for reference and local experimentation only.

# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22

# ───────── Stage 1: builder ─────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder
RUN apk add --no-cache git
WORKDIR /repo

# Pin pnpm via corepack — no surprise version drift.
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

# Copy lockfile + workspace manifests first for layer caching.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json tsconfig.json ./
COPY packages/wire/package.json packages/wire/
COPY packages/auth/package.json packages/auth/
COPY packages/server/package.json packages/server/
COPY packages/daemon/package.json packages/daemon/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
COPY packages/desktop/package.json packages/desktop/
COPY apps/mobile/package.json apps/mobile/

RUN pnpm install --frozen-lockfile

# Copy the rest of the source.
COPY . .

# Build identity. Declared BEFORE the build because the web build stamps these
# into the SPA bundle + its version.json (spec/11 § Version reporting). Exported
# as ENV so scripts/version.mjs reads them straight from the environment rather
# than deriving from `git` — the image must not depend on .git being in the
# build context to know what it is.
ARG PATCH_GIT_SHA
ARG PATCH_VERSION
ARG PATCH_BUILT_AT
ARG PATCH_SERVER_SHA
RUN test -n "$PATCH_GIT_SHA" || (echo "PATCH_GIT_SHA build-arg required" && exit 1)
RUN test -n "$PATCH_VERSION" || (echo "PATCH_VERSION build-arg required" && exit 1)
ENV PATCH_GIT_SHA=${PATCH_GIT_SHA}
ENV PATCH_VERSION=${PATCH_VERSION}
ENV PATCH_BUILT_AT=${PATCH_BUILT_AT}
ENV PATCH_SERVER_SHA=${PATCH_SERVER_SHA}

# Build wire, server, and the web SPA. Daemon/cli/desktop/mobile aren't
# needed in this image.
RUN pnpm --filter @patch/wire --filter @patch/auth --filter @patch/server --filter @patch/web build

# Trim node_modules to production-only for the runtime stage.
RUN pnpm --filter @patch/server deploy --prod --legacy /out/server

# Stash the web dist where the runtime image picks it up.
RUN mkdir -p /out/web && cp -r packages/web/dist /out/web/dist

# ───────── Stage 2: runtime ─────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime
RUN apk add --no-cache tini
WORKDIR /app

ENV NODE_ENV=production
ARG PATCH_GIT_SHA
ARG PATCH_VERSION
ARG PATCH_BUILT_AT
ARG PATCH_SERVER_SHA
ENV PATCH_GIT_SHA=${PATCH_GIT_SHA}
ENV PATCH_VERSION=${PATCH_VERSION}
ENV PATCH_BUILT_AT=${PATCH_BUILT_AT}
ENV PATCH_SERVER_SHA=${PATCH_SERVER_SHA}
ENV PATCH_WEB_DIST=/app/web/dist

COPY --from=builder /out/server /app
COPY --from=builder /out/web/dist /app/web/dist

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/api/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
