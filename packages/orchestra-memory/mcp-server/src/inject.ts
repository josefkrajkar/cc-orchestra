// CLI inject mode, consumed by Phase 3's SessionStart bash hook:
//   node dist/server.mjs --inject --project-id <key> [--budget <bytes>] [--inject-mode <index|full>]
//
// No MCP handshake — this opens the DB directly and prints plain text to
// stdout, then exits. Contract (see docs/design/graph-memory-design.md Phase 3):
//   1. project-scope valid facts for project_id (confidence desc, recency desc)
//   2. top-K global facts
//   3. private facts of THIS project only
// Byte-budget enforced by truncating whole facts (never mid-line); when
// truncated, appends "[+N more facts — use memory_search]".
//
// --inject-mode (D10: OFF by default, opt-in via ORCHESTRA_MEMORY_INJECT_MODE
// env var in the calling hook script until validated): 'full' (default) is
// the dump above; 'index' is a smaller "Pinned + entity roster" summary —
// see buildInjectIndex. Unknown/omitted values fail open to 'full'.
//
// Fail-open is the hard requirement here: on ANY error (missing project id,
// node:sqlite unavailable, corrupt DB, unexpected row shape) this must exit
// 0 with empty stdout and put diagnostics on stderr only — a broken memory
// layer must never break the SessionStart hook it's injected from.
//
// Remote mode (docs/design/remote-memory-plan.md Task 4.1): when
// ORCHESTRA_MEMORY_URL is set, this first attempts to build the injectable
// block from the remote HTTP backend (bounded by a 500ms default timeout,
// distinct from the MCP-tools path's 1000ms default — SessionStart must stay
// fast). On ANY failure of that attempt (unreachable server, timeout, HTTP
// error, malformed response, or an error thrown while rendering an
// unexpectedly-shaped result) this falls back to the local DB exactly as if
// ORCHESTRA_MEMORY_URL had never been set, and if the local DB is also
// unavailable, falls back further to empty output. When
// ORCHESTRA_MEMORY_URL is unset, this file's behavior is byte-for-byte
// unchanged from the local-only implementation — see tryRemoteInject()
// below for the remote attempt itself.
import { tryOpenDb } from './db/connection.js';
import { createRepository, type Repository } from './db/repository.js';
import { renderObservationLine } from './render.js';
import { getRemoteUrl, getClientToken, getTimeoutMs } from './config.js';
import { createRemoteRepository } from './remote/client.js';

const DEFAULT_BUDGET_BYTES = 9500;
// Index mode (D10: off by default, opt-in via ORCHESTRA_MEMORY_INJECT_MODE)
// aims for a ~500-token summary instead of a full dump, so its default
// budget is far smaller than full mode's.
const INDEX_DEFAULT_BUDGET_BYTES = 2000;

type InjectMode = 'index' | 'full';

interface InjectArgs {
  projectId: string | null;
  budget: number;
  mode: InjectMode;
}

function parseArgs(argv: string[]): InjectArgs {
  let projectId: string | null = null;
  let explicitBudget: number | null = null;
  let mode: InjectMode = 'full';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project-id') {
      projectId = argv[++i]?.trim() || null;
    } else if (arg === '--budget') {
      const parsed = Number(argv[++i]);
      if (Number.isFinite(parsed) && parsed > 0) explicitBudget = Math.floor(parsed);
    } else if (arg === '--inject-mode') {
      // Fail-open on unknown values: anything other than exactly 'index'
      // keeps the validated, ships-by-default full-dump behavior.
      mode = argv[++i] === 'index' ? 'index' : 'full';
    }
  }
  const budget = explicitBudget ?? (mode === 'index' ? INDEX_DEFAULT_BUDGET_BYTES : DEFAULT_BUDGET_BYTES);
  return { projectId, budget, mode };
}

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Max rendered width (bytes) of a single "Entities" line before wrapping
 * to the next one — purely a readability wrap, independent of the overall
 * byte budget (which is enforced separately, at whole-entity granularity). */
const ENTITY_LINE_WIDTH = 100;

const PINNED_CAP = 8;

/** Builds the injectable text block, enforcing the byte budget by dropping
 * whole trailing facts (never truncating mid-line). Returns '' if there is
 * nothing to inject. */
