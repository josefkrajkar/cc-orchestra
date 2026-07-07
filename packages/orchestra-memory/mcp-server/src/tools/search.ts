// memory_search — FTS5 BM25 search over valid observations, scope-guarded.
// Relations directly among matched nodes always render; 1-hop expansion into
// the wider graph is opt-in via `expand: true` (see handleSearch below).
import { z } from 'zod';
import type { SqliteDatabase } from '../db/connection.js';
import type { Repository, Scope } from '../db/repository.js';
import { renderSearchResults, type RenderableEdge } from '../render.js';
import { isPrivateDenied, privateDeniedMessage, resolveProjectId, type ToolContext } from './context.js';
import { LINE_FORMAT_NOTE, SCOPE_NOTE } from './descriptions.js';

export const name = 'memory_search';

export const description = `Search the cross-project graph memory for facts matching a query.

Full-text (BM25) search over valid observations. Direct relations between matched facts are
always included; expand:true additionally pulls 1-hop neighbor facts (capped per node). ${SCOPE_NOTE} ${LINE_FORMAT_NOTE} "#<id>" is reusable later
(supersedes_observation_id, observation_id).`;

export const inputShape = {
  query: z.string().min(1, 'query must not be empty'),
  scope_filter: z.array(z.enum(['global', 'project', 'private'])).optional(),
  project_id: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  include_invalidated: z.boolean().optional(),
  expand: z.boolean().optional(),
};

const inputSchema = z.object(inputShape);
export type SearchInput = z.infer<typeof inputSchema>;

/**
 * Fetches valid graph edges connecting a set of already scope-visible node
 * ids, for rendering as "src -predicate-> dst" triples.
 *
 * Repository gap: db/repository.ts's expandFromNodes() returns which nodes
 * are reachable but not the edges (predicate strings) that connect them, and
 * there is no public method to list raw edges. Since repository.ts is
 * frozen, this queries the underlying SqliteDatabase directly, re-applying
 * the exact same scope guard predicate documented in repository.ts's
 * scopeGuard(): a row is visible iff scope='global' OR (scope IN
 * ('project','private') AND project_id matches the caller's project). This
 * mirrors the pattern already used by mcp-server/test/repository.test.ts,
 * which also queries `db` directly. See the Craftsman Report for a
 * recommendation to add a proper repository.getEdges() method.
 */
export function fetchVisibleEdges(
  db: SqliteDatabase,
  nodeIds: number[],
  projectId: string | null
): RenderableEdge[] {
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT sn.canonical as srcCanonical, e.predicate as predicate, dn.canonical as dstCanonical
       FROM edges e
       JOIN nodes sn ON sn.id = e.src_id
       JOIN nodes dn ON dn.id = e.dst_id
       WHERE e.invalidated_at IS NULL
         AND e.src_id IN (${placeholders})
         AND e.dst_id IN (${placeholders})
         AND (e.scope = 'global' OR (e.scope IN ('project','private') AND e.project_id = ?))
       ORDER BY e.created_at ASC`
    )
    .all(...nodeIds, ...nodeIds, projectId) as unknown as RenderableEdge[];
  return rows;
}

export interface SearchOutput {
  text: string;
}

export function handleSearch(
  repo: Repository,
  db: SqliteDatabase,
  input: SearchInput,
  ctx: ToolContext
): SearchOutput {
  const scopes = input.scope_filter as Scope[] | undefined;
  if (isPrivateDenied(ctx, scopes)) {
    return { text: `Rejected: ${privateDeniedMessage()}` };
  }
  const resolved = resolveProjectId(ctx, input.project_id);
  if (!resolved.ok) {
    return { text: `Rejected: ${resolved.message}` };
  }
  const projectId = resolved.projectId;
  const results = repo.searchObservations({
    query: input.query,
    scopes,
    projectId,
    limit: input.limit ?? 20,
    includeInvalidated: input.include_invalidated ?? false,
  });

  const nodeIds = [...new Set(results.map((r) => r.nodeId))];

  // 1-hop expansion into the wider graph is opt-in (expand:true) — it's the
  // expensive fan-out. When it's off, we still surface direct relations
  // between the matched nodes themselves via fetchVisibleEdges over just
  // nodeIds, which is cheap and bounded by the search result count.
  const expanded = input.expand === true && nodeIds.length > 0
    ? repo.expandFromNodes(nodeIds, 1, scopes, projectId)
    : [];
  const edgeSourceIds = input.expand === true ? expanded.map((n) => n.id) : nodeIds;
  const edges = edgeSourceIds.length > 0 ? fetchVisibleEdges(db, edgeSourceIds, projectId) : [];

  const text = renderSearchResults(results, expanded, edges);
  return { text };
}
