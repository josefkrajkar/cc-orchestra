// Typed repository over the graph memory SQLite schema (see schema.sql).
//
// Security-critical invariant enforced everywhere data is *read*: a row is
// only visible if `scope = 'global'` OR (`scope IN ('project','private')`
// AND `project_id` matches the caller's current project). This is the only
// thing standing between a private fact from client A and a session running
// against client B — every read helper in this file goes through
// scopeGuard()/scopeAllowlist() to apply it consistently.
//
// Per docs/design/remote-memory-plan.md Phase 0: the methods below
// (fetchVisibleEdges, findSupersedeTarget, findNearDuplicate, listNodes,
// listObservationsForNode, listWisdomRows, injectObservations,
// highConfidenceObservations, entityRoster) were added to consolidate
// direct-`db.prepare()` bypasses that used to live in tools/search.ts,
// tools/save.ts, tools/inspect.ts, tools/wisdom-compat.ts, and inject.ts, so
// a future remote-RPC backend has exactly one data boundary to mirror.
// repository.ts is no longer "frozen" — new read methods are welcome here as
// long as they route every visibility check through scopeGuard()/
// scopeAllowlist() (or, per findSupersedeTarget's doc comment, deliberately
// document why a given read is intentionally unguarded). Some tool-file
// comments elsewhere still say "repository.ts is frozen"; those are stale
// and will be cleaned up by the tasks that rewrite those specific files next.
import { statSync } from 'node:fs';
import type { SqliteDatabase } from './connection.js';

/** The subset of SQL parameter/result value types this repository deals in. */
type SqlParam = string | number | bigint | null;

export type Scope = 'global' | 'project' | 'private';
export type Confidence = 'high' | 'medium' | 'low';

export interface UpsertNodeInput {
  canonical: string;
  kind: string;
  scope: Scope;
  projectId?: string | null;
  projectLabel?: string | null;
  aliases?: string[];
}

export interface UpsertNodeResult {
  id: number;
  created: boolean;
}

export interface SimilarNode {
  id: number;
  canonical: string;
  kind: string;
  scope: Scope;
  projectId: string | null;
}

export interface AddObservationInput {
  nodeId: number;
  text: string;
  scope: Scope;
  projectId?: string | null;
  category?: string | null;
  confidence?: Confidence;
  source?: string | null;
  validFrom?: string;
}

export interface UpsertEdgeInput {
  srcId: number;
  predicate: string;
  dstId: number;
  scope: Scope;
  projectId?: string | null;
  confidence?: Confidence;
  validFrom?: string;
}

export interface UpsertEdgeResult {
  id: number;
  created: boolean;
}

export interface SearchObservationsInput {
  query: string;
  scopes?: Scope[];
  projectId?: string | null;
  limit?: number;
  includeInvalidated?: boolean;
}

export interface SearchResultRow {
  observationId: number;
  nodeId: number;
  canonical: string;
  text: string;
  scope: Scope;
  projectId: string | null;
  category: string | null;
  confidence: Confidence;
  validFrom: string;
  invalidatedAt: string | null;
  supersededBy: number | null;
  rank: number;
}

export interface ExpandedObservation {
  id: number;
  text: string;
  category: string | null;
  confidence: Confidence;
  validFrom: string;
}

export interface ExpandedNode {
  id: number;
  canonical: string;
  kind: string;
  scope: Scope;
  projectId: string | null;
  observations: ExpandedObservation[];
}

export interface StatsResult {
  nodes: { total: number; byScope: Record<Scope, number> };
  observations: {
    total: number;
    byScope: Record<Scope, number>;
    invalidated: number;
    olderThan90Days: number;
  };
  edges: { total: number; byScope: Record<Scope, number>; invalidated: number };
  dbSizeBytes: number | null;
}

/** A graph edge resolved for display as a `src -predicate-> dst` triple.
 * Structurally identical to render.ts's RenderableEdge — kept as a separate
 * type here since repository.ts must not import from render.ts. */
export interface EdgeRow {
  srcCanonical: string;
  predicate: string;
  dstCanonical: string;
}

/** Raw, unguarded fetch-by-id result for supersede-target validation. See
 * findSupersedeTarget()'s doc comment for why this is deliberately NOT
 * scope-filtered at the SQL level. */
