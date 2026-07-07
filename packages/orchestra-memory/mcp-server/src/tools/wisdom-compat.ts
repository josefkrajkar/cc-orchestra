// wisdom_get / wisdom_add — backward-compat surface over the graph memory
// for Orchestra's existing wisdom concept (conventions/gotchas/decisions/
// failed_approaches). wisdom_add is a thin wrapper over memory_save's write
// path; wisdom_get lists valid wisdom-category observations for global +
// the caller's project scope.
//
// Repository gap: like memory_inspect, this needs a plain "list valid
// observations matching category/scope/project" query, which
// db/repository.ts does not expose (only FTS search or graph expansion).
// Since repository.ts is frozen, wisdom_get queries the underlying
// SqliteDatabase directly, re-applying the scope guard documented in
// repository.ts's scopeGuard(). See the Craftsman Report for a
// recommendation to add a repository.listObservations() method that would
// let this (and memory_inspect) drop the direct-SQL workaround.
import { z } from 'zod';
import type { SqliteDatabase } from '../db/connection.js';
import type { Repository, Scope } from '../db/repository.js';
import { renderWisdom, type WisdomRow } from '../render.js';
import { resolveProjectId, type ToolContext } from './context.js';
import { handleSave } from './save.js';
import { DISTILL_NOTE, SCOPE_NOTE } from './descriptions.js';

const WISDOM_CATEGORIES = ['convention', 'gotcha', 'decision', 'failed_approach'] as const;

export const getName = 'wisdom_get';

// Thin compat wrapper: internally the same data as memory_search, filtered
// to wisdom categories and rendered in Orchestra's /wisdom format.
export const getDescription = `Read accumulated wisdom (conventions/gotchas/decisions/failed_approaches) — a thin, pre-filtered view over memory_search's data.

${SCOPE_NOTE} Grouped by category with a confidence marker; flags entries older than 90 days
with ⚠️. "limit" caps returned rows (default 30, max 200); "category" narrows to a single wisdom category.`;

const DEFAULT_WISDOM_LIMIT = 30;

export const getInputShape = {
  project_id: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  category: z.enum(WISDOM_CATEGORIES).optional(),
};

const getInputSchema = z.object(getInputShape);
export type WisdomGetInput = z.infer<typeof getInputSchema>;

export interface WisdomGetOutput {
  text: string;
}

interface ListWisdomResult {
  rows: WisdomRow[];
  total: number;
}

function listWisdomRows(
  db: SqliteDatabase,
  projectId: string | null,
  category: string | undefined,
  limit: number
): ListWisdomResult {
  const categories = category ? [category] : [...WISDOM_CATEGORIES];
  const categoryPlaceholders = categories.map(() => '?').join(',');
  // Scope guard kept semantically identical to the pre-filter version: global
  // rows are always visible, project/private rows only when they match the
  // caller's resolved project_id.
  const whereClause = `WHERE o.invalidated_at IS NULL
         AND o.category IN (${categoryPlaceholders})
         AND (o.scope = 'global' OR (o.scope IN ('project','private') AND o.project_id = ?))`;

  const total = (
    db
      .prepare(`SELECT COUNT(*) as count FROM observations o ${whereClause}`)
      .get(...categories, projectId) as { count: number }
  ).count;

  const rows = db
    .prepare(
      `SELECT o.category as category, o.text as text, o.confidence as confidence,
              o.valid_from as validFrom
       FROM observations o
       ${whereClause}
       ORDER BY CASE o.confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC,
                o.valid_from DESC
       LIMIT ?`
    )
    .all(...categories, projectId, limit) as unknown as WisdomRow[];

  return { rows, total };
}

export function handleWisdomGet(db: SqliteDatabase, input: WisdomGetInput, ctx: ToolContext): WisdomGetOutput {
  const resolved = resolveProjectId(ctx, input.project_id);
  if (!resolved.ok) {
    return { text: `Rejected: ${resolved.message}` };
  }
  const limit = input.limit ?? DEFAULT_WISDOM_LIMIT;
  const { rows, total } = listWisdomRows(db, resolved.projectId, input.category, limit);
  const text = renderWisdom(rows);
  if (total > rows.length) {
    return { text: `${text}\n\n[+${total - rows.length} more — raise limit or filter by category]` };
  }
  return { text };
}

export const addName = 'wisdom_add';

// Thin compat wrapper: internally calls memory_save with a fixed "project
// wisdom" entity, so its behavior (duplicate detection, validation) matches.
export const addDescription = `Add a single wisdom entry (convention/gotcha/decision/failed_approach) — a thin wrapper over memory_save.

${DISTILL_NOTE} ${SCOPE_NOTE} "scope" defaults to "project".`;

export const addInputShape = {
  text: z.string().min(1, 'text must not be empty'),
  category: z.enum(WISDOM_CATEGORIES),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  project_id: z.string().optional(),
  scope: z.enum(['project', 'global', 'private']).optional(),
};

const addInputSchema = z.object(addInputShape);
export type WisdomAddInput = z.infer<typeof addInputSchema>;

export interface WisdomAddOutput {
  text: string;
}

export function handleWisdomAdd(
  repo: Repository,
  db: SqliteDatabase,
  input: WisdomAddInput,
  ctx: ToolContext
): WisdomAddOutput {
  const scope: Scope = input.scope ?? 'project';
  const result = handleSave(
    repo,
    db,
    {
      facts: [
        {
          entity: { name: 'project wisdom', kind: 'wisdom' },
          text: input.text,
          category: input.category,
          confidence: input.confidence,
        },
      ],
      relations: [],
      scope,
      project_id: input.project_id,
      source: 'wisdom_add',
    },
    ctx
  );
  return { text: result.text };
}
