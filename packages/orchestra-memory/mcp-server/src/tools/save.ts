// memory_save — the sole write path for distilled facts. The calling LLM
// performs distillation; this tool validates the result server-side,
// canonicalizes entities, dedupes against existing observations, and writes
// nodes/observations/edges.
import { z } from 'zod';
import { NEAR_DUP_RANK_THRESHOLD, type Repository, type Scope } from '../db/repository.js';
import { normalizeForDedupe, validateFact, type FactInput } from '../distill.js';
import {
  renderSaveResult,
  type FactOutcome,
  type RelationOutcome,
  type SaveSummary,
} from '../render.js';
import { privateDeniedMessage, resolveProjectId, type ToolContext } from './context.js';
import { DISTILL_NOTE, SCOPE_NOTE } from './descriptions.js';

export const name = 'memory_save';

export const description = `Persist distilled facts and relations into the cross-project graph memory.

Distill BEFORE calling — never pass raw text unmodified. ${DISTILL_NOTE} One fact per entry;
reuse the exact "entity.name" (e.g. "Josef Krajkar", not "he") every time so facts merge onto
one node. "relations" are structural triples ({src, predicate, dst}) — prefer one over prose.

${SCOPE_NOTE} "scope" defaults to "project". "category"
(convention|gotcha|decision|failed_approach|preference|fact) helps wisdom_get group results.

To correct an outdated fact, pass its "#<id>" as "supersedes_observation_id" — invalidates the
old observation and links it to the new one; the target must exist, be valid, and visible to
your project, else the save is rejected.

Also rejected: missing entity name, empty text. An exact-normalized duplicate is skipped, not
re-inserted. A high-similarity ("near-duplicate") fact is also skipped unless you pass
"allow_near_duplicate":true or supersede it instead. Response reports a per-fact outcome (saved
[+ superseded #N] | duplicate | near_duplicate | rejected: reason) and new ids.`;

const entityShape = z.object({
  name: z.string(),
  kind: z.string().optional(),
});

const factShape = z.object({
  entity: entityShape,
  text: z.string(),
  category: z.enum(['convention', 'gotcha', 'decision', 'failed_approach', 'preference', 'fact']).optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  aliases: z.array(z.string()).optional(),
  supersedes_observation_id: z.number().int().positive().optional(),
});

const relationShape = z.object({
  src: z.string().min(1),
  predicate: z.string().min(1),
  dst: z.string().min(1),
});

export const inputShape = {
  facts: z.array(factShape).default([]),
  relations: z.array(relationShape).optional(),
  scope: z.enum(['global', 'project', 'private']).optional(),
  project_id: z.string().optional(),
  project_label: z.string().optional(),
  source: z.string().optional(),
  // Bypasses the near-duplicate guard (see Repository.findNearDuplicate) for
  // every fact in this call — use when a high-similarity match is a false positive.
  allow_near_duplicate: z.boolean().optional(),
};

const inputSchema = z.object(inputShape);
export type SaveInput = z.infer<typeof inputSchema>;

export interface SaveOutput {
  text: string;
  summary: SaveSummary;
  facts: FactOutcome[];
  relations: RelationOutcome[];
  error?: string;
}

function rejectedResult(error: string): SaveOutput {
  return {
    text: `Rejected: ${error}`,
    summary: { saved: 0, duplicate: 0, rejected: 0, relations: 0 },
    facts: [],
    relations: [],
    error,
  };
}

// --- Near-duplicate guard (D8) -------------------------------------------
//
// The heuristic itself (anchor-word selection, BM25 rank threshold) now
// lives in repository.ts as Repository.findNearDuplicate() — see that
// method's doc comment for the full empirical calibration rationale. This
// file imports (and re-exports) the threshold constant so external
// importers of `NEAR_DUP_RANK_THRESHOLD` from `tools/save.js` keep working.
export { NEAR_DUP_RANK_THRESHOLD };

/** Validates a memory_save fact's supersedes_observation_id against the
 * trust-boundary rules: the old observation must exist, still be valid (not
 * already invalidated/superseded), and be visible under the SERVER's own
 * project identity (global, or owned by this project) — never under a
 * caller-supplied project_id. Returns an error string on failure, or null
 * when the target is safe to supersede. */
async function validateSupersedeTarget(
  repo: Repository,
  supersedesId: number,
  effectiveProjectId: string | null
): Promise<string | null> {
  const target = await repo.findSupersedeTarget(supersedesId);
  if (!target) {
    return `supersedes_observation_id ${supersedesId} does not exist`;
  }
  if (target.invalidatedAt) {
    return `supersedes_observation_id ${supersedesId} is already invalidated/superseded`;
  }
  const visible = target.scope === 'global' || target.projectId === effectiveProjectId;
  if (!visible) {
    return `supersedes_observation_id ${supersedesId} is not visible to this project`;
  }
  return null;
}

