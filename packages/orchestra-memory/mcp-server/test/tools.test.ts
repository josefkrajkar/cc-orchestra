import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type SqliteDatabase } from '../src/db/connection.js';
import { createRepository, type Repository } from '../src/db/repository.js';
import type { ToolContext } from '../src/tools/context.js';
import { handleSave } from '../src/tools/save.js';
import { handleSearch } from '../src/tools/search.js';
import { handleLink } from '../src/tools/link.js';
import { handleTraverse } from '../src/tools/traverse.js';
import { handleInspect } from '../src/tools/inspect.js';
import { handleInvalidate } from '../src/tools/invalidate.js';
import { handleStats } from '../src/tools/stats.js';
import { handleWisdomAdd, handleWisdomGet } from '../src/tools/wisdom-compat.js';
import { buildInjectOutput, runInject } from '../src/inject.js';

/** Builds a ToolContext for a given "server instance" project identity —
 * tests simulate different projects/sessions by constructing a fresh
 * context per call (per Finding 1's design: handlers stay directly
 * unit-testable without a real MCP/stdio round trip). */
const ctxFor = (ownProjectId: string | null): ToolContext => ({ ownProjectId });
const NO_PROJECT = ctxFor(null);

describe('mcp tools', () => {
  let db: SqliteDatabase;
  let repo: Repository;

  beforeEach(() => {
    db = openDb(':memory:');
    repo = createRepository(db);
  });

  it('memory_save -> memory_search roundtrip, with dedupe and rejection', () => {
    const saved = handleSave(
      repo,
      db,
      {
        facts: [
          {
            entity: { name: 'Orchestra plugin', kind: 'project' },
            text: 'Orchestra plugin uses SQLite for graph memory storage.',
            category: 'decision',
            confidence: 'high',
          },
          { entity: { name: '   ' }, text: 'irrelevant text' },
          { entity: { name: 'Something' }, text: '   ' },
          { entity: { name: 'Something Else' }, text: 'x'.repeat(600) },
        ],
        relations: [{ src: 'Orchestra plugin', predicate: 'uses', dst: 'SQLite' }],
        scope: 'global',
      },
      NO_PROJECT
    );

    expect(saved.summary.saved).toBe(1);
    expect(saved.summary.rejected).toBe(3);
    expect(saved.summary.relations).toBe(1);
    expect(saved.facts[1]?.reason).toBe('missing entity name');
    expect(saved.facts[2]?.reason).toBe('empty or whitespace-only text');
    expect(saved.facts[3]?.reason).toMatch(/exceeds 500 chars/);

    // Re-saving the exact same fact text is reported as a duplicate, not re-inserted.
    const dup = handleSave(
      repo,
      db,
      {
        facts: [
          {
            entity: { name: 'orchestra   plugin' }, // canonicalization-insensitive
            text: '  Orchestra plugin uses SQLite for graph memory storage.  ',
          },
        ],
        scope: 'global',
      },
      NO_PROJECT
    );
    expect(dup.summary.duplicate).toBe(1);
    expect(dup.summary.saved).toBe(0);

    const search = handleSearch(repo, db, { query: 'SQLite' }, NO_PROJECT);
    // Entity canonical names are normalized (lowercase/trimmed) by the repository.
    expect(search.text).toContain('orchestra plugin: Orchestra plugin uses SQLite');
    expect(search.text).toContain('orchestra plugin -uses-> sqlite');
    // Finding 2: observation lines carry a stable "#<id>" prefix.
    expect(search.text).toMatch(/^# Matches\n#\d+ \[global\|decision\|high\|/);
  });

  it('rejects scope "project"/"private" without project_id', () => {
    const result = handleSave(
      repo,
      db,
      {
        facts: [{ entity: { name: 'X' }, text: 'A fact that should not be written anywhere.' }],
        scope: 'project',
      },
      NO_PROJECT
    );
    expect(result.summary.saved).toBe(0);
    expect(result.error).toMatch(/requires project_id/);
  });

  it('scope isolation: private facts of project A are never visible to project B via memory_search', () => {
    handleSave(
      repo,
      db,
      {
        facts: [
          {
            entity: { name: 'Client Secret' },
            text: 'Client Secret project uses a bespoke auth flow only for clientalpha systems.',
          },
        ],
        scope: 'private',
        project_id: 'proj-a',
      },
      ctxFor('proj-a')
    );

    const asB = handleSearch(repo, db, { query: 'clientalpha', project_id: 'proj-b' }, ctxFor('proj-b'));
    expect(asB.text).toBe('No matching facts found.');

    const asNoProject = handleSearch(repo, db, { query: 'clientalpha' }, NO_PROJECT);
    expect(asNoProject.text).toBe('No matching facts found.');

    const asA = handleSearch(repo, db, { query: 'clientalpha', project_id: 'proj-a' }, ctxFor('proj-a'));
    expect(asA.text).toContain('clientalpha');
  });

  it('memory_link is idempotent and reused by memory_traverse for alias resolution', () => {
    handleSave(
      repo,
      db,
      {
        facts: [
          {
            entity: { name: 'Josef Krajkar', kind: 'person' },
            text: 'Josef Krajkar maintains the Orchestra plugin project.',
            aliases: ['Josef'],
          },
          {
            entity: { name: 'Orchestra plugin', kind: 'project' },
            text: 'Orchestra plugin is a multi-agent orchestration tool.',
          },
        ],
        scope: 'global',
      },
      NO_PROJECT
    );

    const firstLink = handleLink(
      repo,
      { src: 'Josef Krajkar', predicate: 'maintains', dst: 'Orchestra plugin', scope: 'global' },
      NO_PROJECT
    );
    const secondLink = handleLink(
      repo,
      { src: 'Josef Krajkar', predicate: 'maintains', dst: 'Orchestra plugin', scope: 'global' },
      NO_PROJECT
    );
    expect(firstLink.edge.created).toBe(true);
    expect(secondLink.edge.created).toBe(false);
    expect(secondLink.edge.edgeId).toBe(firstLink.edge.edgeId);

    // Traverse resolves the entity via its alias "josef" (case/whitespace-insensitive).
    const traverse = handleTraverse(repo, db, { entity: 'josef', depth: 1 }, NO_PROJECT);
    expect(traverse.text).toContain('Josef Krajkar maintains the Orchestra plugin project');
    // Entity canonical names are normalized (lowercase/trimmed) by the repository.
    expect(traverse.text).toContain('josef krajkar -maintains-> orchestra plugin');

    const notFound = handleTraverse(repo, db, { entity: 'nonexistent entity xyz' }, NO_PROJECT);
    expect(notFound.text).toMatch(/No entity found/);
  });

  it('memory_search never surfaces relation triples scoped to a different project', () => {
    handleSave(
      repo,
      db,
      {
        facts: [
          { entity: { name: 'Service X' }, text: 'Service X handles payment processing for proj-a only.' },
        ],
        scope: 'project',
        project_id: 'proj-a',
      },
      ctxFor('proj-a')
    );
    handleLink(
      repo,
      {
        src: 'Service X',
        predicate: 'depends_on',
        dst: 'Service Y',
        scope: 'project',
        project_id: 'proj-a',
      },
      ctxFor('proj-a')
    );

    const asA = handleSearch(repo, db, { query: 'payment processing', project_id: 'proj-a' }, ctxFor('proj-a'));
    expect(asA.text).toContain('service x -depends_on-> service y');

    const asB = handleSearch(repo, db, { query: 'payment processing', project_id: 'proj-b' }, ctxFor('proj-b'));
    expect(asB.text).toBe('No matching facts found.');
  });

  it('memory_invalidate by observation_id excludes the fact from later searches', () => {
    const ctx = ctxFor('proj-x');
    const saved = handleSave(
      repo,
      db,
      {
        facts: [
          { entity: { name: 'Backend Framework' }, text: 'Project currently uses Express as its backend framework.' },
        ],
        scope: 'project',
        project_id: 'proj-x',
      },
      ctx
    );
    const observationId = saved.facts[0]?.observationId;
    expect(observationId).toBeDefined();

    expect(handleSearch(repo, db, { query: 'Express', project_id: 'proj-x' }, ctx).text).toContain('Express');

    const invalidated = handleInvalidate(
      repo,
      db,
      { observation_id: observationId!, reason: 'migrated to Hono' },
      ctx
    );
    expect(invalidated.invalidatedIds).toEqual([observationId]);

    expect(handleSearch(repo, db, { query: 'Express', project_id: 'proj-x' }, ctx).text).toBe(
      'No matching facts found.'
    );
  });

  it('memory_invalidate by entity invalidates every valid observation for that entity', () => {
    const ctx = ctxFor('proj-y');
    handleSave(
      repo,
      db,
      {
        facts: [
          { entity: { name: 'Legacy Service' }, text: 'Legacy Service still runs on the old cluster today.' },
          { entity: { name: 'Legacy Service' }, text: 'Legacy Service exposes a REST API on port 8080.' },
        ],
        scope: 'project',
        project_id: 'proj-y',
      },
      ctx
    );

    const invalidated = handleInvalidate(repo, db, { entity: 'Legacy Service', project_id: 'proj-y' }, ctx);
    expect(invalidated.invalidatedIds).toHaveLength(2);

    expect(handleSearch(repo, db, { query: 'Legacy Service', project_id: 'proj-y' }, ctx).text).toBe(
      'No matching facts found.'
    );
  });

  it('memory_invalidate by observation_id rejects cross-project invalidation', () => {
    const ctxA = ctxFor('proj-inv-a');
    const ctxB = ctxFor('proj-inv-b');
    const saved = handleSave(
      repo,
      db,
      {
        facts: [{ entity: { name: 'A Only Fact' }, text: 'This fact belongs only to project A.' }],
        scope: 'project',
        project_id: 'proj-inv-a',
      },
      ctxA
    );
    const observationId = saved.facts[0]?.observationId!;

    const result = handleInvalidate(repo, db, { observation_id: observationId }, ctxB);
    expect(result.invalidatedIds).toEqual([]);
    expect(result.error).toMatch(/mismatch|different project/);

    // Fact must remain valid/visible to its own project afterwards.
    expect(handleSearch(repo, db, { query: 'belongs only', project_id: 'proj-inv-a' }, ctxA).text).toContain(
      'This fact belongs only to project A.'
    );
  });

  it('memory_stats reports scoped counts', () => {
    handleSave(
      repo,
      db,
      {
        facts: [{ entity: { name: 'Some Thing' }, text: 'Some thing exists globally for every project.' }],
        scope: 'global',
      },
      NO_PROJECT
    );
    const stats = handleStats(repo, {}, NO_PROJECT);
    expect(stats.text).toContain('nodes: total=');
    expect(stats.text).toContain('observations: total=');
  });

  it('wisdom_add -> wisdom_get roundtrip, grouped by category with a duplicate guard', () => {
    const ctx = ctxFor('proj-w');
    handleWisdomAdd(
      repo,
      db,
      {
        text: 'Always use path aliases instead of relative ../../ imports in this project.',
        category: 'convention',
        confidence: 'high',
        project_id: 'proj-w',
      },
      ctx
    );
    handleWisdomAdd(
      repo,
      db,
      {
        text: 'Prisma generate must run before tsc or type errors appear unexpectedly.',
        category: 'gotcha',
        project_id: 'proj-w',
      },
      ctx
    );
    // duplicate add should not create a second entry
    handleWisdomAdd(
      repo,
      db,
      {
        text: 'Always use path aliases instead of relative ../../ imports in this project.',
        category: 'convention',
        project_id: 'proj-w',
      },
      ctx
    );

    const wisdom = handleWisdomGet(db, { project_id: 'proj-w' }, ctx);
    expect(wisdom.text).toContain('Conventions');
    expect(wisdom.text).toContain('path aliases');
    expect(wisdom.text).toContain('Gotchas');
    expect(wisdom.text).toContain('Prisma generate');
    expect(wisdom.text.match(/path aliases/g)).toHaveLength(1);

    // wisdom from a different project must not leak in.
    const otherProject = handleWisdomGet(db, { project_id: 'proj-other' }, ctxFor('proj-other'));
    expect(otherProject.text).not.toContain('path aliases');
  });

  it('wisdom_add defaults to project scope (not global) and requires explicit opt-in for global', () => {
    const ctx = ctxFor('proj-wisdom-default');
    handleWisdomAdd(repo, db, { text: 'Project-scoped wisdom by default text.', category: 'convention' }, ctx);

    const own = handleWisdomGet(db, {}, ctx);
    expect(own.text).toContain('Project-scoped wisdom by default text');

    const otherCtx = ctxFor('proj-other-wisdom-default');
    const other = handleWisdomGet(db, {}, otherCtx);
    expect(other.text).not.toContain('Project-scoped wisdom by default text');

    // Explicit opt-in to global scope shares it everywhere.
    handleWisdomAdd(
      repo,
      db,
      { text: 'Globally-shared wisdom via explicit opt-in text.', category: 'convention', scope: 'global' },
      ctx
    );
    const otherAfterGlobal = handleWisdomGet(db, {}, otherCtx);
    expect(otherAfterGlobal.text).toContain('Globally-shared wisdom via explicit opt-in text');
  });

  it('wisdom_add/get round-trip private scope, confined to the owning project', () => {
    const ctx = ctxFor('proj-wisdom-private');
    handleWisdomAdd(
      repo,
      db,
      { text: 'Client-confidential wisdom fact text.', category: 'gotcha', scope: 'private' },
      ctx
    );

    const own = handleWisdomGet(db, {}, ctx);
    expect(own.text).toContain('Client-confidential wisdom fact text');

    const otherCtx = ctxFor('proj-other-wisdom-private');
    const other = handleWisdomGet(db, {}, otherCtx);
    expect(other.text).not.toContain('Client-confidential wisdom fact text');
  });

  it('memory_save supersession: excludes the old fact from search and memory_inspect shows the chain', () => {
    const ctx = ctxFor('proj-super');
    const saved = handleSave(
      repo,
      db,
      {
        facts: [
          { entity: { name: 'Backend Framework' }, text: 'Project currently uses Express as its backend framework.' },
        ],
        scope: 'project',
        project_id: 'proj-super',
      },
      ctx
    );
    const oldId = saved.facts[0]?.observationId;
    expect(oldId).toBeDefined();

    const replaced = handleSave(
      repo,
      db,
      {
        facts: [
          {
            entity: { name: 'Backend Framework' },
            text: 'Project migrated to Hono as its backend framework.',
            supersedes_observation_id: oldId,
          },
        ],
        scope: 'project',
        project_id: 'proj-super',
      },
      ctx
    );
    expect(replaced.facts[0]?.status).toBe('saved');
    expect(replaced.facts[0]?.supersededId).toBe(oldId);
    expect(replaced.text).toContain(`superseded #${oldId}`);

    const search = handleSearch(repo, db, { query: 'framework', project_id: 'proj-super' }, ctx);
    expect(search.text).not.toContain('Express');
    expect(search.text).toContain('Hono');

    const inspect = handleInspect(db, { project_id: 'proj-super', entity: 'Backend Framework' }, ctx);
    expect(inspect.text).toMatch(/superseded by #\d+/);
    expect(inspect.text).toContain('Express');
  });

  it('memory_save rejects an invalid supersedes_observation_id (missing or cross-project)', () => {
    const ctxA = ctxFor('proj-super-a');
    const ctxB = ctxFor('proj-super-b');

    const missing = handleSave(
      repo,
      db,
      {
        facts: [{ entity: { name: 'X' }, text: 'A fact that references a bogus supersede id.', supersedes_observation_id: 999999 }],
        scope: 'project',
        project_id: 'proj-super-a',
      },
      ctxA
    );
    expect(missing.facts[0]?.status).toBe('rejected');
    expect(missing.facts[0]?.reason).toMatch(/does not exist/);

    const savedA = handleSave(
      repo,
      db,
      {
        facts: [{ entity: { name: 'Cross Project Thing' }, text: 'proj-a fact about a cross project thing.' }],
        scope: 'project',
        project_id: 'proj-super-a',
      },
      ctxA
    );
    const aObsId = savedA.facts[0]?.observationId!;

    const crossProject = handleSave(
      repo,
      db,
      {
        facts: [
          {
            entity: { name: 'Cross Project Thing' },
            text: 'proj-b tries to supersede a fact it does not own.',
            supersedes_observation_id: aObsId,
          },
        ],
        scope: 'project',
        project_id: 'proj-super-b',
      },
      ctxB
    );
    expect(crossProject.facts[0]?.status).toBe('rejected');
    expect(crossProject.facts[0]?.reason).toMatch(/not visible/);

    // Round-2 P0 regression: a global-scope save must not be able to smuggle
    // in the victim's project_id and supersede their project-scoped fact —
    // ownership is checked against the server's own identity, and global
    // facts ignore caller-supplied project_id entirely.
    const globalBypass = handleSave(
      repo,
      db,
      {
        facts: [
          {
            entity: { name: 'Cross Project Thing' },
            text: 'proj-b tries the global-scope bypass to supersede a proj-a fact.',
            supersedes_observation_id: aObsId,
          },
        ],
        scope: 'global',
        project_id: 'proj-super-a',
      },
      ctxB
    );
    expect(globalBypass.facts[0]?.status).toBe('rejected');
    expect(globalBypass.facts[0]?.reason).toMatch(/not visible/);
  });

  it('Finding 1: rejects a caller-supplied project_id that differs from this server instance\'s own identity', () => {
    const ctx = ctxFor('proj-own');

    const saveResult = handleSave(
      repo,
      db,
      {
        facts: [{ entity: { name: 'Y' }, text: 'Attempted cross-project write should never land.' }],
        scope: 'project',
        project_id: 'proj-other',
      },
      ctx
    );
    expect(saveResult.summary.saved).toBe(0);
    expect(saveResult.error).toMatch(/project_id mismatch/);

    const searchResult = handleSearch(repo, db, { query: 'Attempted', project_id: 'proj-other' }, ctx);
    expect(searchResult.text).toMatch(/project_id mismatch/);

    const statsResult = handleStats(repo, { project_id: 'proj-other' }, ctx);
    expect(statsResult.text).toMatch(/project_id mismatch/);
  });

  it('Finding 1: omitting project_id defaults to this server instance\'s own project identity', () => {
    const ctx = ctxFor('proj-default');
    const saved = handleSave(
      repo,
      db,
      {
        facts: [{ entity: { name: 'Default Proj Fact' }, text: 'This fact should land under the default project id.' }],
        scope: 'project',
      },
      ctx
    );
    expect(saved.summary.saved).toBe(1);

    const search = handleSearch(repo, db, { query: 'default project id' }, ctx);
    expect(search.text).toContain('This fact should land under the default project id.');
  });

  it('Finding 1: fails closed for private scope when this server instance has no project identity', () => {
    const saved = handleSave(
      repo,
      db,
      {
        facts: [{ entity: { name: 'Z' }, text: 'Should never be saved as private with no project identity.' }],
        scope: 'private',
      },
      NO_PROJECT
    );
    expect(saved.summary.saved).toBe(0);
    expect(saved.error).toMatch(/no project identity/);

    const search = handleSearch(repo, db, { query: 'anything', scope_filter: ['private'] }, NO_PROJECT);
    expect(search.text).toMatch(/no project identity/);
  });

  it('buildInjectOutput orders by confidence/recency and returns "" when nothing to inject', () => {
    expect(buildInjectOutput(db, 'proj-empty', 9500)).toBe('');

    handleSave(
      repo,
      db,
      {
        facts: [{ entity: { name: 'Global Pref' }, text: 'The user prefers concise commit messages in general.' }],
        scope: 'global',
      },
      NO_PROJECT
    );
    handleSave(
      repo,
      db,
      {
        facts: [{ entity: { name: 'Proj Fact' }, text: 'This project uses pnpm as its package manager exclusively.' }],
        scope: 'project',
        project_id: 'proj-inject',
      },
      ctxFor('proj-inject')
    );
    handleSave(
      repo,
      db,
      {
        facts: [{ entity: { name: 'Proj Secret' }, text: 'This client requested no third-party analytics tools at all.' }],
        scope: 'private',
        project_id: 'proj-inject',
      },
      ctxFor('proj-inject')
    );

    const output = buildInjectOutput(db, 'proj-inject', 9500);
    expect(output).toContain('## Project facts');
    expect(output).toContain('pnpm');
    expect(output).toContain('## Global facts');
    expect(output).toContain('concise commit messages');
    expect(output).toContain('## Private facts (this project only)');
    expect(output).toContain('third-party analytics');
    expect(output).not.toContain('more facts');

    // A different project must never see proj-inject's private/project facts.
    const otherOutput = buildInjectOutput(db, 'proj-other-inject', 9500);
    expect(otherOutput).not.toContain('pnpm');
    expect(otherOutput).not.toContain('third-party analytics');
    expect(otherOutput).toContain('concise commit messages'); // global still surfaces
  });

  it('buildInjectOutput enforces the byte budget by truncating whole facts, never mid-line', () => {
    for (let i = 0; i < 25; i++) {
      handleSave(
        repo,
        db,
        {
          facts: [
            {
              entity: { name: `Fact Entity ${i}` },
              text: `This is project fact number ${i} describing something specific and moderately verbose to consume bytes.`,
            },
          ],
          scope: 'project',
          project_id: 'proj-budget',
        },
        ctxFor('proj-budget')
      );
    }

    const truncated = buildInjectOutput(db, 'proj-budget', 400);
    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThan(500);
    expect(truncated).toMatch(/\[\+\d+ more facts — use memory_search\]/);

    for (const line of truncated.split('\n')) {
      const isStructural = line === '' || line.startsWith('#') && !/^#\d/.test(line) || line.startsWith('[+');
      const isFactLine = /^#\d+ \[(global|project|private)\|/.test(line);
      expect(isStructural || isFactLine).toBe(true);
    }
  });

  it('runInject fails open (exit 0, no throw, no stdout) when the DB directory cannot be created', () => {
    const originalHome = process.env.HOME;
    const exitCodes: Array<number | undefined> = [];
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        exitCodes.push(code);
        return undefined as never;
      }) as typeof process.exit);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      // A path that cannot possibly be created (parent is a file-like dead end).
      process.env.HOME = '/dev/null/orchestra-memory-impossible-path';
      expect(() => runInject(['--inject', '--project-id', 'test1234'])).not.toThrow();
      expect(exitCodes).toEqual([0]);
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      process.env.HOME = originalHome;
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('runInject fails open (exit 0, no stdout) when --project-id is missing', () => {
    const exitCodes: Array<number | undefined> = [];
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        exitCodes.push(code);
        return undefined as never;
      }) as typeof process.exit);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      expect(() => runInject(['--inject'])).not.toThrow();
      expect(exitCodes).toEqual([0]);
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
