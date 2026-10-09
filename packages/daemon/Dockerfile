# patch-daemon image — multi-stage. Ships the Node daemon PLUS the real
# Kokoro (TTS) + faster-whisper (STT) Python sidecars, which the daemon spawns
# via `uv run python -m patch_{kokoro,whisper}_sidecar`. Exposes the daemon's
# UDS + TCP /healthz on :3001 and the audio WSS on :3003.

# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22

# ───────── Stage 1: builder ─────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder
RUN apk add --no-cache git python3 make g++
WORKDIR /repo

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

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

COPY . .

# @patch/daemon references @patch/auth (and @patch/wire) via tsc project refs,
# so both library workspaces must be installed and built first.
RUN pnpm --filter @patch/wire --filter @patch/auth --filter @patch/daemon build

ARG PATCH_GIT_SHA
ARG PATCH_VERSION
ARG PATCH_BUILT_AT
ARG PATCH_SERVER_SHA
RUN test -n "$PATCH_GIT_SHA" || (echo "PATCH_GIT_SHA build-arg required" && exit 1)
RUN test -n "$PATCH_VERSION" || (echo "PATCH_VERSION build-arg required" && exit 1)

RUN pnpm --filter @patch/daemon deploy --prod --legacy /out/daemon

# ───────── Stage 2: runtime ─────────────────────────────────────────────
# Debian-slim (not alpine) so the Python sidecars' native wheels (torch,
# ctranslate2, onnxruntime) resolve manylinux binaries without a source build.
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update \
  # git + openssh-client are for the TERMINAL sessions (spec/02 § Terminal
  # sessions): the whole point of a shell on the daemon is cloning a repo onto
  # it before opening a chat there, and neither is in the base image.
  && apt-get install -y --no-install-recommends tini ca-certificates python3 python3-venv curl wget musl git openssh-client \
  && rm -rf /var/lib/apt/lists/*
# The Claude Agent SDK ships its Claude Code native binary ONLY as the
# linux-x64-MUSL variant (no -gnu package exists on npm), but this runtime is
# Debian (glibc). That musl-linked ELF needs the musl dynamic loader; without
# it, exec fails with ENOENT and the SDK reports "Claude Code native binary not
# found" on every turn. The `musl` package above provides the loader, but at
# /lib/x86_64-linux-musl/libc.so — symlink it to the path the binary's PT_INTERP
# expects (/lib/ld-musl-x86_64.so.1) so the binary actually runs.
RUN ln -sf /usr/lib/x86_64-linux-musl/libc.so /lib/ld-musl-x86_64.so.1 \
  || ln -sf /lib/x86_64-linux-musl/libc.so /lib/ld-musl-x86_64.so.1
# uv: fast Python package/venv manager the daemon invokes as `uv run`.
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
  && ln -s /root/.local/bin/uv /usr/local/bin/uv
WORKDIR /app

ENV NODE_ENV=production
ARG PATCH_GIT_SHA
ARG PATCH_VERSION
ARG PATCH_BUILT_AT
ARG PATCH_SERVER_SHA
ENV PATCH_GIT_SHA=${PATCH_GIT_SHA}
ENV PATCH_VERSION=${PATCH_VERSION}
# Reported on the daemon's WS hello so the panel can date the running daemon.
ENV PATCH_BUILT_AT=${PATCH_BUILT_AT}
ENV PATCH_SERVER_SHA=${PATCH_SERVER_SHA}
ENV PATCH_DAEMON_HEALTHZ_HOST=0.0.0.0
ENV PATCH_DAEMON_HEALTHZ_PORT=3001
ENV PATCH_DAEMON_SOCKET=/root/.patch/daemon.sock

COPY --from=builder /out/daemon /app

# Python voice sidecars. The daemon resolves them relative to its dist via
# ../../{kokoro,whisper}-sidecar, so mirror that layout under /app and warm the
# uv venvs at build time (model weights are mounted at runtime via *_MODEL_PATH).
COPY packages/kokoro-sidecar /app/../kokoro-sidecar
COPY packages/whisper-sidecar /app/../whisper-sidecar
# CPU-only torch. The default Linux torch wheel drags in multi-GB CUDA/GPU libs
# (nvidia-cudnn/nccl/cufft) — useless on a CPU box and enough to fill the disk.
# UV_TORCH_BACKEND=cpu makes uv resolve the ~200 MB CPU wheel instead.
ENV UV_TORCH_BACKEND=cpu
RUN cd /app/../kokoro-sidecar && uv venv --python 3.12 && uv pip install -e . \
  && cd /app/../whisper-sidecar && uv venv --python 3.12 && uv pip install -e .
# Bake the spaCy English model Kokoro's misaki G2P needs. The daemon spawns the
# sidecar with `uv run --no-sync`, so anything not installed here would be missing
# at runtime (en_core_web_sm is otherwise fetched on first synthesis).
RUN cd /app/../kokoro-sidecar && uv pip install \
  https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl
ENV KOKORO_SIDECAR_CWD=/app/../kokoro-sidecar
ENV WHISPER_SIDECAR_CWD=/app/../whisper-sidecar

# UDS sits under /root/.patch in the running container; ensure the dir exists.
RUN mkdir -p /root/.patch

# 3001 = TCP /healthz (compose healthcheck), 3003 = audio WSS. The daemon no
# longer runs an inbound control server on 3002 — it dials the server's /ws.
EXPOSE 3001 3003
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3001/healthz || exit 1

# Debian's tini package installs to /usr/bin/tini (not /sbin/tini as on alpine).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
