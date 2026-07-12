// memory_link — create/reuse a directed relation triple between two entities.
import { z } from 'zod';
import type { Repository, Scope } from '../db/repository.js';
import { renderLinkResult, type RelationOutcome } from '../render.js';
import { privateDeniedMessage, resolveProjectId, type ToolContext } from './context.js';
import { SCOPE_NOTE } from './descriptions.js';

export const name = 'memory_link';

export const description = `Create (or confirm) a relation triple between two canonical entities.

Resolves/creates "src"/"dst" as nodes (same canonicalization as memory_save) and upserts a
directed edge "src -predicate-> dst"; idempotent on repeat. ${SCOPE_NOTE} "scope" defaults to
"project".`;

export const inputShape = {
  src: z.string().min(1, 'src must not be empty'),
  predicate: z.string().min(1, 'predicate must not be empty'),
  dst: z.string().min(1, 'dst must not be empty'),
  scope: z.enum(['global', 'project', 'private']).optional(),
  project_id: z.string().optional(),
};

const inputSchema = z.object(inputShape);
export type LinkInput = z.infer<typeof inputSchema>;

export interface LinkOutput {
  text: string;
  edge: RelationOutcome;
  error?: string;
}

function rejected(input: LinkInput, error: string): LinkOutput {
  return {
    text: `Rejected: ${error}`,
    edge: { src: input.src, predicate: input.predicate, dst: input.dst, created: false, edgeId: -1 },
    error,
  };
}

export async function handleLink(repo: Repository, input: LinkInput, ctx: ToolContext): Promise<LinkOutput> {
  const scope: Scope = input.scope ?? 'project';

  let projectId: string | null;
  if (scope === 'global') {
    // Global edges are never bound to a project (schema: project_id NULL for
    // global); ignore caller-supplied project_id — same rule as memory_save.
    projectId = null;
  } else {
    if (scope === 'private' && ctx.ownProjectId == null) {
      return rejected(input, privateDeniedMessage());
    }
    const resolved = resolveProjectId(ctx, input.project_id);
    if (!resolved.ok) {
      return rejected(input, resolved.message);
    }
    projectId = resolved.projectId;
    if (!projectId) {
      return rejected(
        input,
        `scope "${scope}" requires project_id to be set (project/private edges must be tied to a project).`
      );
    }
  }

  const srcNode = await repo.upsertNode({ canonical: input.src, kind: 'other', scope, projectId });
  const dstNode = await repo.upsertNode({ canonical: input.dst, kind: 'other', scope, projectId });
  const result = await repo.upsertEdge({
    srcId: srcNode.id,
    predicate: input.predicate,
    dstId: dstNode.id,
    scope,
    projectId,
  });

  const edge: RelationOutcome = {
    src: input.src,
    predicate: input.predicate,
    dst: input.dst,
    created: result.created,
    edgeId: result.id,
  };

  return { text: renderLinkResult(edge), edge };
}
