// memory_inspect — the only human-readable (markdown) output in the system.
// A debug/trust escape hatch: shows full metadata (confidence, valid_from,
// invalidated_at, superseded_by, source, project_label) that the
// token-dense renders used by memory_search/memory_traverse deliberately
// omit.
//
// Node/observation listing (including invalidated/superseded rows, which
// expandFromNodes deliberately excludes) is delegated to repository.ts's
// listNodes()/listObservationsForNode(), which apply the shared scope guard.
import { z } from 'zod';
import type { Repository, Scope } from '../db/repository.js';
import { renderInspect, type InspectNodeRow } from '../render.js';
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

export interface InspectOutput {
  text: string;
}

export async function handleInspect(
  repo: Repository,
  input: InspectInput,
  ctx: ToolContext
): Promise<InspectOutput> {
  const scopes = input.scope_filter as Scope[] | undefined;
  if (isPrivateDenied(ctx, scopes)) {
    return { text: `Rejected: ${privateDeniedMessage()}` };
  }
  const resolved = resolveProjectId(ctx, input.project_id);
  if (!resolved.ok) {
    return { text: `Rejected: ${resolved.message}` };
  }
  const projectId = resolved.projectId;

  const nodes = await repo.listNodes(scopes, projectId, input.entity);
  const rows: InspectNodeRow[] = [];
  for (const n of nodes) {
    rows.push({ ...n, observations: await repo.listObservationsForNode(n.id, projectId) });
  }

  return { text: renderInspect(rows) };
}
