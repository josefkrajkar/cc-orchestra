import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../src/db/connection.js';
import { createRepository, NEAR_DUP_RANK_THRESHOLD, type RepositoryInternal } from '../src/db/repository.js';

/** Background facts unrelated to the near-duplicate pairs under test, mirroring
 * test/tools.test.ts's seedNearDupNoise: BM25's IDF term (and therefore its
 * rank magnitude) is a function of corpus diversity — with only one prior
 * observation to compare against, even a perfect match scores near zero (see
 * repository.ts's NEAR_DUP_RANK_THRESHOLD doc comment) and never clears the
 * guard's threshold. Seeding a handful of unrelated facts first gives BM25
 * the topical diversity a real (non brand-new) project's memory would have. */
async function seedNearDupNoise(repo: RepositoryInternal, projectId: string): Promise<void> {
  const noise = [
    'The team prefers dark mode enabled by default in the settings panel.',
    'Redis is used as the session store for the auth service in production.',
    'The user prefers tabs over spaces for indentation in Python files.',
    'The team decided to use pnpm workspaces instead of npm or yarn for this monorepo.',
    'Client requested no third-party analytics tools be added to the dashboard.',
    'Josef Krajkar maintains the Orchestra plugin project and lives in Prague.',
  ];
  for (const [i, text] of noise.entries()) {
    const node = await repo.upsertNode({ canonical: `Noise ${i}`, kind: 'other', scope: 'project', projectId });
    await repo.addObservation({ nodeId: node.id, text, scope: 'project', projectId });
  }
}

