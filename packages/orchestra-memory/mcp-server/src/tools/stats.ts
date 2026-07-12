// memory_stats — counts per scope/table, invalidated counts, DB size, and
// how many observations are stale (>90 days old). Used by SessionStart
// budget decisions and general health checks.
import { z } from 'zod';
import type { Repository } from '../db/repository.js';
import { renderStats } from '../render.js';
import { resolveProjectId, type ToolContext } from './context.js';
import { SCOPE_NOTE } from './descriptions.js';

export const name = 'memory_stats';

export const description = `Report counts of nodes/observations/edges in the graph memory, by scope.

${SCOPE_NOTE} Also reports invalidated (soft-deleted) counts, observations older than 90 days,
and on-disk database size — useful before a bulk memory_save or to size a SessionStart injection.`;

export const inputShape = {
  project_id: z.string().optional(),
};

const inputSchema = z.object(inputShape);
export type StatsInput = z.infer<typeof inputSchema>;

export interface StatsOutput {
  text: string;
}

export async function handleStats(repo: Repository, input: StatsInput, ctx: ToolContext): Promise<StatsOutput> {
  const resolved = resolveProjectId(ctx, input.project_id);
  if (!resolved.ok) {
    return { text: `Rejected: ${resolved.message}` };
  }
  const stats = await repo.stats(resolved.projectId);
  return { text: renderStats(stats, resolved.projectId) };
}
