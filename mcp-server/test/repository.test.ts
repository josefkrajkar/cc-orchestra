import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../src/db/connection.js';
import { createRepository, type Repository } from '../src/db/repository.js';

describe('repository', () => {
  let db: SqliteDatabase;
  let repo: Repository;

  beforeEach(() => {
    db = openDb(':memory:');
    repo = createRepository(db);
  });

  it('dedups entities via alias reuse (case/whitespace-insensitive)', () => {
    const first = repo.upsertNode({ canonical: 'Josef Krajkar', kind: 'person', scope: 'global' });
    expect(first.created).toBe(true);

    repo.addAlias(first.id, 'Josef');

    const reusedViaAlias = repo.upsertNode({ canonical: '  josef  ', kind: 'person', scope: 'global' });
    expect(reusedViaAlias.created).toBe(false);
    expect(reusedViaAlias.id).toBe(first.id);

    const reusedViaCanonical = repo.upsertNode({
      canonical: 'JOSEF   KRAJKAR',
      kind: 'person',
      scope: 'global',
    });
    expect(reusedViaCanonical.created).toBe(false);
    expect(reusedViaCanonical.id).toBe(first.id);

    const nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number };
    expect(nodeCount.c).toBe(1);
  });

  it('ranks FTS5 BM25 search results by relevance', () => {
    const node = repo.upsertNode({ canonical: 'orchestra plugin', kind: 'project', scope: 'global' });
    repo.addObservation({
      nodeId: node.id,
      text: 'Orchestra plugin uses bash and jq for orchestration.',
      scope: 'global',
    });
    repo.addObservation({
      nodeId: node.id,
      text: 'The plugin has nothing to do with any particular storage engine.',
      scope: 'global',
    });
    const strongMatch = repo.addObservation({
      nodeId: node.id,
      text: 'SQLite graph memory stores nodes and edges in sqlite, queried via sqlite FTS5, backed by a sqlite database file.',
      scope: 'global',
    });

    const results = repo.searchObservations({ query: 'sqlite', projectId: null });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.observationId).toBe(strongMatch);
    // bm25() in sqlite is more negative for stronger matches; ascending order puts best match first.
    expect(results[0]!.rank).toBeLessThanOrEqual(results[results.length - 1]!.rank);
  });

  it('supersede sets invalidated_at + superseded_by and search excludes the old fact', () => {
    const node = repo.upsertNode({
      canonical: 'backend framework',
      kind: 'tech',
      scope: 'project',
      projectId: 'proj-a',
    });
    const oldObs = repo.addObservation({
      nodeId: node.id,
      text: 'Project uses Express as its backend framework.',
      scope: 'project',
      projectId: 'proj-a',
    });
    const newObs = repo.addObservation({
      nodeId: node.id,
      text: 'Project migrated to Hono as its backend framework.',
      scope: 'project',
      projectId: 'proj-a',
    });
    repo.supersedeObservation(oldObs, newObs);

    const active = repo.searchObservations({ query: 'framework', projectId: 'proj-a' });
    const activeIds = active.map((r) => r.observationId);
    expect(activeIds).not.toContain(oldObs);
    expect(activeIds).toContain(newObs);

    const withInvalidated = repo.searchObservations({
      query: 'framework',
      projectId: 'proj-a',
      includeInvalidated: true,
    });
    const oldRow = withInvalidated.find((r) => r.observationId === oldObs);
    expect(oldRow).toBeDefined();
    expect(oldRow?.invalidatedAt).not.toBeNull();
    expect(oldRow?.supersededBy).toBe(newObs);
  });

  it('isolates scope: private/project data confined to owning project, global always visible', () => {
    const globalNode = repo.upsertNode({ canonical: 'orchestra', kind: 'project', scope: 'global' });
    repo.addObservation({
      nodeId: globalNode.id,
      text: 'Global fact visible everywhere about orchestra crossproject.',
      scope: 'global',
    });

    const privateNode = repo.upsertNode({
      canonical: 'client secret',
      kind: 'fact',
      scope: 'private',
      projectId: 'proj-a',
    });
    repo.addObservation({
      nodeId: privateNode.id,
      text: 'Private clientalpha secret detail for project A only.',
      scope: 'private',
      projectId: 'proj-a',
    });

    const projectNode = repo.upsertNode({
      canonical: 'proj a convention',
      kind: 'convention',
      scope: 'project',
      projectId: 'proj-a',
    });
    repo.addObservation({
      nodeId: projectNode.id,
      text: 'Project A convention betaword detail.',
      scope: 'project',
      projectId: 'proj-a',
    });

    // Querying as project B must never see A's private or project-scoped facts.
    expect(repo.searchObservations({ query: 'clientalpha', projectId: 'proj-b' })).toHaveLength(0);
    expect(repo.searchObservations({ query: 'betaword', projectId: 'proj-b' })).toHaveLength(0);
    // ...but global facts surface cross-project.
    expect(repo.searchObservations({ query: 'crossproject', projectId: 'proj-b' })).toHaveLength(1);

    // Querying as project A sees its own private + project facts.
    expect(repo.searchObservations({ query: 'clientalpha', projectId: 'proj-a' })).toHaveLength(1);
    expect(repo.searchObservations({ query: 'betaword', projectId: 'proj-a' })).toHaveLength(1);

    // With no project context at all, private/project data must never leak.
    expect(repo.searchObservations({ query: 'clientalpha', projectId: null })).toHaveLength(0);
  });

  it('upsertEdge is idempotent via the partial unique index on the live triple', () => {
    const a = repo.upsertNode({ canonical: 'node a', kind: 'other', scope: 'global' });
    const b = repo.upsertNode({ canonical: 'node b', kind: 'other', scope: 'global' });

    const first = repo.upsertEdge({ srcId: a.id, predicate: 'relates_to', dstId: b.id, scope: 'global' });
    expect(first.created).toBe(true);

    const second = repo.upsertEdge({ srcId: a.id, predicate: 'relates_to', dstId: b.id, scope: 'global' });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    const count = db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number };
    expect(count.c).toBe(1);

    // After invalidating, upserting the same triple again should create a fresh edge.
    repo.invalidateEdge(first.id);
    const third = repo.upsertEdge({ srcId: a.id, predicate: 'relates_to', dstId: b.id, scope: 'global' });
    expect(third.created).toBe(true);
    expect(third.id).not.toBe(first.id);
  });

  it('expandFromNodes walks valid edges within scope and returns connected observations', () => {
    const hub = repo.upsertNode({ canonical: 'hub node', kind: 'other', scope: 'project', projectId: 'proj-a' });
    const connected = repo.upsertNode({
      canonical: 'connected node',
      kind: 'other',
      scope: 'project',
      projectId: 'proj-a',
    });
    const stale = repo.upsertNode({ canonical: 'stale node', kind: 'other', scope: 'project', projectId: 'proj-a' });
    const otherProject = repo.upsertNode({
      canonical: 'other project node',
      kind: 'other',
      scope: 'project',
      projectId: 'proj-b',
    });

    repo.addObservation({
      nodeId: connected.id,
      text: 'Connected node carries an important fact.',
      scope: 'project',
      projectId: 'proj-a',
    });

    const validEdge = repo.upsertEdge({
      srcId: hub.id,
      predicate: 'uses',
      dstId: connected.id,
      scope: 'project',
      projectId: 'proj-a',
    });
    const staleEdge = repo.upsertEdge({
      srcId: hub.id,
      predicate: 'used',
      dstId: stale.id,
      scope: 'project',
      projectId: 'proj-a',
    });
    repo.invalidateEdge(staleEdge.id);

    // An edge scoped to a different project must never be traversable from proj-a's context.
    repo.upsertEdge({
      srcId: hub.id,
      predicate: 'cross',
      dstId: otherProject.id,
      scope: 'project',
      projectId: 'proj-b',
    });

    const expanded = repo.expandFromNodes([hub.id], 1, undefined, 'proj-a');
    const ids = expanded.map((n) => n.id);

    expect(ids).toContain(hub.id);
    expect(ids).toContain(connected.id);
    expect(ids).not.toContain(stale.id);
    expect(ids).not.toContain(otherProject.id);

    const connectedResult = expanded.find((n) => n.id === connected.id);
    expect(connectedResult?.observations).toHaveLength(1);
    expect(connectedResult?.observations[0]?.text).toContain('important fact');

    expect(validEdge.created).toBe(true);
  });

  it('stats reports counts scoped to the caller project plus global', () => {
    repo.upsertNode({ canonical: 'global thing', kind: 'other', scope: 'global' });
    repo.upsertNode({ canonical: 'proj a thing', kind: 'other', scope: 'project', projectId: 'proj-a' });
    repo.upsertNode({ canonical: 'proj b thing', kind: 'other', scope: 'project', projectId: 'proj-b' });

    const statsA = repo.stats('proj-a');
    expect(statsA.nodes.byScope.global).toBe(1);
    expect(statsA.nodes.byScope.project).toBe(1);
    expect(statsA.nodes.total).toBe(2);
  });

  // Finding 5: searchObservations() must sanitize its FTS5 MATCH input (see
  // sanitizeFtsQuery() in db/repository.ts) so hostile query strings can
  // never throw a MATCH syntax error or hijack the query — every token is
  // wrapped as a quoted phrase literal, neutralizing FTS5 operators/syntax.
  it('sanitizes hostile FTS5 query strings instead of throwing a MATCH syntax error', () => {
    repo.upsertNode({ canonical: 'safe node', kind: 'other', scope: 'global' });
    repo.addObservation({
      nodeId: repo.upsertNode({ canonical: 'safe node', kind: 'other', scope: 'global' }).id,
      text: 'This is a perfectly safe observation about NEAR and OR keywords.',
      scope: 'global',
    });

    const hostileQueries = [
      'foo" OR 1=1 --', // attempted SQL/FTS injection via a broken quote + boolean
      'NEAR(a,b)', // FTS5 NEAR() proximity operator syntax
      '((unbalanced', // unbalanced parentheses — invalid FTS5 expression syntax
      '"', // bare double quote — invalid/unterminated phrase literal
    ];

    for (const query of hostileQueries) {
      let results: ReturnType<typeof repo.searchObservations> = [];
      expect(() => {
        results = repo.searchObservations({ query, projectId: null });
      }).not.toThrow();
      expect(Array.isArray(results)).toBe(true);
    }
  });
});