export async function buildInjectOutput(repo: Repository, projectId: string, budget: number): Promise<string> {
  const projectFacts = await repo.injectObservations('project', projectId, 300);
  const globalFacts = await repo.injectObservations('global', projectId, 50);
  const privateFacts = await repo.injectObservations('private', projectId, 300);

  const totalFacts = projectFacts.length + globalFacts.length + privateFacts.length;
  if (totalFacts === 0) return '';

  const header = `# Graph memory (project ${projectId}) — memory_search to expand.`;

  const sections: Array<{ title: string; lines: string[] }> = [];
  if (projectFacts.length > 0) {
    sections.push({ title: '## Project facts', lines: projectFacts.map(renderObservationLine) });
  }
  if (globalFacts.length > 0) {
    sections.push({ title: '## Global facts', lines: globalFacts.map(renderObservationLine) });
  }
  if (privateFacts.length > 0) {
    sections.push({
      title: '## Private facts (this project only)',
      lines: privateFacts.map(renderObservationLine),
    });
  }

  const kept: string[] = [header, ''];
  let usedBytes = byteLen(kept.join('\n'));
  let includedFacts = 0;
  let truncated = false;

  sectionLoop: for (const section of sections) {
    const headerCost = byteLen(section.title) + 1;
    if (usedBytes + headerCost > budget) {
      truncated = true;
      break;
    }
    kept.push(section.title);
    usedBytes += headerCost;
    for (const line of section.lines) {
      const cost = byteLen(line) + 1;
      if (usedBytes + cost > budget) {
        truncated = true;
        break sectionLoop;
      }
      kept.push(line);
      usedBytes += cost;
      includedFacts += 1;
    }
  }

  if (truncated) {
    kept.push(`[+${totalFacts - includedFacts} more facts — use memory_search]`);
  }

  return kept.join('\n');
}

/** Experimental (D10: ships OFF by default) lazy alternative to
 * buildInjectOutput: instead of dumping every visible fact, prints a small
 * "Pinned" slice of the highest-confidence facts plus a compact entity
 * roster the calling model can expand on demand via memory_search. Aims
 * for roughly a ~500-token footprint (default budget: 2000 bytes) rather
 * than a full dump. Same never-truncate-mid-item budget discipline as
 * buildInjectOutput. Returns '' if there is nothing visible to inject. */
export async function buildInjectIndex(repo: Repository, projectId: string, budget: number): Promise<string> {
  const pinned = [
    ...(await repo.highConfidenceObservations('project', projectId, PINNED_CAP)),
    ...(await repo.highConfidenceObservations('global', projectId, PINNED_CAP)),
    ...(await repo.highConfidenceObservations('private', projectId, PINNED_CAP)),
  ]
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom))
    .slice(0, PINNED_CAP);

  const entities = await repo.entityRoster(projectId);
  if (entities.length === 0) return '';

  const header = `# Graph memory index (project ${projectId}) — memory_search <entity> to expand.`;
  const kept: string[] = [header, ''];
  let usedBytes = byteLen(kept.join('\n'));

  if (pinned.length > 0) {
    const title = '## Pinned (high-confidence)';
    const titleCost = byteLen(title) + 1;
    if (usedBytes + titleCost <= budget) {
      kept.push(title);
      usedBytes += titleCost;
      for (const obs of pinned) {
        const line = renderObservationLine(obs);
        const cost = byteLen(line) + 1;
        if (usedBytes + cost > budget) break;
        kept.push(line);
        usedBytes += cost;
      }
    }
  }

  const entityTitle = '## Entities (facts)';
  const entityTitleCost = byteLen(entityTitle) + 1;
  let includedEntities = 0;
  if (usedBytes + entityTitleCost <= budget) {
    kept.push(entityTitle);
    usedBytes += entityTitleCost;

    // Packs "canonical (count)" items onto wrapped lines (joined by " · "),
    // checking the overall byte budget at whole-item granularity so an
    // item is never split mid-way — only ever dropped whole, from the end.
    let openLineIdx = -1;
    for (const row of entities) {
      const item = `${row.canonical} (${row.count})`;
      const openLine = openLineIdx === -1 ? null : kept[openLineIdx]!;
      const isNewLine = openLine === null || byteLen(`${openLine} · ${item}`) > ENTITY_LINE_WIDTH;
      const newLine = isNewLine ? item : `${openLine} · ${item}`;
      const prevLineCost = isNewLine ? 0 : byteLen(openLine!) + 1;
      const newLineCost = byteLen(newLine) + 1;
      if (usedBytes - prevLineCost + newLineCost > budget) break;

      usedBytes = usedBytes - prevLineCost + newLineCost;
      if (isNewLine) {
        kept.push(newLine);
        openLineIdx = kept.length - 1;
      } else {
        kept[openLineIdx] = newLine;
      }
      includedEntities += 1;
    }

    if (includedEntities < entities.length) {
      kept.push(`[+${entities.length - includedEntities} more entities — memory_stats / memory_search]`);
    }
  }

  return kept.join('\n');
}

