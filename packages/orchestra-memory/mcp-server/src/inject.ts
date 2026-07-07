// CLI inject mode, consumed by Phase 3's SessionStart bash hook:
//   node dist/server.mjs --inject --project-id <key> [--budget <bytes>] [--inject-mode <index|full>]
//
// No MCP handshake — this opens the DB directly and prints plain text to
// stdout, then exits. Contract (see docs/design/graph-memory-design.md Phase 3):
//   1. project-scope valid facts for project_id (confidence desc, recency desc)
//   2. top-K global facts
//   3. private facts of THIS project only
// Byte-budget enforced by truncating whole facts (never mid-line); when
// truncated, appends "[+N more facts — use memory_search]".
//
// --inject-mode (D10: OFF by default, opt-in via ORCHESTRA_MEMORY_INJECT_MODE
// env var in the calling hook script until validated): 'full' (default) is
// the dump above; 'index' is a smaller "Pinned + entity roster" summary —
// see buildInjectIndex. Unknown/omitted values fail open to 'full'.
//
// Fail-open is the hard requirement here: on ANY error (missing project id,
// node:sqlite unavailable, corrupt DB, unexpected row shape) this must exit
// 0 with empty stdout and put diagnostics on stderr only — a broken memory
// layer must never break the SessionStart hook it's injected from.
import { tryOpenDb, type SqliteDatabase } from './db/connection.js';
import { renderObservationLine, type RenderableObservation } from './render.js';

const DEFAULT_BUDGET_BYTES = 9500;
// Index mode (D10: off by default, opt-in via ORCHESTRA_MEMORY_INJECT_MODE)
// aims for a ~500-token summary instead of a full dump, so its default
// budget is far smaller than full mode's.
const INDEX_DEFAULT_BUDGET_BYTES = 2000;

type InjectMode = 'index' | 'full';

interface InjectArgs {
  projectId: string | null;
  budget: number;
  mode: InjectMode;
}

function parseArgs(argv: string[]): InjectArgs {
  let projectId: string | null = null;
  let explicitBudget: number | null = null;
  let mode: InjectMode = 'full';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project-id') {
      projectId = argv[++i]?.trim() || null;
    } else if (arg === '--budget') {
      const parsed = Number(argv[++i]);
      if (Number.isFinite(parsed) && parsed > 0) explicitBudget = Math.floor(parsed);
    } else if (arg === '--inject-mode') {
      // Fail-open on unknown values: anything other than exactly 'index'
      // keeps the validated, ships-by-default full-dump behavior.
      mode = argv[++i] === 'index' ? 'index' : 'full';
    }
  }
  const budget = explicitBudget ?? (mode === 'index' ? INDEX_DEFAULT_BUDGET_BYTES : DEFAULT_BUDGET_BYTES);
  return { projectId, budget, mode };
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

/** Same scope predicate as queryObservations, but limited to confidence
 * 'high' and ordered purely by recency — used for the index mode's "Pinned"
 * section, which is a small, high-signal cross-scope slice rather than a
 * confidence-then-recency dump. */
function queryHighConfidenceObservations(
  db: SqliteDatabase,
  scope: InjectScope,
  projectId: string,
  limit: number
): RenderableObservation[] {
  if (scope === 'global') {
    return db
      .prepare(
        `SELECT o.id as id, n.canonical as canonical, o.text as text, o.scope as scope,
                o.category as category, o.confidence as confidence, o.valid_from as validFrom
         FROM observations o JOIN nodes n ON n.id = o.node_id
         WHERE o.invalidated_at IS NULL AND o.scope = 'global' AND o.confidence = 'high'
         ORDER BY o.valid_from DESC
         LIMIT ?`
      )
      .all(limit) as unknown as RenderableObservation[];
  }
  return db
    .prepare(
      `SELECT o.id as id, n.canonical as canonical, o.text as text, o.scope as scope,
              o.category as category, o.confidence as confidence, o.valid_from as validFrom
       FROM observations o JOIN nodes n ON n.id = o.node_id
       WHERE o.invalidated_at IS NULL AND o.scope = ? AND o.project_id = ? AND o.confidence = 'high'
       ORDER BY o.valid_from DESC
       LIMIT ?`
    )
    .all(scope, projectId, limit) as unknown as RenderableObservation[];
}

interface EntityRosterRow {
  canonical: string;
  count: number;
}

/** Every node with >=1 valid observation visible to this project (same
 * project+global+private-of-this-project scope rule as buildInjectOutput),
 * with a count of how many visible observations back it, most-recently
 * observed first. */
function queryEntityRoster(db: SqliteDatabase, projectId: string): EntityRosterRow[] {
  return db
    .prepare(
      `SELECT n.canonical as canonical, COUNT(*) as count
       FROM observations o JOIN nodes n ON n.id = o.node_id
       WHERE o.invalidated_at IS NULL
         AND (o.scope = 'global' OR (o.scope IN ('project','private') AND o.project_id = ?))
       GROUP BY o.node_id
       ORDER BY MAX(o.valid_from) DESC`
    )
    .all(projectId) as unknown as EntityRosterRow[];
}

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Max rendered width (bytes) of a single "Entities" line before wrapping
 * to the next one — purely a readability wrap, independent of the overall
 * byte budget (which is enforced separately, at whole-entity granularity). */