describe('repository', () => {
  let db: SqliteDatabase;
  let repo: RepositoryInternal;

  beforeEach(() => {
    db = openDb(':memory:');
    repo = createRepository(db);
  });

  it('dedups entities via alias reuse (case/whitespace-insensitive)', async () => {
    const first = await repo.upsertNode({ canonical: 'Josef Krajkar', kind: 'person', scope: 'global' });
    expect(first.created).toBe(true);

    await repo.addAlias(first.id, 'Josef');

    const reusedViaAlias = await repo.upsertNode({ canonical: '  josef  ', kind: 'person', scope: 'global' });
    expect(reusedViaAlias.created).toBe(false);
    expect(reusedViaAlias.id).toBe(first.id);

    const reusedViaCanonical = await repo.upsertNode({
      canonical: 'JOSEF   KRAJKAR',
      kind: 'person',
      scope: 'global',
    });
    expect(reusedViaCanonical.created).toBe(false);
    expect(reusedViaCanonical.id).toBe(first.id);

    const nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number };
    expect(nodeCount.c).toBe(1);
  });

  it('ranks FTS5 BM25 search results by relevance', async () => {
    const node = await repo.upsertNode({ canonical: 'orchestra plugin', kind: 'project', scope: 'global' });
    await repo.addObservation({
      nodeId: node.id,
      text: 'Orchestra plugin uses bash and jq for orchestration.',
      scope: 'global',
    });
    await repo.addObservation({
      nodeId: node.id,
      text: 'The plugin has nothing to do with any particular storage engine.',
      scope: 'global',
    });
    const strongMatch = await repo.addObservation({
      nodeId: node.id,
      text: 'SQLite graph memory stores nodes and edges in sqlite, queried via sqlite FTS5, backed by a sqlite database file.',
      scope: 'global',
    });

    const results = await repo.searchObservations({ query: 'sqlite', projectId: null });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.observationId).toBe(strongMatch);
    // bm25() in sqlite is more negative for stronger matches; ascending order puts best match first.
    expect(results[0]!.rank).toBeLessThanOrEqual(results[results.length - 1]!.rank);
  });

  it('supersede sets invalidated_at + superseded_by and search excludes the old fact', async () => {
    const node = await repo.upsertNode({
      canonical: 'backend framework',
      kind: 'tech',
      scope: 'project',
      projectId: 'proj-a',
    });
    const oldObs = await repo.addObservation({
      nodeId: node.id,
      text: 'Project uses Express as its backend framework.',
      scope: 'project',
      projectId: 'proj-a',
    });
    const newObs = await repo.addObservation({
      nodeId: node.id,
      text: 'Project migrated to Hono as its backend framework.',
      scope: 'project',
      projectId: 'proj-a',
    });
    await repo.supersedeObservation(oldObs, newObs);

    const active = await repo.searchObservations({ query: 'framework', projectId: 'proj-a' });
    const activeIds = active.map((r) => r.observationId);
    expect(activeIds).not.toContain(oldObs);
    expect(activeIds).toContain(newObs);

    const withInvalidated = await repo.searchObservations({
      query: 'framework',
      projectId: 'proj-a',
      includeInvalidated: true,
    });
    const oldRow = withInvalidated.find((r) => r.observationId === oldObs);
    expect(oldRow).toBeDefined();
    expect(oldRow?.invalidatedAt).not.toBeNull();
    expect(oldRow?.supersededBy).toBe(newObs);
  });

  it('isolates scope: private/project data confined to owning project, global always visible', async () => {
    const globalNode = await repo.upsertNode({ canonical: 'orchestra', kind: 'project', scope: 'global' });
    await repo.addObservation({
      nodeId: globalNode.id,
      text: 'Global fact visible everywhere about orchestra crossproject.',
      scope: 'global',
    });

    const privateNode = await repo.upsertNode({
      canonical: 'client secret',
      kind: 'fact',
      scope: 'private',
      projectId: 'proj-a',
    });
    await repo.addObservation({
      nodeId: privateNode.id,
      text: 'Private clientalpha secret detail for project A only.',
      scope: 'private',
      projectId: 'proj-a',
    });

    const projectNode = await repo.upsertNode({
      canonical: 'proj a convention',
      kind: 'convention',
      scope: 'project',
      projectId: 'proj-a',
    });
    await repo.addObservation({
      nodeId: projectNode.id,
      text: 'Project A convention betaword detail.',
      scope: 'project',
      projectId: 'proj-a',
    });

    // Querying as project B must never see A's private or project-scoped facts.
    expect(await repo.searchObservations({ query: 'clientalpha', projectId: 'proj-b' })).toHaveLength(0);
    expect(await repo.searchObservations({ query: 'betaword', projectId: 'proj-b' })).toHaveLength(0);
    // ...but global facts surface cross-project.
    expect(await repo.searchObservations({ query: 'crossproject', projectId: 'proj-b' })).toHaveLength(1);

    // Querying as project A sees its own private + project facts.
    expect(await repo.searchObservations({ query: 'clientalpha', projectId: 'proj-a' })).toHaveLength(1);
    expect(await repo.searchObservations({ query: 'betaword', projectId: 'proj-a' })).toHaveLength(1);

    // With no project context at all, private/project data must never leak.
    expect(await repo.searchObservations({ query: 'clientalpha', projectId: null })).toHaveLength(0);
  });

  it('upsertEdge is idempotent via the partial unique index on the live triple', async () => {
    const a = await repo.upsertNode({ canonical: 'node a', kind: 'other', scope: 'global' });
    const b = await repo.upsertNode({ canonical: 'node b', kind: 'other', scope: 'global' });

    const first = await repo.upsertEdge({ srcId: a.id, predicate: 'relates_to', dstId: b.id, scope: 'global' });
    expect(first.created).toBe(true);

    const second = await repo.upsertEdge({ srcId: a.id, predicate: 'relates_to', dstId: b.id, scope: 'global' });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    const count = db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number };
    expect(count.c).toBe(1);

    // After invalidating, upserting the same triple again should create a fresh edge.
    await repo.invalidateEdge(first.id);
    const third = await repo.upsertEdge({ srcId: a.id, predicate: 'relates_to', dstId: b.id, scope: 'global' });
    expect(third.created).toBe(true);
    expect(third.id).not.toBe(first.id);
  });

  it('expandFromNodes walks valid edges within scope and returns connected observations', async () => {
    const hub = await repo.upsertNode({ canonical: 'hub node', kind: 'other', scope: 'project', projectId: 'proj-a' });
    const connected = await repo.upsertNode({
      canonical: 'connected node',
      kind: 'other',
      scope: 'project',
      projectId: 'proj-a',
    });
    const stale = await repo.upsertNode({ canonical: 'stale node', kind: 'other', scope: 'project', projectId: 'proj-a' });
    const otherProject = await repo.upsertNode({
      canonical: 'other project node',
      kind: 'other',
      scope: 'project',
      projectId: 'proj-b',
    });

    await repo.addObservation({
      nodeId: connected.id,
      text: 'Connected node carries an important fact.',
      scope: 'project',
      projectId: 'proj-a',
    });

    const validEdge = await repo.upsertEdge({
      srcId: hub.id,
      predicate: 'uses',
      dstId: connected.id,
      scope: 'project',
      projectId: 'proj-a',
    });
    const staleEdge = await repo.upsertEdge({
      srcId: hub.id,
      predicate: 'used',
      dstId: stale.id,
      scope: 'project',
      projectId: 'proj-a',
    });
    await repo.invalidateEdge(staleEdge.id);

    // An edge scoped to a different project must never be traversable from proj-a's context.
    await repo.upsertEdge({
      srcId: hub.id,
      predicate: 'cross',
      dstId: otherProject.id,
      scope: 'project',
      projectId: 'proj-b',
    });

    const expanded = await repo.expandFromNodes([hub.id], 1, undefined, 'proj-a');
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

  it('stats reports counts scoped to the caller project plus global', async () => {
    await repo.upsertNode({ canonical: 'global thing', kind: 'other', scope: 'global' });
    await repo.upsertNode({ canonical: 'proj a thing', kind: 'other', scope: 'project', projectId: 'proj-a' });
    await repo.upsertNode({ canonical: 'proj b thing', kind: 'other', scope: 'project', projectId: 'proj-b' });

    const statsA = await repo.stats('proj-a');
    expect(statsA.nodes.byScope.global).toBe(1);
    expect(statsA.nodes.byScope.project).toBe(1);
    expect(statsA.nodes.total).toBe(2);
  });

  // Finding 5: searchObservations() must sanitize its FTS5 MATCH input (see
  // sanitizeFtsQuery() in db/repository.ts) so hostile query strings can
  // never throw a MATCH syntax error or hijack the query — every token is
  // wrapped as a quoted phrase literal, neutralizing FTS5 operators/syntax.
  it('sanitizes hostile FTS5 query strings instead of throwing a MATCH syntax error', async () => {
    await repo.upsertNode({ canonical: 'safe node', kind: 'other', scope: 'global' });
    const safeNode = await repo.upsertNode({ canonical: 'safe node', kind: 'other', scope: 'global' });
    await repo.addObservation({
      nodeId: safeNode.id,
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
      let results: Awaited<ReturnType<typeof repo.searchObservations>> = [];
      let threw = false;
      try {
        results = await repo.searchObservations({ query, projectId: null });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(Array.isArray(results)).toBe(true);
    }
  });

  it('fetchVisibleEdges returns only scope-visible edges, ordered by created_at ascending', async () => {
    const a = await repo.upsertNode({ canonical: 'edge node a', kind: 'other', scope: 'project', projectId: 'proj-a' });
    const b = await repo.upsertNode({ canonical: 'edge node b', kind: 'other', scope: 'project', projectId: 'proj-a' });
    const c = await repo.upsertNode({ canonical: 'edge node c', kind: 'other', scope: 'global' });
    const otherProjNode = await repo.upsertNode({
      canonical: 'edge node other',
      kind: 'other',
      scope: 'project',
      projectId: 'proj-b',
    });

    await repo.upsertEdge({ srcId: a.id, predicate: 'first', dstId: b.id, scope: 'project', projectId: 'proj-a' });
    await repo.upsertEdge({ srcId: b.id, predicate: 'second', dstId: c.id, scope: 'global' });
    // Cross-project edge: must never be visible from proj-a's context.
    const crossEdge = await repo.upsertEdge({
      srcId: a.id,
      predicate: 'cross',
      dstId: otherProjNode.id,
      scope: 'project',
      projectId: 'proj-b',
    });

    const edges = await repo.fetchVisibleEdges([a.id, b.id, c.id, otherProjNode.id], 'proj-a');
    expect(edges.map((e) => e.predicate)).toEqual(['first', 'second']);
    expect(edges.every((e) => e.predicate !== 'cross')).toBe(true);
    expect(crossEdge.created).toBe(true);

    // Empty input short-circuits without hitting the DB.
    expect(await repo.fetchVisibleEdges([], 'proj-a')).toEqual([]);
  });

  it('findSupersedeTarget returns the row for any id regardless of scope/project, and undefined when missing', async () => {
    const node = await repo.upsertNode({
      canonical: 'proj b secret node',
      kind: 'other',
      scope: 'private',
      projectId: 'proj-b',
    });
    const obsId = await repo.addObservation({
      nodeId: node.id,
      text: 'A private fact belonging to project B.',
      scope: 'private',
      projectId: 'proj-b',
    });

    // Fetched with NO project context at all — this method must not filter
    // by project; the visibility decision belongs to the caller.
    const target = await repo.findSupersedeTarget(obsId);
    expect(target).toBeDefined();
    expect(target?.id).toBe(obsId);
    expect(target?.scope).toBe('private');
    expect(target?.projectId).toBe('proj-b');
    expect(target?.invalidatedAt).toBeNull();

    expect(await repo.findSupersedeTarget(999999)).toBeUndefined();
  });

  it('findNodeOwner and findEdgeOwner return scope/projectId for any id regardless of scope/project, and undefined when missing', async () => {
    const src = await repo.upsertNode({
      canonical: 'owner-lookup src',
      kind: 'other',
      scope: 'private',
      projectId: 'proj-owner-lookup',
    });
    const dst = await repo.upsertNode({ canonical: 'owner-lookup dst', kind: 'other', scope: 'global' });
    const edge = await repo.upsertEdge({
      srcId: src.id,
      predicate: 'relates_to',
      dstId: dst.id,
      scope: 'private',
      projectId: 'proj-owner-lookup',
    });

    const nodeOwner = await repo.findNodeOwner(src.id);
    expect(nodeOwner).toEqual({ id: src.id, scope: 'private', projectId: 'proj-owner-lookup' });
    expect(await repo.findNodeOwner(999999)).toBeUndefined();

    const edgeOwner = await repo.findEdgeOwner(edge.id);
    expect(edgeOwner).toEqual({ id: edge.id, scope: 'private', projectId: 'proj-owner-lookup' });
    expect(await repo.findEdgeOwner(999999)).toBeUndefined();
  });

  it('findNearDuplicate surfaces a match at/below NEAR_DUP_RANK_THRESHOLD, and null for unrelated text', async () => {
    await seedNearDupNoise(repo, 'proj-neardup-repo');
    const node = await repo.upsertNode({
      canonical: 'storage backend',
      kind: 'other',
      scope: 'project',
      projectId: 'proj-neardup-repo',
    });
    const originalId = await repo.addObservation({
      nodeId: node.id,
      text: 'The project uses SQLite with FTS5 for full-text search over observation records.',
      scope: 'project',
      projectId: 'proj-neardup-repo',
    });

    const match = await repo.findNearDuplicate(
      'This project relies on SQLite and FTS5 to provide full-text search across observations.',
      'project',
      'proj-neardup-repo'
    );
    expect(match).not.toBeNull();
    expect(match?.observationId).toBe(originalId);
    expect(match?.rank).toBeLessThanOrEqual(NEAR_DUP_RANK_THRESHOLD);

    const noMatch = await repo.findNearDuplicate(
      'Completely unrelated statement about weather patterns in mountain regions.',
      'project',
      'proj-neardup-repo'
    );
    expect(noMatch).toBeNull();
  });

  it('listNodes / listObservationsForNode enforce scope isolation, entityFilter, and include invalidated observations', async () => {
    const projA = await repo.upsertNode({
      canonical: 'shared convention',
      kind: 'convention',
      scope: 'project',
      projectId: 'proj-list-a',
    });
    await repo.upsertNode({
      canonical: 'shared convention',
      kind: 'convention',
      scope: 'project',
      projectId: 'proj-list-b',
    });
    const globalNode = await repo.upsertNode({ canonical: 'global thing', kind: 'other', scope: 'global' });

    const nodesForA = await repo.listNodes(undefined, 'proj-list-a', undefined);
    const canonicalsForA = nodesForA.map((n) => n.canonical);
    expect(canonicalsForA).toContain('shared convention');
    expect(canonicalsForA).toContain('global thing');
    expect(nodesForA.filter((n) => n.canonical === 'shared convention')).toHaveLength(1);

    const filtered = await repo.listNodes(undefined, 'proj-list-a', 'shared');
    expect(filtered.map((n) => n.id)).toEqual([projA.id]);

    const scopedGlobalOnly = await repo.listNodes(['global'], 'proj-list-a', undefined);
    expect(scopedGlobalOnly.map((n) => n.id)).toEqual([globalNode.id]);

    const validObs = await repo.addObservation({
      nodeId: projA.id,
      text: 'Valid observation on the shared node.',
      scope: 'project',
      projectId: 'proj-list-a',
    });
    const invalidatedObs = await repo.addObservation({
      nodeId: projA.id,
      text: 'Observation that will be invalidated.',
      scope: 'project',
      projectId: 'proj-list-a',
    });
    await repo.invalidateObservation(invalidatedObs);

    const obsForA = await repo.listObservationsForNode(projA.id, 'proj-list-a');
    expect(obsForA.map((o) => o.id).sort()).toEqual([validObs, invalidatedObs].sort());
    const invalidatedRow = obsForA.find((o) => o.id === invalidatedObs);
    expect(invalidatedRow?.invalidatedAt).not.toBeNull();

    // proj-b must never see proj-a's project-scoped observations.
    expect(await repo.listObservationsForNode(projA.id, 'proj-list-b')).toHaveLength(0);
  });

  it('listWisdomRows filters by category, isolates cross-project, and reports total vs truncated rows', async () => {
    const nodeA = await repo.upsertNode({ canonical: 'wisdom a', kind: 'wisdom', scope: 'project', projectId: 'proj-w-a' });
    await repo.addObservation({
      nodeId: nodeA.id,
      text: 'Convention: use two spaces for indentation.',
      scope: 'project',
      projectId: 'proj-w-a',
      category: 'convention',
    });
    await repo.addObservation({
      nodeId: nodeA.id,
      text: 'Gotcha: watch out for timezone bugs.',
      scope: 'project',
      projectId: 'proj-w-a',
      category: 'gotcha',
    });
    const nodeB = await repo.upsertNode({ canonical: 'wisdom b', kind: 'wisdom', scope: 'project', projectId: 'proj-w-b' });
    await repo.addObservation({
      nodeId: nodeB.id,
      text: 'Convention only visible to project B.',
      scope: 'project',
      projectId: 'proj-w-b',
      category: 'convention',
    });

    const conventionsOnlyA = await repo.listWisdomRows(['convention'], 'proj-w-a', 30);
    expect(conventionsOnlyA.rows).toHaveLength(1);
    expect(conventionsOnlyA.rows[0]?.text).toContain('two spaces');
    expect(conventionsOnlyA.total).toBe(1);

    const bothCategoriesA = await repo.listWisdomRows(['convention', 'gotcha'], 'proj-w-a', 30);
    expect(bothCategoriesA.total).toBe(2);
    expect(bothCategoriesA.rows).toHaveLength(2);

    const truncated = await repo.listWisdomRows(['convention', 'gotcha'], 'proj-w-a', 1);
    expect(truncated.total).toBe(2);
    expect(truncated.rows).toHaveLength(1);

    const forB = await repo.listWisdomRows(['convention'], 'proj-w-b', 30);
    expect(forB.rows.map((r) => r.text)).toEqual(['Convention only visible to project B.']);
  });

  it('injectObservations / highConfidenceObservations / entityRoster filter per-scope and isolate cross-project', async () => {
    const globalNode = await repo.upsertNode({ canonical: 'inject global entity', kind: 'other', scope: 'global' });
    await repo.addObservation({
      nodeId: globalNode.id,
      text: 'A global fact for injection.',
      scope: 'global',
      confidence: 'high',
    });

    const projNode = await repo.upsertNode({
      canonical: 'inject project entity',
      kind: 'other',
      scope: 'project',
      projectId: 'proj-inject-a',
    });
    await repo.addObservation({
      nodeId: projNode.id,
      text: 'A high-confidence project fact.',
      scope: 'project',
      projectId: 'proj-inject-a',
      confidence: 'high',
    });
    await repo.addObservation({
      nodeId: projNode.id,
      text: 'A medium-confidence project fact.',
      scope: 'project',
      projectId: 'proj-inject-a',
      confidence: 'medium',
    });

    const privNode = await repo.upsertNode({
      canonical: 'inject private entity',
      kind: 'other',
      scope: 'private',
      projectId: 'proj-inject-a',
    });
    await repo.addObservation({
      nodeId: privNode.id,
      text: 'A private fact for this project only.',
      scope: 'private',
      projectId: 'proj-inject-a',
      confidence: 'low',
    });

    // Other project's data must never leak into proj-inject-a's queries.
    const otherProjNode = await repo.upsertNode({
      canonical: 'other project entity',
      kind: 'other',
      scope: 'project',
      projectId: 'proj-inject-b',
    });
    await repo.addObservation({
      nodeId: otherProjNode.id,
      text: 'A fact belonging to another project entirely.',
      scope: 'project',
      projectId: 'proj-inject-b',
      confidence: 'high',
    });

    const globalFacts = await repo.injectObservations('global', 'proj-inject-a', 50);
    expect(globalFacts.map((f) => f.text)).toEqual(['A global fact for injection.']);

    const projectFacts = await repo.injectObservations('project', 'proj-inject-a', 50);
    expect(projectFacts).toHaveLength(2);
    // Ordered high confidence first, then recency.
    expect(projectFacts[0]?.confidence).toBe('high');

    const privateFacts = await repo.injectObservations('private', 'proj-inject-a', 50);
    expect(privateFacts).toHaveLength(1);

    const otherProjectFacts = await repo.injectObservations('project', 'proj-inject-b', 50);
    expect(otherProjectFacts.map((f) => f.text)).toEqual(['A fact belonging to another project entirely.']);
    // proj-inject-a's query must never see proj-inject-b's facts.
    expect(projectFacts.map((f) => f.text)).not.toContain('A fact belonging to another project entirely.');

    const highConfProject = await repo.highConfidenceObservations('project', 'proj-inject-a', 50);
    expect(highConfProject).toHaveLength(1);
    expect(highConfProject[0]?.confidence).toBe('high');

    const highConfGlobal = await repo.highConfidenceObservations('global', 'proj-inject-a', 50);
    expect(highConfGlobal).toHaveLength(1);

    const roster = await repo.entityRoster('proj-inject-a');
    const rosterCanonicals = roster.map((r) => r.canonical);
    expect(rosterCanonicals).toContain('inject global entity');
    expect(rosterCanonicals).toContain('inject project entity');
    expect(rosterCanonicals).toContain('inject private entity');
    expect(rosterCanonicals).not.toContain('other project entity');
    const projectRow = roster.find((r) => r.canonical === 'inject project entity');
    expect(projectRow?.count).toBe(2);
  });
});
