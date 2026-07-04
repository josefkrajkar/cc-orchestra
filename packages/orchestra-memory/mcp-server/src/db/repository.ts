// Typed repository over the graph memory SQLite schema (see schema.sql).
//
// Security-critical invariant enforced everywhere data is *read*: a row is
// only visible if `scope = 'global'` OR (`scope IN ('project','private')`
// AND `project_id` matches the caller's current project). This is the only
// thing standing between a private fact from client A and a session running
// against client B — every read helper in this file goes through
// scopeGuard()/scopeAllowlist() to apply it consistently.
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

export interface Repository {
  upsertNode(input: UpsertNodeInput): UpsertNodeResult;
  addAlias(nodeId: number, alias: string): void;
  findSimilarNodes(
    name: string,
    scope: Scope,
    projectId?: string | null,
    limit?: number
  ): SimilarNode[];
  addObservation(input: AddObservationInput): number;
  supersedeObservation(oldId: number, newId: number): void;
  invalidateObservation(id: number, hard?: boolean): void;
  upsertEdge(input: UpsertEdgeInput): UpsertEdgeResult;
  invalidateEdge(id: number): void;
  supersedeEdge(oldId: number, newId: number): void;
  searchObservations(input: SearchObservationsInput): SearchResultRow[];
  expandFromNodes(
    nodeIds: number[],
    depth: number,
    scopes?: Scope[],
    projectId?: string | null
  ): ExpandedNode[];
  stats(projectId?: string | null): StatsResult;
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

export function createRepository(db: SqliteDatabase, opts: { dbPath?: string } = {}): Repository {
  function addAlias(nodeId: number, alias: string): void {
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

  function upsertNode(input: UpsertNodeInput): UpsertNodeResult {
    const canonical = normalize(input.canonical);
    const projectId = input.projectId ?? null;

    const byCanonical = db
      .prepare(
        `SELECT id FROM nodes WHERE canonical = ? AND scope = ? AND COALESCE(project_id,'') = COALESCE(?, '')`
      )
      .get(canonical, input.scope, projectId) as { id: number } | undefined;

    if (byCanonical) {
      for (const alias of input.aliases ?? []) addAlias(byCanonical.id, alias);
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
      for (const alias of input.aliases ?? []) addAlias(byAlias.id, alias);
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
    for (const alias of input.aliases ?? []) addAlias(id, alias);
    return { id, created: true };
  }

  function findSimilarNodes(
    name: string,
    scope: Scope,
    projectId: string | null = null,
    limit = 10
  ): SimilarNode[] {
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

  function addObservation(input: AddObservationInput): number {
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

  function supersedeObservation(oldId: number, newId: number): void {
    db.prepare('UPDATE observations SET invalidated_at = ?, superseded_by = ? WHERE id = ?').run(
      nowIso(),
      newId,
      oldId
    );
  }

  function invalidateObservation(id: number, hard = false): void {
    if (hard) {
      db.prepare('DELETE FROM observations WHERE id = ?').run(id);
    } else {
      db.prepare('UPDATE observations SET invalidated_at = ? WHERE id = ?').run(nowIso(), id);
    }
  }

  function upsertEdge(input: UpsertEdgeInput): UpsertEdgeResult {
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

  function invalidateEdge(id: number): void {
    db.prepare('UPDATE edges SET invalidated_at = ? WHERE id = ?').run(nowIso(), id);
  }

  function supersedeEdge(oldId: number, newId: number): void {
    db.prepare('UPDATE edges SET invalidated_at = ?, superseded_by = ? WHERE id = ?').run(
      nowIso(),
      newId,
      oldId
    );
  }

  function searchObservations(input: SearchObservationsInput): SearchResultRow[] {
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

  function expandFromNodes(
    nodeIds: number[],
    depth: number,
    scopes?: Scope[],
    projectId: string | null = null
  ): ExpandedNode[] {
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

  function stats(projectId: string | null = null): StatsResult {
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
  };
}
