#!/usr/bin/env node
// Orchestra graph memory MCP server entry point.
//
// Two modes:
//   1. `node dist/server.mjs`                                  → MCP stdio server (default)
//   2. `node dist/server.mjs --inject --project-id <key> ...`  → CLI inject mode (see inject.ts)
//   3. `node dist/server.mjs --migrate [--commit] ...`         → CLI migration mode (see migrate.ts)
//   4. `node dist/server.mjs --backup [--keep <n>] ...`        → CLI backup mode (see backup.ts)
//
// Tool handlers live as plain functions in src/tools/*.ts (handleSave,
// handleSearch, ...) so they can be unit-tested directly against a temp DB
// without going through MCP/stdio at all — see test/tools.test.ts. This file
// only wires those handlers into the MCP SDK's McpServer.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { tryOpenDb, SCHEMA_VERSION } from './db/connection.js';
import { createRepository, type Repository } from './db/repository.js';
import { runBackup } from './backup.js';
import { runInject } from './inject.js';
import { computeProjectId, runMigrate } from './migrate.js';
import { startServeHttp, SERVER_VERSION } from './serve.js';
import { getRemoteUrl, getClientToken, getTimeoutMs } from './config.js';
import { createRemoteRepository, probeHealth, RemoteUnavailableError } from './remote/client.js';

import * as saveTool from './tools/save.js';
import * as searchTool from './tools/search.js';
import * as linkTool from './tools/link.js';
import * as traverseTool from './tools/traverse.js';
import * as inspectTool from './tools/inspect.js';
import * as invalidateTool from './tools/invalidate.js';
import * as statsTool from './tools/stats.js';
import * as wisdomTool from './tools/wisdom-compat.js';
import type { ToolContext } from './tools/context.js';

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export interface BackendSelection {
  repo: Repository | null;
  diagnostic: string | null;
}

/**
 * Chooses between the remote HTTP backend and local SQLite, per
 * docs/design/remote-memory-plan.md section 3/Phase 1: `ORCHESTRA_MEMORY_URL`
 * set => remote mode (probing /health at startup with a short bounded
 * timeout before committing to it); unset => today's local-only behavior,
 * unchanged.
 *
 * Fail-open contract: on ANY remote-mode failure (network error, timeout,
 * non-200, malformed response, or a schemaVersion mismatch against this
 * build's own SCHEMA_VERSION) this falls back to `{ repo: null, diagnostic }`
 * — never throws, never hangs. Exported (rather than inlined in main()) so a
 * later integration-test task can exercise this branch directly.
 */
export async function selectRepo(): Promise<BackendSelection> {
  const remoteUrl = getRemoteUrl();
  if (remoteUrl) {
    const timeoutMs = getTimeoutMs(1000);
    try {
      const health = await probeHealth(remoteUrl, timeoutMs);
      if (health.schemaVersion !== SCHEMA_VERSION) {
        return {
          repo: null,
          diagnostic: `orchestra-memory: remote server schema mismatch (server=${health.schemaVersion}, this build expects=${SCHEMA_VERSION}) — refusing to use it`,
        };
      }
      if (!health.ok) {
        return {
          repo: null,
          diagnostic: `orchestra-memory: remote server reported unhealthy at ${remoteUrl}`,
        };
      }
      return {
        repo: createRemoteRepository({ url: remoteUrl, token: getClientToken(), timeoutMs }),
        diagnostic: null,
      };
    } catch (err) {
      const message = err instanceof RemoteUnavailableError ? err.message : String(err);
      return {
        repo: null,
        diagnostic: `orchestra-memory: remote server unreachable at startup (${remoteUrl}): ${message}`,
      };
    }
  }

  const opened = tryOpenDb();
  return { repo: opened.db ? createRepository(opened.db) : null, diagnostic: opened.diagnostic };
}

/**
 * Routes every tool handler call through a single fail-open seam. A null
 * `repoArg` means the backend was never available (startup probe failed or
 * local DB open failed) — degrade immediately. A `RemoteUnavailableError`
 * thrown mid-call (server restart, network blip after a successful startup
 * probe) degrades that ONE call the same way rather than crashing the tool
 * invocation or surfacing as an unhandled rejection. Any other thrown error
 * is a real local bug and is left to propagate as before.
 */
async function callHandler(
  repoArg: Repository | null,
  diagnosticArg: string | null,
  fn: (repo: Repository) => Promise<{ text: string }>
): Promise<CallToolResult> {
  if (!repoArg) {
    return textResult(
      `orchestra-memory tools are disabled for this session: ${diagnosticArg ?? 'database unavailable'}`
    );
  }
  try {
    const result = await fn(repoArg);
    return textResult(result.text);
  } catch (err) {
    if (err instanceof RemoteUnavailableError) {
      return textResult(
        `orchestra-memory tools are disabled for this session: remote backend unavailable (${err.message})`
      );
    }
    throw err;
  }
}

