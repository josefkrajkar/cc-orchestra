// memory_invalidate — soft delete (default) or hard delete of observations,
// either by id or for every valid observation of a named entity.
import { z } from 'zod';
import type { Repository } from '../db/repository.js';
import { resolveProjectId, type ToolContext } from './context.js';
import { resolveEntityNode } from './traverse.js';
import { SCOPE_NOTE } from './descriptions.js';

export const name = 'memory_invalidate';

export const description = `Retire facts that are no longer true, soft-deleting by default.

Pass exactly one of: "observation_id" (a single #id from earlier results; another project's
observation is rejected, global is always eligible) or "entity" (every valid observation of that
entity, resolved by canonical name or alias). ${SCOPE_NOTE}

Soft delete (default) sets invalidated_at — search/traverse stop surfacing the fact, but
memory_inspect keeps the history. Pass hard:true only for genuine irreversible deletes (data
entered in error); prefer soft to preserve the audit trail. "reason" is echoed for traceability.`;

export const inputShape = {
  observation_id: z.number().int().positive().optional(),
  entity: z.string().optional(),
  reason: z.string().optional(),
  hard: z.boolean().optional(),
  project_id: z.string().optional(),
};

const inputSchema = z.object(inputShape);
export type InvalidateInput = z.infer<typeof inputSchema>;

export interface InvalidateOutput {
  text: string;
  invalidatedIds: number[];
  error?: string;
}

export async function handleInvalidate(
  repo: Repository,
  input: InvalidateInput,
  ctx: ToolContext
): Promise<InvalidateOutput> {
  const hard = input.hard ?? false;
  const reasonSuffix = input.reason ? ` (${input.reason})` : '';

  if (input.observation_id == null && !input.entity) {
    const error = 'either observation_id or entity must be provided';
    return { text: `Rejected: ${error}.`, invalidatedIds: [], error };
  }

  const resolved = resolveProjectId(ctx, input.project_id);
  if (!resolved.ok) {
    return { text: `Rejected: ${resolved.message}`, invalidatedIds: [], error: resolved.message };
  }
  const projectId = resolved.projectId;

  if (input.observation_id != null) {
    // Unguarded fetch-by-id (same repository.ts method save.ts's supersede-target
    // check uses) — the visibility decision is made here, explicitly, against the
    // caller's resolved project_id, exactly as before.
    const target = await repo.findSupersedeTarget(input.observation_id);
    if (!target) {
      const error = `observation #${input.observation_id} not found`;
      return { text: `Rejected: ${error}.`, invalidatedIds: [], error };
    }
    const visible = target.scope === 'global' || target.projectId === projectId;
    if (!visible) {
      const error =
        `project_id mismatch: observation #${input.observation_id} belongs to a different project; ` +
        `cross-project invalidation is not permitted`;
      return { text: `Rejected: ${error}.`, invalidatedIds: [], error };
    }
    await repo.invalidateObservation(input.observation_id, hard);
    return {
      text: `${hard ? 'Hard-deleted' : 'Invalidated'} observation #${input.observation_id}${reasonSuffix}.`,
      invalidatedIds: [input.observation_id],
    };
  }

  const entity = input.entity!;
  const node = await resolveEntityNode(repo, entity, projectId);
  if (!node) {
    return { text: `No entity found matching "${entity}".`, invalidatedIds: [], error: 'entity not found' };
  }

  const expanded = (await repo.expandFromNodes([node.id], 0, [node.scope], projectId))[0];
  const validObservationIds = expanded?.observations.map((o) => o.id) ?? [];
  for (const id of validObservationIds) {
    await repo.invalidateObservation(id, hard);
  }

  return {
    text: `${hard ? 'Hard-deleted' : 'Invalidated'} ${validObservationIds.length} observation(s) for "${node.canonical}"${reasonSuffix}.`,
    invalidatedIds: validObservationIds,
  };
}