/**
 * Attempts to build the inject payload from the remote HTTP backend (Task
 * 4.1). Returns the rendered string on success — which may legitimately be
 * `''` if there is simply nothing to inject for this project — or `null` as
 * a sentinel meaning "the attempt failed, the caller must fall back to the
 * local DB (or empty)".
 *
 * Design choice — deliberately NO separate `probeHealth()` call before the
 * real data fetch, unlike server.ts's `selectRepo()` (which probes /health
 * once at MCP-server startup and amortizes that single round trip over the
 * whole stdio session's lifetime). `--inject` instead runs fresh on every
 * SessionStart under a tight ~500ms budget, so a probe-then-fetch sequence
 * would spend that budget on TWO sequential round trips instead of one.
 * `remote/client.ts`'s `call()` already wraps every timeout/network/HTTP-
 * error/malformed-JSON failure uniformly in `RemoteUnavailableError`, which
 * the catch-all below treats as "fall back". The one gap this leaves is a
 * schema-mismatched server that responds with a well-formed HTTP 200 whose
 * `result` is a differently-shaped row (rather than erroring cleanly) — in
 * that specific case `renderObservationLine`/the byte-budget loop inside
 * buildInjectOutput/buildInjectIndex may throw on the unexpected shape,
 * which is still caught by the try/catch here and still degrades to
 * local-db-or-empty. Given --inject's low-stakes, always-falls-back-anyway
 * contract, catching that error generically is an acceptable trade for
 * keeping this to a single round trip; server.ts's MCP-tools path (which
 * stays alive for a whole session and can afford the extra latency once at
 * startup) is where the explicit schemaVersion check earns its cost.
 */
async function tryRemoteInject(
  remoteUrl: string,
  projectId: string,
  budget: number,
  mode: InjectMode
): Promise<string | null> {
  try {
    const remoteRepo = createRemoteRepository({
      url: remoteUrl,
      token: getClientToken(),
      timeoutMs: getTimeoutMs(500),
    });
    return mode === 'index'
      ? await buildInjectIndex(remoteRepo, projectId, budget)
      : await buildInjectOutput(remoteRepo, projectId, budget);
  } catch (err) {
    try {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `orchestra-memory --inject: remote backend unavailable, falling back to local DB (${message})\n`
      );
    } catch {
      // stderr itself failed — nothing more we can do; still fall back.
    }
    return null;
  }
}

/** Entry point for `node dist/server.mjs --inject ...`. Never throws —
 * always exits 0, printing the injectable block (if any) to stdout and
 * diagnostics (if any) to stderr only. */
export async function runInject(argv: string[]): Promise<void> {
  try {
    const { projectId, budget, mode } = parseArgs(argv);
    if (!projectId) {
      process.stderr.write('orchestra-memory --inject: missing --project-id, nothing to inject\n');
    } else {
      // Sentinel: null means "no successful output yet, try/fall back to
      // the next tier"; '' means "succeeded, nothing to inject" and must
      // NOT fall through to the local DB (see tryRemoteInject's doc comment).
      let output: string | null = null;
      const remoteUrl = getRemoteUrl();
      if (remoteUrl) {
        output = await tryRemoteInject(remoteUrl, projectId, budget, mode);
      }
      if (output === null) {
        const { db, diagnostic } = tryOpenDb();
        if (!db) {
          if (diagnostic) process.stderr.write(`${diagnostic}\n`);
        } else {
          const repo = createRepository(db);
          output =
            mode === 'index' ? await buildInjectIndex(repo, projectId, budget) : await buildInjectOutput(repo, projectId, budget);
        }
      }
      if (output) process.stdout.write(output);
    }
    // Single exit point: tests mock process.exit as a no-op, so early exits
    // must not be followed by more work (or exit would fire twice).
    process.exit(0);
  } catch (err) {
    try {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`orchestra-memory --inject failed (fail-open, exiting 0): ${message}\n`);
    } catch {
      // stderr itself failed — nothing more we can do; still fail open.
    }
    process.exit(0);
  }
}
