// memory_inspect — the only human-readable (markdown) output in the system.
// A debug/trust escape hatch: shows full metadata (confidence, valid_from,
// invalidated_at, superseded_by, source, project_label) that the
// token-dense renders used by memory_search/memory_traverse deliberately
// omit.
//
// Repository gap: db/repository.ts exposes no method to list nodes/
// observations by scope/project without either a graph edge (expandFromNodes)
// or an FTS query (searchObservations) — and neither of those return
// `source`/`project_label`, and expandFromNodes excludes invalidated
// observations entirely. Since repository.ts is frozen, this tool queries
// the underlying SqliteDatabase directly (the same pattern already used by
// mcp-server/test/repository.test.ts), re-applying the scope guard
// documented in repository.ts's scopeGuard() at both the node and
// observation level for defense in depth. See the Craftsman Report for a
// recommendation to add a proper repository.listNodes()/listObservations()
// pair.
import { z } from 'zod';
import type { SqliteDatabase } from '../db/connection.js';
import type { Scope } from '../db/repository.js';
import { renderInspect, type InspectNodeRow, type InspectObservationRow } from '../render.js';
import { isPrivateDenied, privateDeniedMessage, resolveProjectId, type ToolContext } from './context.js';
import { SCOPE_NOTE } from './descriptions.js';

export const name = 'memory_inspect';

export const description = `Debug/trust escape hatch: a human-readable markdown view of stored memory.

Unlike every other tool here, output is prose markdown for a human to audit, not token-dense LLM
input. Shows full metadata (confidence, source, valid_from, invalidated_at, superseded_by),
including invalidated/superseded facts which memory_search/memory_traverse hide. ${SCOPE_NOTE}
Filter by entity/scope_filter/project_id; omit for a recent slice of everything visible to you.`;

export const inputShape = {
  scope_filter: z.array(z.enum(['global', 'project', 'private'])).optional(),
  project_id: z.string().optional(),
  entity: z.string().optional(),
};

const inputSchema = z.object(inputShape);
export type InspectInput = z.infer<typeof inputSchema>;

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

interface RawNodeRow {
  id: number;
  canonical: string;
  kind: string;
  scope: Scope;
  projectId: string | null;
  projectLabel: string | null;
}

function listNodes(
  db: SqliteDatabase,
  scopes: Scope[] | undefined,
  projectId: string | null,
  entityFilter: string | undefined
): RawNodeRow[] {
  const params: Array<string | number | null> = [projectId];
  let sql = `SELECT n.id as id, n.canonical as canonical, n.kind as kind, n.scope as scope,
                    n.project_id as projectId, n.project_label as projectLabel
             FROM nodes n
             WHERE (n.scope = 'global' OR (n.scope IN ('project','private') AND n.project_id = ?))`;

  if (scopes && scopes.length > 0) {
    sql += ` AND n.scope IN (${scopes.map(() => '?').join(',')})`;
    params.push(...scopes);
  }

  if (entityFilter) {
    const likePattern = `%${normalize(entityFilter).replace(/[%_]/g, '\\$&')}%`;
    sql += ` AND (n.canonical LIKE ? ESCAPE '\\' OR n.id IN (
                SELECT node_id FROM node_aliases WHERE alias LIKE ? ESCAPE '\\'
             ))`;
    params.push(likePattern, likePattern);
  }

  sql += ' ORDER BY n.updated_at DESC LIMIT 50';
  return db.prepare(sql).all(...params) as unknown as RawNodeRow[];
}

function listObservationsForNode(
  db: SqliteDatabase,
  nodeId: number,
  projectId: string | null
): InspectObservationRow[] {
  return db
    .prepare(
      `SELECT id, text, category, confidence, source,
              valid_from as validFrom, invalidated_at as invalidatedAt, superseded_by as supersededBy
       FROM observations o
       WHERE o.node_id = ?
         AND (o.scope = 'global' OR (o.scope IN ('project','private') AND o.project_id = ?))
       ORDER BY o.valid_from DESC`
    )
    .all(nodeId, projectId) as unknown as InspectObservationRow[];
}

export interface InspectOutput {
  text: string;
}

export function handleInspect(db: SqliteDatabase, input: InspectInput, ctx: ToolContext): InspectOutput {
  const scopes = input.scope_filter as Scope[] | undefined;
  if (isPrivateDenied(ctx, scopes)) {
    return { text: `Rejected: ${privateDeniedMessage()}` };
  }
  const resolved = resolveProjectId(ctx, input.project_id);
  if (!resolved.ok) {
    return { text: `Rejected: ${resolved.message}` };
  }
  const projectId = resolved.projectId;

  const nodes = listNodes(db, scopes, projectId, input.entity);
  const rows: InspectNodeRow[] = nodes.map((n) => ({
    ...n,
    observations: listObservationsForNode(db, n.id, projectId),
  }));

  return { text: renderInspect(rows) };
}
