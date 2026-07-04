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
import { tryOpenDb } from './db/connection.js';
import { createRepository } from './db/repository.js';
import { runBackup } from './backup.js';
import { runInject } from './inject.js';
import { computeProjectId, runMigrate } from './migrate.js';

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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--inject')) {
    runInject(argv);
    return;
  }
  if (argv.includes('--migrate')) {
    runMigrate(argv);
    return;
  }
  if (argv.includes('--backup')) {
    runBackup(argv);
    return;
  }

  const ctx: ToolContext = { ownProjectId: computeOwnProjectId() };

  const { db, diagnostic } = tryOpenDb();
  const repo = db ? createRepository(db) : null;

  function disabledResult(): CallToolResult {
    return textResult(
      `orchestra-memory tools are disabled for this session: ${diagnostic ?? 'database unavailable'}`
    );
  }

  const server = new McpServer({ name: 'orchestra-memory', version: '0.1.0' });

  server.registerTool(
    saveTool.name,
    { title: 'Save memory facts', description: saveTool.description, inputSchema: saveTool.inputShape },
    async (args) => {
      if (!repo || !db) return disabledResult();
      return textResult(saveTool.handleSave(repo, db, args, ctx).text);
    }
  );

  server.registerTool(
    searchTool.name,
    { title: 'Search memory', description: searchTool.description, inputSchema: searchTool.inputShape },
    async (args) => {
      if (!repo || !db) return disabledResult();
      return textResult(searchTool.handleSearch(repo, db, args, ctx).text);
    }
  );

  server.registerTool(
    linkTool.name,
    { title: 'Link entities', description: linkTool.description, inputSchema: linkTool.inputShape },
    async (args) => {
      if (!repo) return disabledResult();
      return textResult(linkTool.handleLink(repo, args, ctx).text);
    }
  );

  server.registerTool(
    traverseTool.name,
    { title: 'Traverse graph', description: traverseTool.description, inputSchema: traverseTool.inputShape },
    async (args) => {
      if (!repo || !db) return disabledResult();
      return textResult(traverseTool.handleTraverse(repo, db, args, ctx).text);
    }
  );

  server.registerTool(
    inspectTool.name,
    {
      title: 'Inspect memory (debug)',
      description: inspectTool.description,
      inputSchema: inspectTool.inputShape,
    },
    async (args) => {
      if (!db) return disabledResult();
      return textResult(inspectTool.handleInspect(db, args, ctx).text);
    }
  );

  server.registerTool(
    invalidateTool.name,
    {
      title: 'Invalidate/forget facts',
      description: invalidateTool.description,
      inputSchema: invalidateTool.inputShape,
    },
    async (args) => {
      if (!repo || !db) return disabledResult();
      return textResult(invalidateTool.handleInvalidate(repo, db, args, ctx).text);
    }
  );

  server.registerTool(
    statsTool.name,
    { title: 'Memory stats', description: statsTool.description, inputSchema: statsTool.inputShape },
    async (args) => {
      if (!repo) return disabledResult();
      return textResult(statsTool.handleStats(repo, args, ctx).text);
    }
  );

  server.registerTool(
    wisdomTool.getName,
    { title: 'Get wisdom', description: wisdomTool.getDescription, inputSchema: wisdomTool.getInputShape },
    async (args) => {
      if (!db) return disabledResult();
      return textResult(wisdomTool.handleWisdomGet(db, args, ctx).text);
    }
  );

  server.registerTool(
    wisdomTool.addName,
    { title: 'Add wisdom', description: wisdomTool.addDescription, inputSchema: wisdomTool.addInputShape },
    async (args) => {
      if (!repo || !db) return disabledResult();
      return textResult(wisdomTool.handleWisdomAdd(repo, db, args, ctx).text);
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('orchestra-memory: fatal error', err);
  process.exit(1);
});