/**
 * Finding 1 (trust boundary): the server binds to its OWN project identity
 * at startup — the same sha256-16-of-cwd derivation used everywhere else in
 * the plugin (see migrate.ts's computeProjectId(), reused here rather than
 * duplicated). Every tool handler is threaded this identity via ToolContext
 * and refuses to act on a caller-supplied project_id that doesn't match it
 * (see src/tools/context.ts). process.cwd() failing is not expected in
 * practice, but if it ever does, ownProjectId is null and every handler
 * fails closed for private scope rather than crashing the server.
 */
function computeOwnProjectId(): string | null {
  try {
    return computeProjectId(process.cwd());
  } catch {
    return null;
  }
}

const USAGE = `orchestra-memory MCP server / CLI

Usage:
  node dist/server.mjs
      Start the MCP stdio server (default mode — no flags).

  node dist/server.mjs --inject --project-id <id> [--budget <bytes>] [--inject-mode index|full]
      Print a token-dense memory block for SessionStart context injection
      and exit. --budget defaults to 9500 bytes (2000 in index mode).
      --inject-mode index prints a compact entity index instead of the
      full fact dump (experimental, default: full).

  node dist/server.mjs --migrate [--commit] --project-root <path>
      Migrate legacy wisdom JSON (.claude/orchestra-wisdom.json) into the
      graph DB. Without --commit this is a dry run (nothing written).

  node dist/server.mjs --backup [--keep <n>]
      Rotate a daily snapshot of the graph.db backup. --keep defaults to 7.

  node dist/server.mjs --serve-http
      Start an HTTP server exposing the graph memory Repository over
      POST /rpc and GET /health, bound per ORCHESTRA_MEMORY_LISTEN (default
      127.0.0.1:8787). Requires ORCHESTRA_MEMORY_DB_PATH and
      ORCHESTRA_MEMORY_SERVER_TOKEN per the env matrix in
      docs/design/remote-memory-plan.md section 3; see that doc for the
      full remote-backend design.

  node dist/server.mjs --help | -h
      Show this usage summary and exit.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  if (argv.includes('--inject')) {
    await runInject(argv);
    return;
  }
  if (argv.includes('--migrate')) {
    await runMigrate(argv);
    return;
  }
  if (argv.includes('--backup')) {
    runBackup(argv);
    return;
  }
  if (argv.includes('--serve-http')) {
    startServeHttp();
    return;
  }

  const ctx: ToolContext = { ownProjectId: computeOwnProjectId() };

  const { repo, diagnostic } = await selectRepo();

  const server = new McpServer({ name: 'orchestra-memory', version: SERVER_VERSION });

  server.registerTool(
    saveTool.name,
    { title: 'Save memory facts', description: saveTool.description, inputSchema: saveTool.inputShape },
    async (args) => callHandler(repo, diagnostic, (r) => saveTool.handleSave(r, args, ctx))
  );

  server.registerTool(
    searchTool.name,
    { title: 'Search memory', description: searchTool.description, inputSchema: searchTool.inputShape },
    async (args) => callHandler(repo, diagnostic, (r) => searchTool.handleSearch(r, args, ctx))
  );

  server.registerTool(
    linkTool.name,
    { title: 'Link entities', description: linkTool.description, inputSchema: linkTool.inputShape },
    async (args) => callHandler(repo, diagnostic, (r) => linkTool.handleLink(r, args, ctx))
  );

  server.registerTool(
    traverseTool.name,
    { title: 'Traverse graph', description: traverseTool.description, inputSchema: traverseTool.inputShape },
    async (args) => callHandler(repo, diagnostic, (r) => traverseTool.handleTraverse(r, args, ctx))
  );

  server.registerTool(
    inspectTool.name,
    {
      title: 'Inspect memory (debug)',
      description: inspectTool.description,
      inputSchema: inspectTool.inputShape,
    },
    async (args) => callHandler(repo, diagnostic, (r) => inspectTool.handleInspect(r, args, ctx))
  );

  server.registerTool(
    invalidateTool.name,
    {
      title: 'Invalidate/forget facts',
      description: invalidateTool.description,
      inputSchema: invalidateTool.inputShape,
    },
    async (args) => callHandler(repo, diagnostic, (r) => invalidateTool.handleInvalidate(r, args, ctx))
  );

  server.registerTool(
    statsTool.name,
    { title: 'Memory stats', description: statsTool.description, inputSchema: statsTool.inputShape },
    async (args) => callHandler(repo, diagnostic, (r) => statsTool.handleStats(r, args, ctx))
  );

  server.registerTool(
    wisdomTool.getName,
    { title: 'Get wisdom', description: wisdomTool.getDescription, inputSchema: wisdomTool.getInputShape },
    async (args) => callHandler(repo, diagnostic, (r) => wisdomTool.handleWisdomGet(r, args, ctx))
  );

  server.registerTool(
    wisdomTool.addName,
    { title: 'Add wisdom', description: wisdomTool.addDescription, inputSchema: wisdomTool.addInputShape },
    async (args) => callHandler(repo, diagnostic, (r) => wisdomTool.handleWisdomAdd(r, args, ctx))
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('orchestra-memory: fatal error', err);
  process.exit(1);
});
