import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultDbPath, openDb, type SqliteDatabase } from '../src/db/connection.js';
import { createRepository, type Confidence, type Repository, type Scope } from '../src/db/repository.js';
import { buildInjectIndex, runInject } from '../src/inject.js';

/** Seeds one node with a single observation via direct repository calls
 * (bypassing memory_save/distillation) so tests get exact control over
 * scope, confidence, and valid_from ordering. */
async function seedFact(
  repo: Repository,
  opts: {
    canonical: string;
    scope: Scope;
    projectId?: string | null;
    text: string;
    confidence?: Confidence;
    validFrom: string;
  }
): Promise<{ nodeId: number; obsId: number }> {
  const node = await repo.upsertNode({
    canonical: opts.canonical,
    kind: 'fact',
    scope: opts.scope,
    projectId: opts.projectId ?? null,
  });
  const obsId = await repo.addObservation({
    nodeId: node.id,
    text: opts.text,
    scope: opts.scope,
    projectId: opts.projectId ?? null,
    confidence: opts.confidence ?? 'medium',
    validFrom: opts.validFrom,
  });
  return { nodeId: node.id, obsId };
}

const day = (n: number): string => `2024-01-${String(n).padStart(2, '0')}T00:00:00.000Z`;

describe('buildInjectIndex', () => {
  let db: SqliteDatabase;
  let repo: Repository;

  beforeEach(() => {
    db = openDb(':memory:');
    repo = createRepository(db);
  });

  it('returns "" for an empty database', async () => {
    expect(await buildInjectIndex(repo, 'proj-empty-idx', 2000)).toBe('');
  });

  it('pins only high-confidence facts, cross-scope, capped at 8, most-recent first', async () => {
    // 9 high-confidence facts spread across all three scopes visible to
    // proj-pin (3 project, 3 global, 3 private), staggered by day so a
    // strict recency order is unambiguous; the oldest of the 9 must be
    // dropped once capped at 8.
    const scopesInOrder: Scope[] = ['project', 'global', 'private', 'project', 'global', 'private', 'project', 'global', 'private'];
    for (let i = 0; i < 9; i++) {
      await seedFact(repo, {
        canonical: `High Fact ${i}`,
        scope: scopesInOrder[i]!,
        projectId: scopesInOrder[i] === 'global' ? null : 'proj-pin',
        text: `High confidence fact number ${i}.`,
        confidence: 'high',
        validFrom: day(i + 1), // day(1)..day(9), day(9) is most recent
      });
    }
    // A newer, but only medium-confidence, fact must never be pinned even
    // though it's the most recent observation overall.
    await seedFact(repo, {
      canonical: 'Medium Fact',
      scope: 'project',
      projectId: 'proj-pin',
      text: 'A medium-confidence fact that is newer than all high-confidence ones.',
      confidence: 'medium',
      validFrom: day(20),
    });
    // A high-confidence fact from a different project must never be pinned.
    await seedFact(repo, {
      canonical: 'Other Project High Fact',
      scope: 'project',
      projectId: 'proj-other',
      text: 'A high-confidence fact belonging to a different project.',
      confidence: 'high',
      validFrom: day(30),
    });

    const output = await buildInjectIndex(repo, 'proj-pin', 9500);
    expect(output).toContain('## Pinned (high-confidence)');

    // Isolate the Pinned section (rendered "canonical: text" lines) from the
    // Entities roster below it, which lists every fact ("canonical (count)")
    // regardless of confidence — the colon-vs-count-paren format tells them
    // apart, but slicing out the section avoids any ambiguity.
    const pinnedSection = output.split('## Entities')[0]!;

    // Top 8 by recency (i=1..8, i.e. high fact 8 down through high fact 1)
    // are pinned. Canonical names are normalized (lowercased) by the repository.
    for (let i = 1; i <= 8; i++) {
      expect(pinnedSection).toContain(`high fact ${i}:`);
    }
    // The oldest (i=0) is dropped once capped at 8.
    expect(pinnedSection).not.toContain('high fact 0:');
    // Never pinned regardless of recency/scope.
    expect(pinnedSection).not.toContain('medium fact');
    expect(pinnedSection).not.toContain('other project high fact');

    const pinnedLines = pinnedSection
      .split('\n')
      .filter((l) => /^#\d+ \[(global|project|private)\|/.test(l));
    expect(pinnedLines.length).toBe(8);
  });

  it('lists an entity roster with correct counts, only valid+visible observations, isolated by scope', async () => {
    // Node A: 2 valid + 1 invalidated observation for proj-a -> count 2.
    const a = await repo.upsertNode({ canonical: 'Node A', kind: 'fact', scope: 'project', projectId: 'proj-a' });
    await repo.addObservation({ nodeId: a.id, text: 'Node A fact one.', scope: 'project', projectId: 'proj-a', validFrom: day(1) });
    await repo.addObservation({ nodeId: a.id, text: 'Node A fact two.', scope: 'project', projectId: 'proj-a', validFrom: day(2) });
    const aInvalidId = await repo.addObservation({
      nodeId: a.id,
      text: 'Node A fact three (will be invalidated).',
      scope: 'project',
      projectId: 'proj-a',
      validFrom: day(3),
    });
    await repo.invalidateObservation(aInvalidId);

    // Node B: global, visible to any project.
    const b = await repo.upsertNode({ canonical: 'Node B', kind: 'fact', scope: 'global' });
    await repo.addObservation({ nodeId: b.id, text: 'Node B global fact.', scope: 'global', validFrom: day(4) });

    // Node C: another project's project-scoped fact — must not be visible to proj-a.
    const c = await repo.upsertNode({ canonical: 'Node C', kind: 'fact', scope: 'project', projectId: 'proj-other' });
    await repo.addObservation({ nodeId: c.id, text: 'Node C other-project fact.', scope: 'project', projectId: 'proj-other', validFrom: day(5) });

    // Node D: private to proj-a — must be visible/counted for proj-a.
    const d = await repo.upsertNode({ canonical: 'Node D', kind: 'fact', scope: 'private', projectId: 'proj-a' });
    await repo.addObservation({ nodeId: d.id, text: 'Node D private fact.', scope: 'private', projectId: 'proj-a', validFrom: day(6) });

    // Node E: only an invalidated observation -> zero valid observations, must not appear at all.
    const e = await repo.upsertNode({ canonical: 'Node E', kind: 'fact', scope: 'project', projectId: 'proj-a' });
    const eObsId = await repo.addObservation({ nodeId: e.id, text: 'Node E fact (will be invalidated).', scope: 'project', projectId: 'proj-a', validFrom: day(7) });
    await repo.invalidateObservation(eObsId);

    const output = await buildInjectIndex(repo, 'proj-a', 9500);
    expect(output).toContain('## Entities (facts)');
    expect(output).toContain('node a (2)');
    expect(output).toContain('node b (1)');
    expect(output).toContain('node d (1)');
    expect(output).not.toContain('node c');
    expect(output).not.toContain('node e');

    // A different project must never see proj-a's project/private facts,
    // but still sees the global one.
    const otherOutput = await buildInjectIndex(repo, 'proj-other-idx', 9500);
    expect(otherOutput).not.toContain('node a');
    expect(otherOutput).not.toContain('node d');
    expect(otherOutput).toContain('node b (1)');
  });

  it('enforces the byte budget by dropping whole entities and appending the overflow marker', async () => {
    for (let i = 0; i < 30; i++) {
      await seedFact(repo, {
        canonical: `Entity Number ${String(i).padStart(2, '0')}`,
        scope: 'project',
        projectId: 'proj-budget-idx',
        text: `This is fact number ${i} for the budget truncation test.`,
        confidence: 'medium', // never pinned, keeps this test isolated to the entities section
        validFrom: day((i % 28) + 1),
      });
    }

    const budget = 300;
    const output = await buildInjectIndex(repo, 'proj-budget-idx', budget);

    // The overflow marker itself (like buildInjectOutput's "[+N more facts]")
    // is appended after the budget check passes for all included items, so
    // the final size may slightly exceed budget by the marker's own length —
    // never by a whole extra entity.
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThan(budget + 100);
    expect(output).not.toContain('## Pinned');
    expect(output).toContain('## Entities (facts)');
    expect(output).toMatch(/\[\+\d+ more entities — memory_stats \/ memory_search\]/);

    // Never splits an entity mid-item: every "name (count)" token that
    // appears is complete, never a truncated fragment.
    const entityTokens = output.match(/entity number \d\d \(\d+\)/g) ?? [];
    expect(entityTokens.length).toBeGreaterThan(0);
    for (const token of entityTokens) {
      expect(token).toMatch(/^entity number \d\d \(\d+\)$/);
    }
  });
});

describe('runInject --inject-mode dispatch', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'orchestra-inject-mode-home-'));
    process.env.HOME = home;

    const db = openDb(defaultDbPath());
    try {
      const repo = createRepository(db);
      const node = await repo.upsertNode({ canonical: 'Runinject Sample', kind: 'fact', scope: 'global' });
      await repo.addObservation({
        nodeId: node.id,
        text: 'A globally visible sample fact for runInject dispatch tests.',
        scope: 'global',
        confidence: 'high',
        validFrom: day(1),
      });
    } finally {
      db.close();
    }
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function callInject(argv: string[]): Promise<string> {
    const stdoutChunks: string[] = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as unknown as typeof process.exit);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await runInject(argv);
    } finally {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
    return stdoutChunks.join('');
  }

  it('defaults to full-dump mode when --inject-mode is omitted', async () => {
    const output = await callInject(['--inject', '--project-id', 'idx-dispatch-full']);
    expect(output).toMatch(/^# Graph memory \(project idx-dispatch-full\)/);
    expect(output).not.toContain('# Graph memory index');
  });

  it('fails open to full-dump mode for an unknown --inject-mode value', async () => {
    const output = await callInject(['--inject', '--project-id', 'idx-dispatch-bogus', '--inject-mode', 'bogus']);
    expect(output).toMatch(/^# Graph memory \(project idx-dispatch-bogus\)/);
    expect(output).not.toContain('# Graph memory index');
  });

  it('selects the index builder for --inject-mode index', async () => {
    const output = await callInject(['--inject', '--project-id', 'idx-dispatch-index', '--inject-mode', 'index']);
    expect(output).toMatch(/^# Graph memory index \(project idx-dispatch-index\)/);
    expect(output).toContain('## Entities (facts)');
    expect(output).toContain('runinject sample (1)');
  });
});