export interface SupersedeTargetRow {
  id: number;
  scope: Scope;
  projectId: string | null;
  invalidatedAt: string | null;
}

export interface NearDupMatch {
  observationId: number;
  rank: number;
}

export interface RawNodeRow {
  id: number;
  canonical: string;
  kind: string;
  scope: Scope;
  projectId: string | null;
  projectLabel: string | null;
}

export interface InspectObservationRow {
  id: number;
  text: string;
  category: string | null;
  confidence: Confidence;
  source: string | null;
  validFrom: string;
  invalidatedAt: string | null;
  supersededBy: number | null;
}

export interface WisdomRow {
  category: string;
  text: string;
  confidence: Confidence;
  validFrom: string;
}

export interface ListWisdomResult {
  rows: WisdomRow[];
  total: number;
}

export interface InjectObservationRow {
  id: number;
  canonical: string;
  text: string;
  scope: Scope;
  category: string | null;
  confidence: Confidence;
  validFrom: string;
}

export interface EntityRosterRow {
  canonical: string;
  count: number;
}

/** Minimal scope/project ownership info for a node or edge, resolved by id.
 * Deliberately unguarded — same rationale as SupersedeTargetRow /
 * findSupersedeTarget() above: the caller makes its OWN visibility decision
 * against a trusted identity (never a caller-supplied project_id). Used by
 * src/serve.ts's P0 ownership enforcement (see docs/design/remote-memory-plan.md
 * section 2) for the id-based Repository methods that take no project_id of
 * their own (addAlias, invalidateEdge, supersedeEdge). */
export interface OwnerRow {
  id: number;
  scope: Scope;
  projectId: string | null;
}

export interface Repository {
  upsertNode(input: UpsertNodeInput): Promise<UpsertNodeResult>;
  addAlias(nodeId: number, alias: string): Promise<void>;
  findSimilarNodes(
    name: string,
    scope: Scope,
    projectId?: string | null,
    limit?: number
  ): Promise<SimilarNode[]>;
  addObservation(input: AddObservationInput): Promise<number>;
  supersedeObservation(oldId: number, newId: number): Promise<void>;
  invalidateObservation(id: number, hard?: boolean): Promise<void>;
  upsertEdge(input: UpsertEdgeInput): Promise<UpsertEdgeResult>;
  invalidateEdge(id: number): Promise<void>;
  supersedeEdge(oldId: number, newId: number): Promise<void>;
  searchObservations(input: SearchObservationsInput): Promise<SearchResultRow[]>;
  expandFromNodes(
    nodeIds: number[],
    depth: number,
    scopes?: Scope[],
    projectId?: string | null
  ): Promise<ExpandedNode[]>;
  stats(projectId?: string | null): Promise<StatsResult>;
  fetchVisibleEdges(nodeIds: number[], projectId: string | null): Promise<EdgeRow[]>;
  findSupersedeTarget(id: number): Promise<SupersedeTargetRow | undefined>;
  findNearDuplicate(text: string, scope: Scope, projectId: string | null): Promise<NearDupMatch | null>;
  listNodes(
    scopes: Scope[] | undefined,
    projectId: string | null,
    entityFilter: string | undefined,
    limit?: number
  ): Promise<RawNodeRow[]>;
  listObservationsForNode(nodeId: number, projectId: string | null): Promise<InspectObservationRow[]>;
  listWisdomRows(categories: string[], projectId: string | null, limit: number): Promise<ListWisdomResult>;
  injectObservations(scope: Scope, projectId: string | null, limit: number): Promise<InjectObservationRow[]>;
  highConfidenceObservations(scope: Scope, projectId: string | null, limit: number): Promise<InjectObservationRow[]>;
  entityRoster(projectId: string | null): Promise<EntityRosterRow[]>;
}

/**
 * Repository, plus a couple of internal-only ownership lookups (see OwnerRow)
 * that src/serve.ts needs to enforce the P0 fix but that must NOT become part
 * of the remote wire protocol: remote/protocol.ts derives `MethodName` from
 * `Repository` (not this type) and METHOD_NAMES/isValidMethodName are the
 * dispatcher's allowlist, so a method missing from that list is simply
 * unreachable over `/rpc` — exactly what we want for these, since exposing
 * them to a remote caller directly would recreate the same
 * scope/project-id-oracle problem the P0 fix closes for findSupersedeTarget.
 * serve.ts calls these directly on its local Repository instance (never
 * through the generic `repo[method](...params)` dispatch), and
 * RemoteRepository (the client) has no reason to implement them.
 */
