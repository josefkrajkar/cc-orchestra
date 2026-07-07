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
  // Bypasses the near-duplicate guard (see findNearDuplicate below) for every
  // fact in this call — use when a high-similarity match is a false positive.
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
// SQLite FTS5's default MATCH semantics AND every whitespace-delimited term
// together (see db/repository.ts's sanitizeFtsQuery, which quotes each
// token as its own phrase — bare quoted phrases are implicitly AND-ed).
// That means calling repo.searchObservations() with a fact's full raw text
// as the query requires a candidate to contain literally *every* word of
// that text. Empirically (scratch experiment against two real-world
// duplicate pairs pulled from this project's own memory — a
// project_id/sha256 formula note and a process.exit()/vitest-mock note) a
// literal full-text query returns zero candidates for either pair, in
// either direction: real paraphrases never share 100% of their vocabulary.
//
// To make the guard actually useful without touching the frozen
// repository, the query fed to searchObservations is built from a handful
// of the fact's "anchor" words instead of its full text: significant
// (non-stopword, length >= MIN_TOKEN_LEN) words that already occur in at
// least one existing valid/visible observation, preferring the rarest
// ones. AND-ing just those few — relaxing down to fewer anchors if the
// full set doesn't co-occur in a single candidate — reliably surfaces
// same-topic restatements while still requiring several specific words to
// coincide, which keeps unrelated facts from colliding by chance.
const MIN_TOKEN_LEN = 4;
const CANDIDATE_WORD_CAP = 20;
const MIN_ANCHOR_WORDS = 3;
const MAX_ANCHOR_WORDS = 6;
const ANCHOR_DF_SEARCH_LIMIT = 50;

/**
 * BM25 rank threshold (SQLite returns bm25() as a "rank": negative, lower
 * is a stronger match). Empirical basis — anchor-word AND-queries (as
 * described above) against the two mandated real-world duplicate pairs:
 *   - "project_id = sha256(path+trailing newline) truncated to 16 hex"
 *     note vs its restatement: rank -6.18 one direction, -3.73 the other.
 *   - "process.exit()/vitest mock, don't remove the return" note vs its
 *     restatement: rank -4.20 (one direction only — the other direction's
 *     anchor set didn't converge on the same candidate, which is the
 *     accepted miss for this more heavily paraphrased pair).
 *   - Two additional constructed near-dup pairs (SQLite/FTS5 restatement,
 *     REST->GraphQL migration restatement) scored -11.8 to -12.1.
 *   - Every coincidental-overlap control tried (facts sharing 2-3 generic
 *     words by chance, e.g. two unrelated "TypeScript ... project ...
 *     testing" sentences) never even reached this rank check — the anchor
 *     selection above already rejected it for having too few candidates
 *     that share a common document.
 * -3.5 sits just above (less strict than) the weakest true positive
 * observed (-3.73), so ordinary corpus-composition variance in a real
 * graph.db doesn't flip that case into a miss, while remaining far
 * stricter than a typical single/double-anchor incidental score.
 *
 * Corpus-size caveat: BM25's IDF term is a function of how many documents
 * in the corpus contain each word, so its magnitude shrinks toward zero as
 * the corpus shrinks — with exactly one prior observation to compare
 * against, even a perfect anchor match scores roughly -0.000006, nowhere
 * near this threshold. All the empirical numbers above (and this guard's
 * behavior generally) assume a corpus with some pre-existing topical
 * diversity, which is the realistic case once a project has accumulated
 * more than a couple of facts. In a brand-new/near-empty project this
 * guard is correspondingly weaker — an acceptable false negative under the
 * fail-open philosophy, not a correctness bug.
 */
export const NEAR_DUP_RANK_THRESHOLD = -3.5;

