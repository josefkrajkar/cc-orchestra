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

const WISDOM_CATEGORIES = ['convention', 'gotcha', 'decision', 'failed_approach'] as const;

export const getName = 'wisdom_get';

export const getDescription = `Read accumulated wisdom (conventions/gotchas/decisions/failed_approaches).

Returns valid (non-invalidated) observations whose category is one of convention, gotcha,
decision, or failed_approach, scoped to "global" (visible everywhere) plus "project" and
"private" for your own project (project_id defaults to this server instance's own project
identity; a different project's id is rejected). Output is grouped by category with a
confidence marker per entry, and flags entries older than 90 days with ⚠️ as candidates for
review, matching Orchestra's existing /wisdom display format. Internally this is the same
underlying data as memory_search filtered to wisdom categories — prefer this tool over
memory_search when you specifically want conventions/gotchas/decisions/failed_approaches rather
than arbitrary facts.`;

export const getInputShape = {
  project_id: z.string().optional(),
};

const getInputSchema = z.object(getInputShape);
export type WisdomGetInput = z.infer<typeof getInputSchema>;

export interface WisdomGetOutput {
  text: string;
}

function listWisdomRows(db: SqliteDatabase, projectId: string | null): WisdomRow[] {
  const categoryPlaceholders = WISDOM_CATEGORIES.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT o.category as category, o.text as text, o.confidence as confidence,
              o.valid_from as validFrom
       FROM observations o
       WHERE o.invalidated_at IS NULL
         AND o.category IN (${categoryPlaceholders})
         AND (o.scope = 'global' OR (o.scope IN ('project','private') AND o.project_id = ?))
       ORDER BY CASE o.confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC,
                o.valid_from DESC`
    )
    .all(...WISDOM_CATEGORIES, projectId) as unknown as WisdomRow[];
  return rows;
}

export function handleWisdomGet(db: SqliteDatabase, input: WisdomGetInput, ctx: ToolContext): WisdomGetOutput {
  const resolved = resolveProjectId(ctx, input.project_id);
  if (!resolved.ok) {
    return { text: `Rejected: ${resolved.message}` };
  }
  const rows = listWisdomRows(db, resolved.projectId);
  return { text: renderWisdom(rows) };
}

export const addName = 'wisdom_add';

export const addDescription = `Add a single wisdom entry (convention/gotcha/decision/failed_approach).

Thin wrapper over memory_save: writes "text" as an atomic, self-contained observation attached
to a per-project "project wisdom" entity, tagged with the given "category". "scope" defaults to
"project" (your own project, per project_id's normal default/mismatch rules) — pass
scope: "global" explicitly to share wisdom across every project (an intentional opt-in, not the
default), or scope: "private" for client-confidential wisdom scoped to your own project only.
Same distillation rules as memory_save apply to "text" — it must be a complete, self-contained
sentence, not a fragment referring back to the conversation. Duplicate detection is identical to
memory_save: an exact-normalized repeat of existing wisdom text is reported as a duplicate
rather than re-inserted.`;

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
