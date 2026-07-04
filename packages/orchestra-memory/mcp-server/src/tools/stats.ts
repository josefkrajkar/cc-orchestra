// memory_stats — counts per scope/table, invalidated counts, DB size, and
// how many observations are stale (>90 days old). Used by SessionStart
// budget decisions and general health checks.
import { z } from 'zod';
import type { Repository } from '../db/repository.js';
import { renderStats } from '../render.js';
import { resolveProjectId, type ToolContext } from './context.js';

export const name = 'memory_stats';

export const description = `Report counts of nodes/observations/edges in the graph memory, by scope.

project_id defaults to this server instance's own project identity and includes your project's
"project"/"private" counts alongside the always-visible "global" counts; a different project's
id is rejected. Also reports how many observations are invalidated (soft-deleted) and how many
are older than 90 days (candidates for review), plus the on-disk database size in bytes. Useful
before a bulk memory_save to sanity-check growth, or to decide how aggressively a SessionStart
injection should be trimmed.`;

export const inputShape = {
  project_id: z.string().optional(),
};

const inputSchema = z.object(inputShape);
export type StatsInput = z.infer<typeof inputSchema>;

export interface StatsOutput {
  text: string;
}

export function handleStats(repo: Repository, input: StatsInput, ctx: ToolContext): StatsOutput {
  const resolved = resolveProjectId(ctx, input.project_id);
  if (!resolved.ok) {
    return { text: `Rejected: ${resolved.message}` };
  }
  const stats = repo.stats(resolved.projectId);
  return { text: renderStats(stats, resolved.projectId) };
}
