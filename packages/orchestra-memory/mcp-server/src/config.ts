// Centralized environment-variable reads for orchestra-memory.
//
// Per docs/design/remote-memory-plan.md section 3 ("Server package layout &
// config surface"), this module is the one obvious place to add config
// resolution as remote-memory support lands in later phases. For now, only
// `getDbPath()` is wired into real behavior (Task 5.1); the rest of the
// getters below are documented stubs so later tasks don't need to invent a
// new convention.
//
// All getters read `process.env` fresh on every call (never memoized at
// module load) — callers (and tests that mutate env vars between calls,
// e.g. via `beforeEach`/`afterEach`) rely on this dynamic re-evaluation.
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Resolves the SQLite graph DB path.
 *
 * Overridable via `ORCHESTRA_MEMORY_DB_PATH` (both client and container use
 * this var per the plan's env surface table). Falls back to today's default
 * (`~/.claude/orchestra-memory/graph.db`) when unset or empty.
 */
export function getDbPath(): string {
  const override = process.env.ORCHESTRA_MEMORY_DB_PATH;
  if (override) return override;
  return join(homedir(), '.claude', 'orchestra-memory', 'graph.db');
}

// --- Not yet wired — stubs for later remote-memory phases -----------------
//
// These getters exist so later tasks (Phases 1-4 of the remote-memory plan)
// have one obvious place to read the rest of the env surface, rather than
// each reaching into `process.env` directly. None of them are called by any
// code yet; wiring them into actual client/server behavior is out of scope
// for Task 5.1.
//
// `ORCHESTRA_MEMORY_INJECT_MODE` (client, default `full`) already exists and
// is read directly by the shell script that invokes `--inject` (see
// scripts/memory-inject.sh / src/inject.ts). It's listed here only for
// completeness with the plan's env surface table — do not add a getter for
// it without also updating its existing call site.

/** Remote backend URL (client). Unset => local SQLite (default). Not yet wired. */
export function getRemoteUrl(): string | undefined {
  return process.env.ORCHESTRA_MEMORY_URL || undefined;
}

/** Bearer token sent to the remote server (client). Not yet wired. */
export function getClientToken(): string | undefined {
  return process.env.ORCHESTRA_MEMORY_TOKEN || undefined;
}

/**
 * Per-request remote timeout in ms (client). Plan defaults: 1000 for MCP
 * tools, 500 for `--inject`. Callers choose which default applies; this
 * getter just centralizes the env read + numeric parsing. Not yet wired.
 */
export function getTimeoutMs(defaultMs: number): number {
  const raw = process.env.ORCHESTRA_MEMORY_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs;
}

/** Server bind address (server). Default `127.0.0.1:8787`. Not yet wired. */
export function getListenAddress(): string {
  return process.env.ORCHESTRA_MEMORY_LISTEN || '127.0.0.1:8787';
}

/** Expected bearer token(s) for the server (server). Not yet wired. */
export function getServerToken(): string | undefined {
  return process.env.ORCHESTRA_MEMORY_SERVER_TOKEN || undefined;
}

/** Origin allowlist for the server (server), comma-separated. Default: none/deny. Not yet wired. */
export function getAllowedOrigins(): string[] {
  const raw = process.env.ORCHESTRA_MEMORY_ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
