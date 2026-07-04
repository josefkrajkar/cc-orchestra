// memory_traverse — graph walk from a named entity out to a given depth,
// resolving the entity by canonical name or alias without creating it.
import { z } from 'zod';
import type { SqliteDatabase } from '../db/connection.js';
import type { Repository, Scope, SimilarNode } from '../db/repository.js';
import { renderTraverse } from '../render.js';
import { isPrivateDenied, privateDeniedMessage, resolveProjectId, type ToolContext } from './context.js';
import { fetchVisibleEdges } from './search.js';

export const name = 'memory_traverse';

export const description = `Walk the graph outward from a named entity to see everything connected to it.

Resolves "entity" by canonical name or known alias (case/whitespace-insensitive) — it does NOT
create a new entity if none is found, unlike memory_save. Looks in the "global" scope plus your
OWN project's "project"/"private" scopes; project_id defaults to this server instance's own
project identity and passing a different project's id is rejected. Returns the connected
entities' valid observations plus the graph edges between them, rendered as token-dense lines
("#<id> [scope|category|confidence|date] entity: text") and relation triples
("src -predicate-> dst"). depth controls how many hops to follow (default 2, max 4) — keep it
low for broad hubs to avoid an overwhelming response.`;

export const inputShape = {
  entity: z.string().min(1, 'entity must not be empty'),
  depth: z.number().int().min(0).max(4).optional(),
  scope_filter: z.array(z.enum(['global', 'project', 'private'])).optional(),
  project_id: z.string().optional(),
};

const inputSchema = z.object(inputShape);
export type TraverseInput = z.infer<typeof inputSchema>;

/** lowercase + trim + collapse whitespace — mirrors repository.ts's entity
 * canonicalization spec, applied here only to pick the best fuzzy candidate
 * (not security-sensitive: scope filtering still happens in repository.ts). */
function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Resolves an entity by canonical name or alias without creating it.
 * db/repository.ts has no read-only "find node by exact name" method — only
 * upsertNode() (which creates on miss) and findSimilarNodes() (fuzzy LIKE
 * match within a single scope). This combines findSimilarNodes() across the
 * visible scopes (global, plus project/private for the caller's project) and
 * prefers an exact canonical match over a fuzzy one.
 */
export function resolveEntityNode(
  repo: Repository,
  entity: string,
  projectId: string | null
): SimilarNode | null {
  const normalized = normalize(entity);
  const attempts: Array<{ scope: Scope; projectId: string | null }> = [{ scope: 'global', projectId: null }];
  if (projectId) {
    attempts.push({ scope: 'project', projectId });
    attempts.push({ scope: 'private', projectId });
  }
  const candidates: SimilarNode[] = [];
  for (const attempt of attempts) {
    candidates.push(...repo.findSimilarNodes(entity, attempt.scope, attempt.projectId, 25));
  }
  if (candidates.length === 0) return null;
  return candidates.find((c) => c.canonical === normalized) ?? candidates[0] ?? null;
}

export interface TraverseOutput {
  text: string;
}

export function handleTraverse(
  repo: Repository,
  db: SqliteDatabase,
  input: TraverseInput,
  ctx: ToolContext
): TraverseOutput {
  const depth = Math.min(input.depth ?? 2, 4);
  const scopes = input.scope_filter as Scope[] | undefined;
  if (isPrivateDenied(ctx, scopes)) {
    return { text: `Rejected: ${privateDeniedMessage()}` };
  }
  const resolved = resolveProjectId(ctx, input.project_id);
  if (!resolved.ok) {
    return { text: `Rejected: ${resolved.message}` };
  }
  const projectId = resolved.projectId;

  const root = resolveEntityNode(repo, input.entity, projectId);
  if (!root) {
    return { text: `No entity found matching "${input.entity}".` };
  }

  const expanded = repo.expandFromNodes([root.id], depth, scopes, projectId);
  const nodeIds = expanded.map((n) => n.id);
  const edges = nodeIds.length > 0 ? fetchVisibleEdges(db, nodeIds, projectId) : [];

  const text = renderTraverse(root.canonical, depth, expanded, edges);
  return { text };
}