const ENTITY_LINE_WIDTH = 100;

const PINNED_CAP = 8;

/** Builds the injectable text block, enforcing the byte budget by dropping
 * whole trailing facts (never truncating mid-line). Returns '' if there is
 * nothing to inject. */
export function buildInjectOutput(db: SqliteDatabase, projectId: string, budget: number): string {
  const projectFacts = queryObservations(db, 'project', projectId, 300);
  const globalFacts = queryObservations(db, 'global', projectId, 50);
  const privateFacts = queryObservations(db, 'private', projectId, 300);

  const totalFacts = projectFacts.length + globalFacts.length + privateFacts.length;
  if (totalFacts === 0) return '';

  const header = `# Graph memory (project ${projectId}) — memory_search to expand.`;

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

/** Experimental (D10: ships OFF by default) lazy alternative to
 * buildInjectOutput: instead of dumping every visible fact, prints a small
 * "Pinned" slice of the highest-confidence facts plus a compact entity
 * roster the calling model can expand on demand via memory_search. Aims
 * for roughly a ~500-token footprint (default budget: 2000 bytes) rather
 * than a full dump. Same never-truncate-mid-item budget discipline as
 * buildInjectOutput. Returns '' if there is nothing visible to inject. */
export function buildInjectIndex(db: SqliteDatabase, projectId: string, budget: number): string {
  const pinned = [
    ...queryHighConfidenceObservations(db, 'project', projectId, PINNED_CAP),
    ...queryHighConfidenceObservations(db, 'global', projectId, PINNED_CAP),
    ...queryHighConfidenceObservations(db, 'private', projectId, PINNED_CAP),
  ]
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom))
    .slice(0, PINNED_CAP);

  const entities = queryEntityRoster(db, projectId);
  if (entities.length === 0) return '';

  const header = `# Graph memory index (project ${projectId}) — memory_search <entity> to expand.`;
  const kept: string[] = [header, ''];
  let usedBytes = byteLen(kept.join('\n'));

  if (pinned.length > 0) {
    const title = '## Pinned (high-confidence)';
    const titleCost = byteLen(title) + 1;
    if (usedBytes + titleCost <= budget) {
      kept.push(title);
      usedBytes += titleCost;
      for (const obs of pinned) {
        const line = renderObservationLine(obs);
        const cost = byteLen(line) + 1;
        if (usedBytes + cost > budget) break;
        kept.push(line);
        usedBytes += cost;
      }
    }
  }

  const entityTitle = '## Entities (facts)';
  const entityTitleCost = byteLen(entityTitle) + 1;
  let includedEntities = 0;
  if (usedBytes + entityTitleCost <= budget) {
    kept.push(entityTitle);
    usedBytes += entityTitleCost;

    // Packs "canonical (count)" items onto wrapped lines (joined by " · "),
    // checking the overall byte budget at whole-item granularity so an
    // item is never split mid-way — only ever dropped whole, from the end.
    let openLineIdx = -1;
    for (const row of entities) {
      const item = `${row.canonical} (${row.count})`;
      const openLine = openLineIdx === -1 ? null : kept[openLineIdx]!;
      const isNewLine = openLine === null || byteLen(`${openLine} · ${item}`) > ENTITY_LINE_WIDTH;
      const newLine = isNewLine ? item : `${openLine} · ${item}`;
      const prevLineCost = isNewLine ? 0 : byteLen(openLine!) + 1;
      const newLineCost = byteLen(newLine) + 1;
      if (usedBytes - prevLineCost + newLineCost > budget) break;

      usedBytes = usedBytes - prevLineCost + newLineCost;
      if (isNewLine) {
        kept.push(newLine);
        openLineIdx = kept.length - 1;
      } else {
        kept[openLineIdx] = newLine;
      }
      includedEntities += 1;
    }

    if (includedEntities < entities.length) {
      kept.push(`[+${entities.length - includedEntities} more entities — memory_stats / memory_search]`);
    }
  }

  return kept.join('\n');
}

/** Entry point for `node dist/server.mjs --inject ...`. Never throws —
 * always exits 0, printing the injectable block (if any) to stdout and
 * diagnostics (if any) to stderr only. */
export function runInject(argv: string[]): void {
  try {
    const { projectId, budget, mode } = parseArgs(argv);
    if (!projectId) {
      process.stderr.write('orchestra-memory --inject: missing --project-id, nothing to inject\n');
    } else {
      const { db, diagnostic } = tryOpenDb();
      if (!db) {
        if (diagnostic) process.stderr.write(`${diagnostic}\n`);
      } else {
        const output =
          mode === 'index' ? buildInjectIndex(db, projectId, budget) : buildInjectOutput(db, projectId, budget);
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
