# syntax=docker/dockerfile:1
#
# --------------------------------------------------------------------------
# Build context: packages/orchestra-memory/ (the directory containing THIS
# Dockerfile) -- NOT packages/orchestra-memory/mcp-server/.
#
# This is a deliberate choice: this Dockerfile's sibling
# packages/orchestra-memory/.dockerignore only has effect if it lives at the
# root of the build context, and Task 3.1's file ownership places
# .dockerignore at packages/orchestra-memory/ (not mcp-server/) -- so the
# build context must be packages/orchestra-memory/ for that ignore file to
# actually apply. COPY paths below are therefore written relative to
# packages/orchestra-memory/ (e.g. `mcp-server/dist/server.mjs`), not
# relative to mcp-server/.
#
# Prerequisite (run once; produces the artifacts this image copies in --
# this Dockerfile does NOT run `npm install`/`npm run build` itself, per the
# design plan's "same build artifact as the local client" story):
#
#   cd packages/orchestra-memory/mcp-server && npm run build
#
# Build (from the repo root):
#
#   docker build -t orchestra-memory:latest -f packages/orchestra-memory/Dockerfile packages/orchestra-memory
#
# (equivalently: `cd packages/orchestra-memory && docker build -t orchestra-memory:latest .`)
#
# The docker-compose.yml task (3.2) should declare:
#   build:
#     context: .            # i.e. packages/orchestra-memory/
#     dockerfile: Dockerfile
# --------------------------------------------------------------------------
FROM node:22-slim

# Dedicated non-root user/group. --system => no password, no home-dir
# clutter. node:sqlite requires Node >=22.5 + glibc, which is why this image
# is based on node:22-slim (Debian) rather than an alpine (musl) variant.
RUN groupadd --system orchestra \
  && useradd --system --gid orchestra --no-create-home --home-dir /nonexistent orchestra

WORKDIR /app

# Only the prebuilt runtime bundle is copied in -- no source, no
# node_modules, no `npm install`/`npm run build` inside the image. The
# bundle (dist/server.mjs) already inlines every runtime dependency
# (@modelcontextprotocol/sdk, zod) via esbuild; node:sqlite is a Node
# built-in resolved at runtime, not bundled (esbuild.config.mjs's
# `external: ['node:*']`). dist/server.mjs.map is copied too, for readable
# stack traces in server logs.
COPY mcp-server/dist/server.mjs ./dist/server.mjs
COPY mcp-server/dist/server.mjs.map ./dist/server.mjs.map
COPY mcp-server/dist/schema.sql ./dist/schema.sql

# /data holds the SQLite DB file (ORCHESTRA_MEMORY_DB_PATH), its WAL/SHM
# sidecar files, and the backups/ subdir (see mcp-server/src/backup.ts:
# backups/ = dirname(dbPath)/backups, i.e. /data/backups here). Owned by the
# non-root user so the server can create/rotate all of the above.
RUN mkdir -p /data \
  && chown -R orchestra:orchestra /data /app

VOLUME ["/data"]

# Container defaults. ORCHESTRA_MEMORY_SERVER_TOKEN is deliberately NOT set
# here -- it must be supplied at runtime (env/compose/secret), never baked
# into the image. serve.ts fails closed at startup if it's unset while the
# listen host isn't loopback; that is intentional fail-closed behavior and
# must not be worked around from this Dockerfile.
ENV ORCHESTRA_MEMORY_DB_PATH=/data/graph.db
ENV ORCHESTRA_MEMORY_LISTEN=0.0.0.0:8787

EXPOSE 8787

USER orchestra

CMD ["node", "dist/server.mjs", "--serve-http"]