export interface RepositoryInternal extends Repository {
  findNodeOwner(nodeId: number): Promise<OwnerRow | undefined>;
  findEdgeOwner(edgeId: number): Promise<OwnerRow | undefined>;
}

/** lowercase + trim + collapse internal whitespace, per canonicalization spec */
function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Escapes user input for use inside an FTS5 MATCH expression by wrapping
 * every token as a quoted phrase literal. This neutralizes FTS5 query
 * syntax (NOT/AND/OR, `*`, `-`, `:`, unbalanced parens, etc.) so arbitrary
 * user text can never throw a MATCH syntax error or hijack the query.
 * Bare quoted tokens are implicitly AND-ed by FTS5.
 */
function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .normalize('NFKC')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | undefined)?.code;
  return (
    /UNIQUE constraint failed/i.test(msg) ||
    code === 'ERR_SQLITE_CONSTRAINT' ||
    code === 'SQLITE_CONSTRAINT'
  );
}

interface Clause {
  sql: string;
  params: SqlParam[];
}

/**
 * Mandatory security filter: global rows are always visible; project/private
 * rows are visible only when their project_id matches the caller's current
 * project. This must be ANDed into every read query touching nodes,
 * observations, or edges.
 */
function scopeGuard(alias: string, projectId: string | null): Clause {
  return {
    sql: `(${alias}.scope = 'global' OR (${alias}.scope IN ('project','private') AND ${alias}.project_id = ?))`,
    params: [projectId],
  };
}

/** Optional caller-provided narrowing (e.g. "only global"), layered on top of scopeGuard. */
function scopeAllowlist(alias: string, scopes: Scope[] | undefined): Clause {
  if (!scopes || scopes.length === 0) {
    return { sql: '1=1', params: [] };
  }
  const placeholders = scopes.map(() => '?').join(',');
  return { sql: `${alias}.scope IN (${placeholders})`, params: [...scopes] };
}

const EMPTY_SCOPE_COUNTS = (): Record<Scope, number> => ({ global: 0, project: 0, private: 0 });

// --- Near-duplicate guard heuristic (ported from tools/save.ts's D8) ------
//
// SQLite FTS5's default MATCH semantics AND every whitespace-delimited term
// together (see sanitizeFtsQuery() above, which quotes each token as its own
// phrase — bare quoted phrases are implicitly AND-ed). That means calling
// searchObservations() with a fact's full raw text as the query requires a
// candidate to contain literally *every* word of that text. Empirically
// (scratch experiment against two real-world duplicate pairs pulled from
// this project's own memory — a project_id/sha256 formula note and a
// process.exit()/vitest-mock note) a literal full-text query returns zero
// candidates for either pair, in either direction: real paraphrases never
// share 100% of their vocabulary.
//
// To make the guard actually useful, the query fed to searchObservations is
// built from a handful of the fact's "anchor" words instead of its full
// text: significant (non-stopword, length >= MIN_TOKEN_LEN) words that
// already occur in at least one existing valid/visible observation,
// preferring the rarest ones. AND-ing just those few — relaxing down to
// fewer anchors if the full set doesn't co-occur in a single candidate —
// reliably surfaces same-topic restatements while still requiring several
// specific words to coincide, which keeps unrelated facts from colliding by
// chance.
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

