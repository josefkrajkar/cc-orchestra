// CLI inject mode, consumed by Phase 3's SessionStart bash hook:
//   node dist/server.mjs --inject --project-id <key> [--budget <bytes>]
//
// No MCP handshake — this opens the DB directly and prints plain text to
// stdout, then exits. Contract (see docs/design/graph-memory-design.md Phase 3):
//   1. project-scope valid facts for project_id (confidence desc, recency desc)
//   2. top-K global facts
//   3. private facts of THIS project only
// Byte-budget enforced by truncating whole facts (never mid-line); when
// truncated, appends "[+N more facts — use memory_search]".
//
// Fail-open is the hard requirement here: on ANY error (missing project id,
// node:sqlite unavailable, corrupt DB, unexpected row shape) this must exit
// 0 with empty stdout and put diagnostics on stderr only — a broken memory
// layer must never break the SessionStart hook it's injected from.
import { tryOpenDb, type SqliteDatabase } from './db/connection.js';
import { renderObservationLine, type RenderableObservation } from './render.js';

const DEFAULT_BUDGET_BYTES = 9500;

interface InjectArgs {
  projectId: string | null;
  budget: number;
}

function parseArgs(argv: string[]): InjectArgs {
  let projectId: string | null = null;
  let budget = DEFAULT_BUDGET_BYTES;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project-id') {
      projectId = argv[++i]?.trim() || null;
    } else if (arg === '--budget') {
      const parsed = Number(argv[++i]);
      if (Number.isFinite(parsed) && parsed > 0) budget = Math.floor(parsed);
    }
  }
  return { projectId, budget };
}

type InjectScope = 'project' | 'global' | 'private';

function queryObservations(
  db: SqliteDatabase,
  scope: InjectScope,
  projectId: string,
  limit: number
): RenderableObservation[] {
  const orderBy = `CASE o.confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC, o.valid_from DESC`;
  if (scope === 'global') {
    return db
      .prepare(
        `SELECT o.id as id, n.canonical as canonical, o.text as text, o.scope as scope,
                o.category as category, o.confidence as confidence, o.valid_from as validFrom
         FROM observations o JOIN nodes n ON n.id = o.node_id
         WHERE o.invalidated_at IS NULL AND o.scope = 'global'
         ORDER BY ${orderBy}
         LIMIT ?`
      )
      .all(limit) as unknown as RenderableObservation[];
  }
  return db
    .prepare(
      `SELECT o.id as id, n.canonical as canonical, o.text as text, o.scope as scope,
              o.category as category, o.confidence as confidence, o.valid_from as validFrom
       FROM observations o JOIN nodes n ON n.id = o.node_id
       WHERE o.invalidated_at IS NULL AND o.scope = ? AND o.project_id = ?
       ORDER BY ${orderBy}
       LIMIT ?`
    )
    .all(scope, projectId, limit) as unknown as RenderableObservation[];
}

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Builds the injectable text block, enforcing the byte budget by dropping
 * whole trailing facts (never truncating mid-line). Returns '' if there is
 * nothing to inject. */
export function buildInjectOutput(db: SqliteDatabase, projectId: string, budget: number): string {
  const projectFacts = queryObservations(db, 'project', projectId, 300);
  const globalFacts = queryObservations(db, 'global', projectId, 50);
  const privateFacts = queryObservations(db, 'private', projectId, 300);

  const totalFacts = projectFacts.length + globalFacts.length + privateFacts.length;
  if (totalFacts === 0) return '';

  const header =
    `# Orchestra graph memory — auto-injected at session start for project ${projectId}. ` +
    `These facts were remembered from past sessions across this project, global scope, and ` +
    `this project's private facts. Use the orchestra-memory MCP tools (memory_search, ` +
    `memory_traverse, memory_inspect) to explore further, and memory_save to add new facts.`;

  const sections: Array<{ title: string; lines: string[] }> = [];
  if (projectFacts.length > 0) {
    sections.push({ title: '## Project facts', lines: projectFacts.map(renderObservationLine) });
  }
  if (globalFacts.length > 0) {
    sections.push({ title: '## Global facts', lines: globalFacts.map(renderObservationLine) });
  }
  if (privateFacts.length > 0) {
    sections.push({
      title: '## Private facts (this project only)',
      lines: privateFacts.map(renderObservationLine),
    });
  }

  const kept: string[] = [header, ''];
  let usedBytes = byteLen(kept.join('\n'));
  let includedFacts = 0;
  let truncated = false;

  sectionLoop: for (const section of sections) {
    const headerCost = byteLen(section.title) + 1;
    if (usedBytes + headerCost > budget) {
      truncated = true;
      break;
    }
    kept.push(section.title);
    usedBytes += headerCost;
    for (const line of section.lines) {
      const cost = byteLen(line) + 1;
      if (usedBytes + cost > budget) {
        truncated = true;
        break sectionLoop;
      }
      kept.push(line);
      usedBytes += cost;
      includedFacts += 1;
    }
  }

  if (truncated) {
    kept.push(`[+${totalFacts - includedFacts} more facts — use memory_search]`);
  }

  return kept.join('\n');
}

/** Entry point for `node dist/server.mjs --inject ...`. Never throws —
 * always exits 0, printing the injectable block (if any) to stdout and
 * diagnostics (if any) to stderr only. */
export function runInject(argv: string[]): void {
  try {
    const { projectId, budget } = parseArgs(argv);
    if (!projectId) {
      process.stderr.write('orchestra-memory --inject: missing --project-id, nothing to inject\n');
    } else {
      const { db, diagnostic } = tryOpenDb();
      if (!db) {
        if (diagnostic) process.stderr.write(`${diagnostic}\n`);
      } else {
        const output = buildInjectOutput(db, projectId, budget);
        if (output) process.stdout.write(output);
      }
    }
    // Single exit point: tests mock process.exit as a no-op, so early exits
    // must not be followed by more work (or exit would fire twice).
    process.exit(0);
  } catch (err) {
    try {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`orchestra-memory --inject failed (fail-open, exiting 0): ${message}\n`);
    } catch {
      // stderr itself failed — nothing more we can do; still fail open.
    }
    process.exit(0);
  }
}
