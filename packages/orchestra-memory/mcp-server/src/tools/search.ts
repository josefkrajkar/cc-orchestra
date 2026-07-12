// memory_search — FTS5 BM25 search over valid observations, scope-guarded.
// Relations directly among matched nodes always render; 1-hop expansion into
// the wider graph is opt-in via `expand: true` (see handleSearch below).
import { z } from 'zod';
import type { Repository, Scope } from '../db/repository.js';
import { renderSearchResults } from '../render.js';
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

export interface SearchOutput {
  text: string;
}

export async function handleSearch(
  repo: Repository,
  input: SearchInput,
  ctx: ToolContext
): Promise<SearchOutput> {
  const scopes = input.scope_filter as Scope[] | undefined;
  if (isPrivateDenied(ctx, scopes)) {
    return { text: `Rejected: ${privateDeniedMessage()}` };
  }
  const resolved = resolveProjectId(ctx, input.project_id);
  if (!resolved.ok) {
    return { text: `Rejected: ${resolved.message}` };
  }
  const projectId = resolved.projectId;
  const results = await repo.searchObservations({
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
    ? await repo.expandFromNodes(nodeIds, 1, scopes, projectId)
    : [];
  const edgeSourceIds = input.expand === true ? expanded.map((n) => n.id) : nodeIds;
  const edges = edgeSourceIds.length > 0 ? await repo.fetchVisibleEdges(edgeSourceIds, projectId) : [];

  const text = renderSearchResults(results, expanded, edges);
  return { text };
}