// A deliberately small, generic English stopword list — just enough to keep
// filler/connective words out of the anchor pool. Not exhaustive; false
// negatives here only make the guard slightly less effective, never unsafe.
const STOPWORDS = new Set(
  `a an the and or but if then else for nor so yet
   of to in on at by with from into onto up down out over under again further
   is are was were be been being have has had do does did doing will would
   shall should may might must can could this that these those it its
   as not no never always about above below between through during before
   after once here there when where why how all any both each few more most
   other some such only own same than too very just also across still
   i you he she we they them his her our your their what which who whom
   because while against without within per via etc used use uses using`
    .split(/\s+/)
    .filter(Boolean)
);

/** Extracts unique, lowercased, stopword/short-word-filtered tokens from
 * free text, in first-seen order, capped at CANDIDATE_WORD_CAP to bound the
 * document-frequency lookups below. */
function significantWords(text: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const match of text.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const word = match[0];
    if (word.length < MIN_TOKEN_LEN || STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    words.push(word);
    if (words.length >= CANDIDATE_WORD_CAP) break;
  }
  return words;
}

interface NearDupMatch {
  observationId: number;
  rank: number;
}

/**
 * Looks for an existing near-duplicate of `text` among valid (not
 * invalidated), caller-visible observations in `scope`/`projectId` —
 * visibility and validity are enforced by repo.searchObservations() itself
 * (its scopeGuard/scopeAllowlist and default `includeInvalidated: false`),
 * never re-implemented here. This is a best-effort heuristic, not a
 * security boundary: it fails open on any error (including a pathological
 * MATCH failure on unusual fact text) by returning null, so a previously-
 * valid save can never be blocked by this check misbehaving.
 */
function findNearDuplicate(
  repo: Repository,
  text: string,
  scope: Scope,
  projectId: string | null
): NearDupMatch | null {
  try {
    const words = significantWords(text);
    if (words.length < MIN_ANCHOR_WORDS) return null;

    const scored = words.map((word, index) => ({
      word,
      index,
      // Document-frequency proxy: how many existing valid/visible
      // observations already contain this word. A word with df=0 can never
      // contribute to a match and is dropped before ranking.
      df: repo.searchObservations({ query: word, scopes: [scope], projectId, limit: ANCHOR_DF_SEARCH_LIMIT })
        .length,
    }));
    const candidates = scored.filter((c) => c.df > 0);
    if (candidates.length < MIN_ANCHOR_WORDS) return null;

    // Rarest (lowest df) words first; longer words as a specificity
    // tiebreak; original position as a final stable tiebreak.
    candidates.sort((a, b) => a.df - b.df || b.word.length - a.word.length || a.index - b.index);
    const pool = candidates.slice(0, MAX_ANCHOR_WORDS).map((c) => c.word);

    // The full anchor pool may not all co-occur in one candidate (an anchor
    // can have df>0 only because it matches a *different*, unrelated
    // observation) — relax by shrinking from the least-confident end until
    // a match is found or the floor (MIN_ANCHOR_WORDS) is hit.
    for (let size = pool.length; size >= MIN_ANCHOR_WORDS; size--) {
      const query = pool.slice(0, size).join(' ');
      const rows = repo.searchObservations({ query, scopes: [scope], projectId, limit: 5 });
      const best = rows[0];
      if (best) {
        return { observationId: best.observationId, rank: best.rank };
      }
    }
    return null;
  } catch {
    // Fail open — see function doc comment.
    return null;
  }
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

    // Near-duplicate guard: skipped entirely when supersedes_observation_id
    // is set (supersession is the intended, explicit dedup flow) or when the
    // caller opted in via allow_near_duplicate:true.
    if (supersedesId == null && input.allow_near_duplicate !== true) {
      const nearDup = findNearDuplicate(repo, fact.text, scope, projectId);
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
    nearDuplicate: factOutcomes.filter((f) => f.status === 'near_duplicate').length,
    rejected: factOutcomes.filter((f) => f.status === 'rejected').length,
    relations: relationOutcomes.length,
  };

  const text = renderSaveResult(summary, factOutcomes, relationOutcomes);
  return { text, summary, facts: factOutcomes, relations: relationOutcomes };
}
