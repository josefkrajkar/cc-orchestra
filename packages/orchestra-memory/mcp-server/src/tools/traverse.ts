// memory_traverse — graph walk from a named entity out to a given depth,
// resolving the entity by canonical name or alias without creating it.
import { z } from 'zod';
import type { Repository, Scope, SimilarNode } from '../db/repository.js';
import { renderTraverse } from '../render.js';
import { isPrivateDenied, privateDeniedMessage, resolveProjectId, type ToolContext } from './context.js';
import { LINE_FORMAT_NOTE, SCOPE_NOTE } from './descriptions.js';

export const name = 'memory_traverse';

/** Cap on the number of expanded nodes passed to rendering — keeps a broad
 * hub's traversal from dumping an unbounded node list on the caller. The
 * root node is always kept; overflow is summarized with a trailing marker
 * line rather than silently dropped. Exported so tests can assert against it
 * rather than hardcoding "40". */
export const TRAVERSE_NODE_CAP = 40;

export const description = `Walk the graph outward from a named entity to see everything connected to it.

Resolves "entity" by canonical name or alias — unlike memory_save, it does NOT create one if
none is found. ${SCOPE_NOTE} ${LINE_FORMAT_NOTE} "depth" is hops to follow (default 2, max 4) —
keep it low for broad hubs; expanded nodes are capped at ${TRAVERSE_NODE_CAP} (override via
"max_nodes").`;

export const inputShape = {
  entity: z.string().min(1, 'entity must not be empty'),
  depth: z.number().int().min(0).max(4).optional(),
  scope_filter: z.array(z.enum(['global', 'project', 'private'])).optional(),
  project_id: z.string().optional(),
  max_nodes: z.number().int().positive().max(200).optional(),
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
export async function resolveEntityNode(
  repo: Repository,
  entity: string,
  projectId: string | null
): Promise<SimilarNode | null> {
  const normalized = normalize(entity);
  const attempts: Array<{ scope: Scope; projectId: string | null }> = [{ scope: 'global', projectId: null }];
  if (projectId) {
    attempts.push({ scope: 'project', projectId });
    attempts.push({ scope: 'private', projectId });
  }
  const candidates: SimilarNode[] = [];
  for (const attempt of attempts) {
    candidates.push(...(await repo.findSimilarNodes(entity, attempt.scope, attempt.projectId, 25)));
  }
  if (candidates.length === 0) return null;
  return candidates.find((c) => c.canonical === normalized) ?? candidates[0] ?? null;
}

export interface TraverseOutput {
  text: string;
}

export async function handleTraverse(
  repo: Repository,
  input: TraverseInput,
  ctx: ToolContext
): Promise<TraverseOutput> {
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

  const root = await resolveEntityNode(repo, input.entity, projectId);
  if (!root) {
    return { text: `No entity found matching "${input.entity}".` };
  }

  const expanded = await repo.expandFromNodes([root.id], depth, scopes, projectId);

  // Cap the number of nodes handed to rendering so a broad hub can't dump an
  // unbounded node list on the caller. The root is always kept: if capping
  // the returned order would otherwise drop it, it's pulled to the front and
  // the cap is applied to the remainder (still preferring returned order).
  const nodeCap = input.max_nodes ?? TRAVERSE_NODE_CAP;
  let nodesForRender = expanded;
  let droppedCount = 0;
  if (expanded.length > nodeCap) {
    const rootIndex = expanded.findIndex((n) => n.id === root.id);
    nodesForRender =
      rootIndex >= nodeCap
        ? [expanded[rootIndex]!, ...expanded.slice(0, nodeCap - 1)]
        : expanded.slice(0, nodeCap);
    droppedCount = expanded.length - nodesForRender.length;
  }

  // Re-querying edges scoped to the surviving node ids (rather than filtering
  // the full-expansion edge list) is what keeps relations from referencing
  // nodes whose observations got dropped by the cap above.
  const nodeIds = nodesForRender.map((n) => n.id);
  const edges = nodeIds.length > 0 ? await repo.fetchVisibleEdges(nodeIds, projectId) : [];

  let text = renderTraverse(root.canonical, depth, nodesForRender, edges, root.id);
  if (droppedCount > 0) {
    text += `\n[+${droppedCount} more nodes — narrow the traversal or use memory_search]`;
  }
  return { text };
}