export function createRepository(db: SqliteDatabase, opts: { dbPath?: string } = {}): RepositoryInternal {
  async function addAlias(nodeId: number, alias: string): Promise<void> {
    const normalized = normalize(alias);
    if (!normalized) return;
    const exists = db
      .prepare('SELECT id FROM node_aliases WHERE node_id = ? AND alias = ?')
      .get(nodeId, normalized);
    if (exists) return;
    db.prepare('INSERT INTO node_aliases (node_id, alias) VALUES (?, ?)').run(nodeId, normalized);
  }

  function touchNode(nodeId: number): void {
    db.prepare('UPDATE nodes SET updated_at = ? WHERE id = ?').run(nowIso(), nodeId);
  }

  async function upsertNode(input: UpsertNodeInput): Promise<UpsertNodeResult> {
    const canonical = normalize(input.canonical);
    const projectId = input.projectId ?? null;

    const byCanonical = db
      .prepare(
        `SELECT id FROM nodes WHERE canonical = ? AND scope = ? AND COALESCE(project_id,'') = COALESCE(?, '')`
      )
      .get(canonical, input.scope, projectId) as { id: number } | undefined;

    if (byCanonical) {
      for (const alias of input.aliases ?? []) await addAlias(byCanonical.id, alias);
      touchNode(byCanonical.id);
      return { id: byCanonical.id, created: false };
    }

    const byAlias = db
      .prepare(
        `SELECT n.id as id FROM node_aliases a
         JOIN nodes n ON n.id = a.node_id
         WHERE a.alias = ? AND n.scope = ? AND COALESCE(n.project_id,'') = COALESCE(?, '')
         LIMIT 1`
      )
      .get(canonical, input.scope, projectId) as { id: number } | undefined;

    if (byAlias) {
      for (const alias of input.aliases ?? []) await addAlias(byAlias.id, alias);
      touchNode(byAlias.id);
      return { id: byAlias.id, created: false };
    }

    const ts = nowIso();
    const info = db
      .prepare(
        `INSERT INTO nodes (canonical, kind, scope, project_id, project_label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(canonical, input.kind, input.scope, projectId, input.projectLabel ?? null, ts, ts);
    const id = Number(info.lastInsertRowid);
    for (const alias of input.aliases ?? []) await addAlias(id, alias);
    return { id, created: true };
  }

  async function findSimilarNodes(
    name: string,
    scope: Scope,
    projectId: string | null = null,
    limit = 10
  ): Promise<SimilarNode[]> {
    const normalized = normalize(name);
    if (!normalized) return [];
    const likePattern = `%${normalized.replace(/[%_]/g, '\\$&')}%`;
    return db
      .prepare(
        `SELECT DISTINCT n.id as id, n.canonical as canonical, n.kind as kind, n.scope as scope,
                n.project_id as projectId
         FROM nodes n
         LEFT JOIN node_aliases a ON a.node_id = n.id
         WHERE n.scope = ? AND COALESCE(n.project_id,'') = COALESCE(?, '')
           AND (n.canonical LIKE ? ESCAPE '\\' OR a.alias LIKE ? ESCAPE '\\')
         LIMIT ?`
      )
      .all(scope, projectId, likePattern, likePattern, limit) as unknown as SimilarNode[];
  }

  async function addObservation(input: AddObservationInput): Promise<number> {
    const ts = nowIso();
    const validFrom = input.validFrom ?? ts;
    const info = db
      .prepare(
        `INSERT INTO observations
           (node_id, text, scope, project_id, category, confidence, source, valid_from, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.nodeId,
        input.text,
        input.scope,
        input.projectId ?? null,
        input.category ?? null,
        input.confidence ?? 'medium',
        input.source ?? null,
        validFrom,
        ts
      );
    return Number(info.lastInsertRowid);
  }

  async function supersedeObservation(oldId: number, newId: number): Promise<void> {
    db.prepare('UPDATE observations SET invalidated_at = ?, superseded_by = ? WHERE id = ?').run(
      nowIso(),
      newId,
      oldId
    );
  }

  async function invalidateObservation(id: number, hard = false): Promise<void> {
    if (hard) {
      db.prepare('DELETE FROM observations WHERE id = ?').run(id);
    } else {
      db.prepare('UPDATE observations SET invalidated_at = ? WHERE id = ?').run(nowIso(), id);
    }
  }

  async function upsertEdge(input: UpsertEdgeInput): Promise<UpsertEdgeResult> {
    const projectId = input.projectId ?? null;
    const ts = nowIso();
    const validFrom = input.validFrom ?? ts;
    try {
      const info = db
        .prepare(
          `INSERT INTO edges (src_id, predicate, dst_id, scope, project_id, confidence, valid_from, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.srcId,
          input.predicate,
          input.dstId,
          input.scope,
          projectId,
          input.confidence ?? 'medium',
          validFrom,
          ts
        );
      return { id: Number(info.lastInsertRowid), created: true };
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      // Idempotent upsert: the partial unique index on the live triple
      // rejected the insert, so a matching valid edge already exists.
      const existing = db
        .prepare(
          `SELECT id FROM edges
           WHERE src_id = ? AND predicate = ? AND dst_id = ? AND scope = ?
             AND COALESCE(project_id,'') = COALESCE(?, '') AND invalidated_at IS NULL`
        )
        .get(input.srcId, input.predicate, input.dstId, input.scope, projectId) as
        | { id: number }
        | undefined;
      if (!existing) throw err;
      return { id: existing.id, created: false };
    }
  }

  async function invalidateEdge(id: number): Promise<void> {
    db.prepare('UPDATE edges SET invalidated_at = ? WHERE id = ?').run(nowIso(), id);
  }

  async function supersedeEdge(oldId: number, newId: number): Promise<void> {
    db.prepare('UPDATE edges SET invalidated_at = ?, superseded_by = ? WHERE id = ?').run(
      nowIso(),
      newId,
      oldId
    );
  }

  async function searchObservations(input: SearchObservationsInput): Promise<SearchResultRow[]> {
    const sanitized = sanitizeFtsQuery(input.query);
    if (!sanitized) return [];
    const limit = input.limit ?? 20;
    const projectId = input.projectId ?? null;

    const guard = scopeGuard('o', projectId);
    const allow = scopeAllowlist('o', input.scopes);
    const invalidatedClause = input.includeInvalidated ? '1=1' : 'o.invalidated_at IS NULL';

    const sql = `
      SELECT o.id as observationId, o.node_id as nodeId, n.canonical as canonical, o.text as text,
             o.scope as scope, o.project_id as projectId, o.category as category,
             o.confidence as confidence, o.valid_from as validFrom, o.invalidated_at as invalidatedAt,
             o.superseded_by as supersededBy, bm25(observations_fts) as rank
      FROM observations_fts
      JOIN observations o ON o.id = observations_fts.rowid
      JOIN nodes n ON n.id = o.node_id
      WHERE observations_fts MATCH ?
        AND ${guard.sql}
        AND ${allow.sql}
        AND ${invalidatedClause}
      ORDER BY rank ASC
      LIMIT ?
    `;
    const params: SqlParam[] = [sanitized, ...guard.params, ...allow.params, limit];
    return db.prepare(sql).all(...params) as unknown as SearchResultRow[];
  }

  async function expandFromNodes(
    nodeIds: number[],
    depth: number,
    scopes?: Scope[],
    projectId: string | null = null
  ): Promise<ExpandedNode[]> {
    const visited = new Set<number>(nodeIds);
    let frontier = new Set<number>(nodeIds);

    const edgeGuard = scopeGuard('e', projectId);
    const edgeAllow = scopeAllowlist('e', scopes);

    for (let d = 0; d < depth && frontier.size > 0; d++) {
      const frontierArr = [...frontier];
      const placeholders = frontierArr.map(() => '?').join(',');
      const sql = `
        SELECT src_id as srcId, dst_id as dstId FROM edges e
        WHERE e.invalidated_at IS NULL
          AND ${edgeGuard.sql}
          AND ${edgeAllow.sql}
          AND (e.src_id IN (${placeholders}) OR e.dst_id IN (${placeholders}))
      `;
      const params: SqlParam[] = [...edgeGuard.params, ...edgeAllow.params, ...frontierArr, ...frontierArr];
      const rows = db.prepare(sql).all(...params) as unknown as Array<{ srcId: number; dstId: number }>;
      const next = new Set<number>();
      for (const row of rows) {
        if (!visited.has(row.srcId)) next.add(row.srcId);
        if (!visited.has(row.dstId)) next.add(row.dstId);
      }
      for (const id of next) visited.add(id);
      frontier = next;
    }

    if (visited.size === 0) return [];

    const nodeGuard = scopeGuard('n', projectId);
    const nodeAllow = scopeAllowlist('n', scopes);
    const visitedArr = [...visited];
    const idPlaceholders = visitedArr.map(() => '?').join(',');
    const nodeRows = db
      .prepare(
        `SELECT n.id as id, n.canonical as canonical, n.kind as kind, n.scope as scope,
                n.project_id as projectId
         FROM nodes n
         WHERE n.id IN (${idPlaceholders})
           AND ${nodeGuard.sql}
           AND ${nodeAllow.sql}`
      )
      .all(...visitedArr, ...nodeGuard.params, ...nodeAllow.params) as unknown as Array<{
      id: number;
      canonical: string;
      kind: string;
      scope: Scope;
      projectId: string | null;
    }>;

    const obsGuard = scopeGuard('o', projectId);
    const obsAllow = scopeAllowlist('o', scopes);
    const obsStmt = db.prepare(
      `SELECT id, text, category, confidence, valid_from as validFrom
       FROM observations o
       WHERE o.node_id = ? AND o.invalidated_at IS NULL
         AND ${obsGuard.sql}
         AND ${obsAllow.sql}
       ORDER BY valid_from DESC`
    );

    return nodeRows.map((n) => ({
      ...n,
      observations: obsStmt.all(n.id, ...obsGuard.params, ...obsAllow.params) as unknown as ExpandedObservation[],
    }));
  }

  async function fetchVisibleEdges(nodeIds: number[], projectId: string | null): Promise<EdgeRow[]> {
    if (nodeIds.length === 0) return [];
    const placeholders = nodeIds.map(() => '?').join(',');
    const guard = scopeGuard('e', projectId);
    const rows = db
      .prepare(
        `SELECT sn.canonical as srcCanonical, e.predicate as predicate, dn.canonical as dstCanonical
         FROM edges e
         JOIN nodes sn ON sn.id = e.src_id
         JOIN nodes dn ON dn.id = e.dst_id
         WHERE e.invalidated_at IS NULL
           AND e.src_id IN (${placeholders})
           AND e.dst_id IN (${placeholders})
           AND ${guard.sql}
         ORDER BY e.created_at ASC`
      )
      .all(...nodeIds, ...nodeIds, ...guard.params) as unknown as EdgeRow[];
    return rows;
  }

  /** Deliberately unguarded raw fetch-by-id: the caller (memory_save's
   * supersedes_observation_id validation) needs the row unconditionally so
   * it can make its OWN visibility decision against the server's own
   * ownProjectId (never a caller-supplied project_id), producing two
   * distinct rejection reasons ("does not exist" vs "is not visible to this
   * project"). Applying a scope filter in this SQL would collapse both
   * cases into "does not exist", which is an observable behavior change —
   * do not add one here. */
  async function findSupersedeTarget(id: number): Promise<SupersedeTargetRow | undefined> {
    return db
      .prepare(
        `SELECT id, scope, project_id as projectId, invalidated_at as invalidatedAt
         FROM observations WHERE id = ?`
      )
      .get(id) as SupersedeTargetRow | undefined;
  }

  /** Internal-only (see RepositoryInternal doc comment): unguarded fetch of a
   * node's scope/project_id by id, for serve.ts's addAlias ownership check. */
  async function findNodeOwner(nodeId: number): Promise<OwnerRow | undefined> {
    return db
      .prepare('SELECT id, scope, project_id as projectId FROM nodes WHERE id = ?')
      .get(nodeId) as OwnerRow | undefined;
  }

  /** Internal-only (see RepositoryInternal doc comment): unguarded fetch of an
   * edge's scope/project_id by id, for serve.ts's invalidateEdge/supersedeEdge
   * ownership checks. */
  async function findEdgeOwner(edgeId: number): Promise<OwnerRow | undefined> {
    return db
      .prepare('SELECT id, scope, project_id as projectId FROM edges WHERE id = ?')
      .get(edgeId) as OwnerRow | undefined;
  }

  /**
   * Looks for an existing near-duplicate of `text` among valid (not
   * invalidated), caller-visible observations in `scope`/`projectId` —
   * visibility and validity are enforced by searchObservations() itself
   * (its scopeGuard/scopeAllowlist and default `includeInvalidated: false`),
   * never re-implemented here. This is a best-effort heuristic, not a
   * security boundary: it fails open on any error (including a pathological
   * MATCH failure on unusual fact text) by returning null, so a previously-
   * valid save can never be blocked by this check misbehaving.
   */
  async function findNearDuplicate(
    text: string,
    scope: Scope,
    projectId: string | null
  ): Promise<NearDupMatch | null> {
    try {
      const words = significantWords(text);
      if (words.length < MIN_ANCHOR_WORDS) return null;

      // Document-frequency proxy: how many existing valid/visible
      // observations already contain this word. A word with df=0 can never
      // contribute to a match and is dropped before ranking.
      const scored = await Promise.all(words.map(async (word, index) => ({
        word,
        index,
        df: (await searchObservations({ query: word, scopes: [scope], projectId, limit: ANCHOR_DF_SEARCH_LIMIT })).length,
      })));
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
        const rows = await searchObservations({ query, scopes: [scope], projectId, limit: 5 });
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

  async function listNodes(
    scopes: Scope[] | undefined,
    projectId: string | null,
    entityFilter: string | undefined,
    limit = 50
  ): Promise<RawNodeRow[]> {
    const guard = scopeGuard('n', projectId);
    const allow = scopeAllowlist('n', scopes);
    const params: SqlParam[] = [...guard.params, ...allow.params];
    let sql = `SELECT n.id as id, n.canonical as canonical, n.kind as kind, n.scope as scope,
                      n.project_id as projectId, n.project_label as projectLabel
               FROM nodes n
               WHERE ${guard.sql} AND ${allow.sql}`;

    if (entityFilter) {
      const likePattern = `%${normalize(entityFilter).replace(/[%_]/g, '\\$&')}%`;
      sql += ` AND (n.canonical LIKE ? ESCAPE '\\' OR n.id IN (
                  SELECT node_id FROM node_aliases WHERE alias LIKE ? ESCAPE '\\'
               ))`;
      params.push(likePattern, likePattern);
    }

    sql += ' ORDER BY n.updated_at DESC LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params) as unknown as RawNodeRow[];
  }

  async function listObservationsForNode(
    nodeId: number,
    projectId: string | null
  ): Promise<InspectObservationRow[]> {
    const guard = scopeGuard('o', projectId);
    return db
      .prepare(
        `SELECT id, text, category, confidence, source,
                valid_from as validFrom, invalidated_at as invalidatedAt, superseded_by as supersededBy
         FROM observations o
         WHERE o.node_id = ?
           AND ${guard.sql}
         ORDER BY o.valid_from DESC`
      )
      .all(nodeId, ...guard.params) as unknown as InspectObservationRow[];
  }

  async function listWisdomRows(
    categories: string[],
    projectId: string | null,
    limit: number
  ): Promise<ListWisdomResult> {
    const categoryPlaceholders = categories.map(() => '?').join(',');
    const guard = scopeGuard('o', projectId);
    // Scope guard kept semantically identical to the pre-consolidation
    // direct-SQL version: global rows are always visible, project/private
    // rows only when they match the caller's resolved project_id.
    const whereClause = `WHERE o.invalidated_at IS NULL
           AND o.category IN (${categoryPlaceholders})
           AND ${guard.sql}`;

    const total = (
      db
        .prepare(`SELECT COUNT(*) as count FROM observations o ${whereClause}`)
        .get(...categories, ...guard.params) as { count: number }
    ).count;

    const rows = db
      .prepare(
        `SELECT o.category as category, o.text as text, o.confidence as confidence,
                o.valid_from as validFrom
         FROM observations o
         ${whereClause}
         ORDER BY CASE o.confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC,
                  o.valid_from DESC
         LIMIT ?`
      )
      .all(...categories, ...guard.params, limit) as unknown as WisdomRow[];

    return { rows, total };
  }

  async function injectObservations(
    scope: Scope,
    projectId: string | null,
    limit: number
  ): Promise<InjectObservationRow[]> {
    const orderBy = `CASE o.confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC, o.valid_from DESC`;
    if (scope === 'global') {
      return db
        .prepare(
          `SELECT o.id as id, n.canonical as canonical, o.text as text, o.scope as scope,
                  o.category as category, o.confidence as confidence, o.valid_from as validFrom
           FROM observations o JOIN nodes n ON n.id = o.node_id
           WHERE o.invalidated_at IS NULL AND o.scope = 'global'
           ORDER BY ${orderBy}
           LIMIT ?`
        )
        .all(limit) as unknown as InjectObservationRow[];
    }
    return db
      .prepare(
        `SELECT o.id as id, n.canonical as canonical, o.text as text, o.scope as scope,
                o.category as category, o.confidence as confidence, o.valid_from as validFrom
         FROM observations o JOIN nodes n ON n.id = o.node_id
         WHERE o.invalidated_at IS NULL AND o.scope = ? AND o.project_id = ?
         ORDER BY ${orderBy}
         LIMIT ?`
      )
      .all(scope, projectId, limit) as unknown as InjectObservationRow[];
  }

  async function highConfidenceObservations(
    scope: Scope,
    projectId: string | null,
    limit: number
  ): Promise<InjectObservationRow[]> {
    if (scope === 'global') {
      return db
        .prepare(
          `SELECT o.id as id, n.canonical as canonical, o.text as text, o.scope as scope,
                  o.category as category, o.confidence as confidence, o.valid_from as validFrom
           FROM observations o JOIN nodes n ON n.id = o.node_id
           WHERE o.invalidated_at IS NULL AND o.scope = 'global' AND o.confidence = 'high'
           ORDER BY o.valid_from DESC
           LIMIT ?`
        )
        .all(limit) as unknown as InjectObservationRow[];
    }
    return db
      .prepare(
        `SELECT o.id as id, n.canonical as canonical, o.text as text, o.scope as scope,
                o.category as category, o.confidence as confidence, o.valid_from as validFrom
         FROM observations o JOIN nodes n ON n.id = o.node_id
         WHERE o.invalidated_at IS NULL AND o.scope = ? AND o.project_id = ? AND o.confidence = 'high'
         ORDER BY o.valid_from DESC
         LIMIT ?`
      )
      .all(scope, projectId, limit) as unknown as InjectObservationRow[];
  }

  async function entityRoster(projectId: string | null): Promise<EntityRosterRow[]> {
    const guard = scopeGuard('o', projectId);
    return db
      .prepare(
        `SELECT n.canonical as canonical, COUNT(*) as count
         FROM observations o JOIN nodes n ON n.id = o.node_id
         WHERE o.invalidated_at IS NULL
           AND ${guard.sql}
         GROUP BY o.node_id
         ORDER BY MAX(o.valid_from) DESC`
      )
      .all(...guard.params) as unknown as EntityRosterRow[];
  }

  function countsByScope(table: 'nodes' | 'observations' | 'edges', projectId: string | null) {
    const guard = scopeGuard(table, projectId);
    const rows = db
      .prepare(`SELECT scope, COUNT(*) as c FROM ${table} WHERE ${guard.sql} GROUP BY scope`)
      .all(...guard.params) as Array<{ scope: Scope; c: number }>;
    const result = EMPTY_SCOPE_COUNTS();
    let total = 0;
    for (const row of rows) {
      result[row.scope] = row.c;
      total += row.c;
    }
    return { total, byScope: result };
  }

  function invalidatedCount(table: 'observations' | 'edges', projectId: string | null): number {
    const guard = scopeGuard(table, projectId);
    const row = db
      .prepare(`SELECT COUNT(*) as c FROM ${table} WHERE invalidated_at IS NOT NULL AND ${guard.sql}`)
      .get(...guard.params) as { c: number };
    return row.c;
  }

  function olderThan90DaysCount(projectId: string | null): number {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const guard = scopeGuard('observations', projectId);
    const row = db
      .prepare(`SELECT COUNT(*) as c FROM observations WHERE created_at < ? AND ${guard.sql}`)
      .get(cutoff, ...guard.params) as { c: number };
    return row.c;
  }

  async function stats(projectId: string | null = null): Promise<StatsResult> {
    const nodeCounts = countsByScope('nodes', projectId);
    const obsCounts = countsByScope('observations', projectId);
    const edgeCounts = countsByScope('edges', projectId);

    let dbSizeBytes: number | null = null;
    if (opts.dbPath && opts.dbPath !== ':memory:') {
      try {
        dbSizeBytes = statSync(opts.dbPath).size;
      } catch {
        dbSizeBytes = null;
      }
    }

    return {
      nodes: nodeCounts,
      observations: {
        ...obsCounts,
        invalidated: invalidatedCount('observations', projectId),
        olderThan90Days: olderThan90DaysCount(projectId),
      },
      edges: { ...edgeCounts, invalidated: invalidatedCount('edges', projectId) },
      dbSizeBytes,
    };
  }

  return {
    upsertNode,
    addAlias,
    findSimilarNodes,
    addObservation,
    supersedeObservation,
    invalidateObservation,
    upsertEdge,
    invalidateEdge,
    supersedeEdge,
    searchObservations,
    expandFromNodes,
    stats,
    fetchVisibleEdges,
    findSupersedeTarget,
    findNodeOwner,
    findEdgeOwner,
    findNearDuplicate,
    listNodes,
    listObservationsForNode,
    listWisdomRows,
    injectObservations,
    highConfidenceObservations,
    entityRoster,
  };
}