export async function handleSave(
  repo: Repository,
  input: SaveInput,
  ctx: ToolContext
): Promise<SaveOutput> {
  const scope: Scope = input.scope ?? 'project';

  let projectId: string | null;
  if (scope === 'global') {
    // Global facts are never bound to a project (schema: project_id NULL for
    // global). Ignore caller-supplied project_id entirely so an unvalidated
    // value can never flow into the ownership checks below.
    projectId = null;
  } else {
    if (scope === 'private' && ctx.ownProjectId == null) {
      return rejectedResult(privateDeniedMessage());
    }
    const resolved = resolveProjectId(ctx, input.project_id);
    if (!resolved.ok) {
      return rejectedResult(resolved.message);
    }
    projectId = resolved.projectId;
    if (!projectId) {
      return rejectedResult(
        `scope "${scope}" requires project_id to be set (project/private facts must be tied to a project).`
      );
    }
  }

  const factOutcomes: FactOutcome[] = [];
  for (const fact of input.facts ?? []) {
    const asFactInput: FactInput = fact;
    const validation = validateFact(asFactInput);
    if (!validation.ok) {
      factOutcomes.push({ entity: fact.entity?.name ?? '', status: 'rejected', reason: validation.reason });
      continue;
    }

    let supersedesId: number | undefined;
    if (fact.supersedes_observation_id != null) {
      // Ownership is always checked against the SERVER's own project identity,
      // never a caller-supplied project_id — a global-scope save must not be
      // able to supersede another project's facts (sentinel round-2 P0).
      const supersedeError = await validateSupersedeTarget(repo, fact.supersedes_observation_id, ctx.ownProjectId);
      if (supersedeError) {
        factOutcomes.push({ entity: fact.entity.name, status: 'rejected', reason: supersedeError });
        continue;
      }
      supersedesId = fact.supersedes_observation_id;
    }

    const nodeResult = await repo.upsertNode({
      canonical: fact.entity.name,
      kind: fact.entity.kind || 'other',
      scope,
      projectId,
      projectLabel: input.project_label ?? null,
      aliases: fact.aliases,
    });

    const existingNode = (await repo.expandFromNodes([nodeResult.id], 0, [scope], projectId))[0];
    const normalizedNewText = normalizeForDedupe(fact.text);
    const duplicate = existingNode?.observations.find(
      (obs) => normalizeForDedupe(obs.text) === normalizedNewText
    );
    if (duplicate) {
      factOutcomes.push({
        entity: fact.entity.name,
        status: 'duplicate',
        observationId: duplicate.id,
        nodeId: nodeResult.id,
      });
      continue;
    }

    // Near-duplicate guard: skipped entirely when supersedes_observation_id
    // is set (supersession is the intended, explicit dedup flow) or when the
    // caller opted in via allow_near_duplicate:true.
    if (supersedesId == null && input.allow_near_duplicate !== true) {
      const nearDup = await repo.findNearDuplicate(fact.text, scope, projectId);
      if (nearDup && nearDup.rank <= NEAR_DUP_RANK_THRESHOLD) {
        factOutcomes.push({
          entity: fact.entity.name,
          status: 'near_duplicate',
          observationId: nearDup.observationId,
          nodeId: nodeResult.id,
        });
        continue;
      }
    }

    const observationId = await repo.addObservation({
      nodeId: nodeResult.id,
      text: fact.text.trim(),
      scope,
      projectId,
      category: fact.category ?? null,
      confidence: fact.confidence ?? 'medium',
      source: input.source ?? null,
    });

    if (supersedesId != null) {
      await repo.supersedeObservation(supersedesId, observationId);
    }

    factOutcomes.push({
      entity: fact.entity.name,
      status: 'saved',
      observationId,
      nodeId: nodeResult.id,
      supersededId: supersedesId,
    });
  }

  const relationOutcomes: RelationOutcome[] = [];
  for (const relation of input.relations ?? []) {
    const srcNode = await repo.upsertNode({
      canonical: relation.src,
      kind: 'other',
      scope,
      projectId,
      projectLabel: input.project_label ?? null,
    });
    const dstNode = await repo.upsertNode({
      canonical: relation.dst,
      kind: 'other',
      scope,
      projectId,
      projectLabel: input.project_label ?? null,
    });
    const edge = await repo.upsertEdge({
      srcId: srcNode.id,
      predicate: relation.predicate,
      dstId: dstNode.id,
      scope,
      projectId,
    });
    relationOutcomes.push({
      src: relation.src,
      predicate: relation.predicate,
      dst: relation.dst,
      created: edge.created,
      edgeId: edge.id,
    });
  }

  const summary: SaveSummary = {
    saved: factOutcomes.filter((f) => f.status === 'saved').length,
    duplicate: factOutcomes.filter((f) => f.status === 'duplicate').length,
    nearDuplicate: factOutcomes.filter((f) => f.status === 'near_duplicate').length,
    rejected: factOutcomes.filter((f) => f.status === 'rejected').length,
    relations: relationOutcomes.length,
  };

  const text = renderSaveResult(summary, factOutcomes, relationOutcomes);
  return { text, summary, facts: factOutcomes, relations: relationOutcomes };
}
