// memory_save — the sole write path for distilled facts. The calling LLM
// performs distillation; this tool validates the result server-side,
// canonicalizes entities, dedupes against existing observations, and writes
// nodes/observations/edges.
import { z } from 'zod';
import type { SqliteDatabase } from '../db/connection.js';
import type { Repository, Scope } from '../db/repository.js';
import { normalizeForDedupe, validateFact, type FactInput } from '../distill.js';
import {
  renderSaveResult,
  type FactOutcome,
  type RelationOutcome,
  type SaveSummary,
} from '../render.js';
import { privateDeniedMessage, resolveProjectId, type ToolContext } from './context.js';

export const name = 'memory_save';

export const description = `Persist distilled facts and relations into the cross-project graph memory.

YOU (the calling model) must distill BEFORE calling this tool — never pass raw conversation
text through unmodified:
- Each fact's "text" MUST be an atomic, self-contained proposition: a complete sentence that
  stands on its own without the surrounding conversation. NEVER use pronouns or references that
  only make sense in context ("it", "this", "the above", "he" meaning someone mentioned
  earlier) — always name the subject explicitly.
- One fact per array entry. If a sentence expresses two independent facts, split it into two
  entries.
- "entity.name" MUST be the canonical name of the real-world thing the fact is about (e.g.
  "Josef Krajkar", not "he"; "Orchestra plugin", not "this project" or "the repo"). Reuse the
  exact same canonical name every time you refer to the same entity so facts merge onto one
  graph node instead of fragmenting into near-duplicate entities.
- Use "relations" for structural triples between two entities: {src, predicate, dst}, e.g.
  {src: "Orchestra plugin", predicate: "uses", dst: "SQLite"}. Prefer a relation over prose when
  a triple captures the fact better.
- "scope" applies to the whole call and defaults to "project" when omitted. Use "global" only
  for facts true across ALL projects (e.g. a durable user preference). Use "private" for
  sensitive, client-specific facts that must NEVER leak into other projects. "project" and
  "private" scope both use project_id — omit it to write to your own project (this server
  instance's identity); passing a DIFFERENT project's id is rejected outright, so there is no
  way to write into another project's project/private scope through this tool.
- "category" (convention|gotcha|decision|failed_approach|preference|fact) helps downstream
  tools like wisdom_get group facts; set it when the fact fits one of those categories.
- To correct or update a fact that is no longer true, do NOT just save a new, unrelated
  observation next to the old one: first call memory_search (or memory_inspect) to find the old
  fact's "#<id>" (rendered as a prefix on every observation line), then save the replacement
  fact with that id in "supersedes_observation_id". This atomically marks the old observation
  invalidated+superseded (it stops appearing in memory_search/memory_traverse, though
  memory_inspect still shows the history) and links it to the new one. The old observation must
  exist, still be valid (not already invalidated/superseded), and be visible to your own project
  (global, or the same project_id as this save) — otherwise the fact is rejected rather than
  silently saved without the supersession.

Server-side validation rejects: facts with no entity name, empty/whitespace-only text, text over
500 characters (not atomic — split it into multiple facts), and an invalid/inaccessible
supersedes_observation_id. Before inserting, the server compares each fact's normalized text
against the target entity's existing valid observations; an exact-normalized match is reported
as a duplicate and skipped rather than re-inserted. The response reports a per-fact outcome
(saved [+ superseded #N] | duplicate | rejected: reason) plus summary counts and the IDs of
newly created observations — read it to confirm what was actually written.`;

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

interface SupersedeTarget {
  id: number;
  scope: Scope;
  projectId: string | null;
  invalidatedAt: string | null;
}

/** Repository gap: db/repository.ts exposes no "get observation by id"
 * method (only FTS search / graph expansion). Since repository.ts is
 * frozen, this queries the underlying SqliteDatabase directly, the same
 * direct-SQL pattern already used elsewhere (tools/search.ts's
 * fetchVisibleEdges, tools/inspect.ts, tools/wisdom-compat.ts). */
function fetchSupersedeTarget(db: SqliteDatabase, id: number): SupersedeTarget | undefined {
  return db
    .prepare(
      `SELECT id, scope, project_id as projectId, invalidated_at as invalidatedAt
       FROM observations WHERE id = ?`
    )
    .get(id) as SupersedeTarget | undefined;
}

/** Validates a memory_save fact's supersedes_observation_id against the
 * trust-boundary rules: the old observation must exist, still be valid (not
 * already invalidated/superseded), and be visible under the SERVER's own
 * project identity (global, or owned by this project) — never under a
 * caller-supplied project_id. Returns an error string on failure, or null
 * when the target is safe to supersede. */
function validateSupersedeTarget(
  db: SqliteDatabase,
  supersedesId: number,
  effectiveProjectId: string | null
): string | null {
  const target = fetchSupersedeTarget(db, supersedesId);
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

export function handleSave(
  repo: Repository,
  db: SqliteDatabase,
  input: SaveInput,
  ctx: ToolContext
): SaveOutput {
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
      const supersedeError = validateSupersedeTarget(db, fact.supersedes_observation_id, ctx.ownProjectId);
      if (supersedeError) {
        factOutcomes.push({ entity: fact.entity.name, status: 'rejected', reason: supersedeError });
        continue;
      }
      supersedesId = fact.supersedes_observation_id;
    }

    const nodeResult = repo.upsertNode({
      canonical: fact.entity.name,
      kind: fact.entity.kind || 'other',
      scope,
      projectId,
      projectLabel: input.project_label ?? null,
      aliases: fact.aliases,
    });

    const existingNode = repo.expandFromNodes([nodeResult.id], 0, [scope], projectId)[0];
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

    const observationId = repo.addObservation({
      nodeId: nodeResult.id,
      text: fact.text.trim(),
      scope,
      projectId,
      category: fact.category ?? null,
      confidence: fact.confidence ?? 'medium',
      source: input.source ?? null,
    });

    if (supersedesId != null) {
      repo.supersedeObservation(supersedesId, observationId);
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
    const srcNode = repo.upsertNode({
      canonical: relation.src,
      kind: 'other',
      scope,
      projectId,
      projectLabel: input.project_label ?? null,
    });
    const dstNode = repo.upsertNode({
      canonical: relation.dst,
      kind: 'other',
      scope,
      projectId,
      projectLabel: input.project_label ?? null,
    });
    const edge = repo.upsertEdge({
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
    rejected: factOutcomes.filter((f) => f.status === 'rejected').length,
    relations: relationOutcomes.length,
  };

  const text = renderSaveResult(summary, factOutcomes, relationOutcomes);
  return { text, summary, facts: factOutcomes, relations: relationOutcomes };
}
