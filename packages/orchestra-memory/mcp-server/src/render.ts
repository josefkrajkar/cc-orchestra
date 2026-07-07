// Token-dense text rendering shared by the MCP tools. This is the only place
// that formats repository rows into strings the calling LLM will read, so
// keeping every tool's output consistent (one fact per line, triples as
// `src -predicate-> dst`) lives here rather than being reimplemented per tool.
import type { ExpandedNode, Scope, StatsResult } from './db/repository.js';

/** Minimal shape needed to render a single observation line; deliberately
 * structural (not tied to a single repository return type) so search,
 * traverse, and inspect can all feed it their own row shapes. */
export interface RenderableObservation {
  id: number;
  canonical: string;
  text: string;
  scope: Scope;
  category?: string | null;
  confidence: string;
  validFrom: string;
}

/** A graph edge resolved for display as a `src -predicate-> dst` triple. */
export interface RenderableEdge {
  srcCanonical: string;
  predicate: string;
  dstCanonical: string;
}

/** Renders one observation line with a stable `#<id>` prefix so the calling
 * LLM can reference a specific fact later (e.g. as memory_save's
 * supersedes_observation_id, or memory_invalidate's observation_id). */
export function renderObservationLine(row: RenderableObservation): string {
  const category = row.category ?? 'fact';
  return `#${row.id} [${row.scope}|${category}|${row.confidence}] ${row.canonical}: ${row.text}`;
}

export function renderEdgeLine(edge: RenderableEdge): string {
  return `${edge.srcCanonical} -${edge.predicate}-> ${edge.dstCanonical}`;
}

export interface SearchResultLikeRow extends Omit<RenderableObservation, 'id'> {
  observationId: number;
}

/** Per-related-node cap on rendered observations in the "Related (1 hop)"
 * section of memory_search and the non-root nodes of memory_traverse — keeps
 * a single hub node from drowning the output. Overflow is summarized with a
 * "(+N more — memory_inspect ...)" line instead of being silently dropped.
 * Exported so tests can assert against it rather than hardcoding "3". */
export const RELATED_OBS_CAP = 3;

export function renderSearchResults(
  results: SearchResultLikeRow[],
  expanded: ExpandedNode[],
  edges: RenderableEdge[]
): string {
  const lines: string[] = [];
  if (results.length > 0) {
    lines.push('# Matches');
    for (const row of results) lines.push(renderObservationLine({ ...row, id: row.observationId }));
  }

  const seenObsIds = new Set(results.map((r) => r.observationId));
  const relatedLines: string[] = [];
  for (const node of expanded) {
    const visibleObs = node.observations.filter((obs) => !seenObsIds.has(obs.id));
    if (visibleObs.length === 0) continue;
    for (const obs of visibleObs.slice(0, RELATED_OBS_CAP)) {
      relatedLines.push(
        renderObservationLine({
          id: obs.id,
          canonical: node.canonical,
          text: obs.text,
          scope: node.scope,
          category: obs.category,
          confidence: obs.confidence,
          validFrom: obs.validFrom,
        })
      );
    }
    if (visibleObs.length > RELATED_OBS_CAP) {
      relatedLines.push(`  (+${visibleObs.length - RELATED_OBS_CAP} more — memory_inspect "${node.canonical}")`);
    }
  }
  if (relatedLines.length > 0) {
    lines.push('# Related (1 hop)');
    lines.push(...relatedLines);
  }

  if (edges.length > 0) {
    lines.push('# Relations');
    for (const edge of edges) lines.push(renderEdgeLine(edge));
  }

  if (lines.length === 0) {
    return 'No matching facts found.';
  }
  return lines.join('\n');
}

export function renderTraverse(
  rootCanonical: string,
  depth: number,
  expanded: ExpandedNode[],
  edges: RenderableEdge[],
  rootId?: number
): string {
  const lines: string[] = [`# Traverse from "${rootCanonical}" (depth ${depth})`];
  for (const node of expanded) {
    if (node.observations.length === 0) {
      lines.push(`[${node.scope}|node] ${node.canonical} (no valid observations)`);
      continue;
    }
    // The root node (the entity memory_traverse was asked about) is rendered
    // uncapped — it was explicitly requested. Every other (related) node is
    // capped at RELATED_OBS_CAP so a hub node can't drown the output.
    // Compare by id when available: canonical text is only unique per
    // (scope, project), so two nodes in one traversal can share it.
    const isRoot = rootId !== undefined ? node.id === rootId : node.canonical === rootCanonical;
    const obsToRender = isRoot ? node.observations : node.observations.slice(0, RELATED_OBS_CAP);
    for (const obs of obsToRender) {
      lines.push(
        renderObservationLine({
          id: obs.id,
          canonical: node.canonical,
          text: obs.text,
          scope: node.scope,
          category: obs.category,
          confidence: obs.confidence,
          validFrom: obs.validFrom,
        })
      );
    }
    if (!isRoot && node.observations.length > RELATED_OBS_CAP) {
      lines.push(`  (+${node.observations.length - RELATED_OBS_CAP} more — memory_inspect "${node.canonical}")`);
    }
  }
  if (edges.length > 0) {
    lines.push('# Relations');
    for (const edge of edges) lines.push(renderEdgeLine(edge));
  }
  return lines.join('\n');
}

export interface FactOutcome {
  entity: string;
  /** 'near_duplicate': memory_save's semantic near-dup guard matched an
   * existing observation and skipped the insert; override with
   * "allow_near_duplicate" or "supersedes_observation_id". */
  status: 'saved' | 'duplicate' | 'near_duplicate' | 'rejected';
  observationId?: number;
  nodeId?: number;
  reason?: string;
  /** Set when this fact's save superseded an older observation
   * (memory_save's `supersedes_observation_id`) — the id of the observation
   * that was invalidated in favor of this new one. */
  supersededId?: number;
}

export interface RelationOutcome {
  src: string;
  predicate: string;
  dst: string;
  created: boolean;
  edgeId: number;
}

export interface SaveSummary {
  saved: number;
  duplicate: number;
  rejected: number;
  relations: number;
  /** Count of 'near_duplicate' fact outcomes. Optional/undefined (treated as
   * 0) so existing callers that don't produce near-duplicates (e.g. today's
   * memory_save) keep building a plain {saved,duplicate,rejected,relations}
   * object without a type error. */
  nearDuplicate?: number;
}

export function renderSaveResult(
  summary: SaveSummary,
  facts: FactOutcome[],
  relations: RelationOutcome[]
): string {
  const nearDuplicateCount = summary.nearDuplicate ?? 0;
  // Only append the near-duplicate count when it's non-zero, so the summary
  // line stays byte-identical to the pre-existing format for every caller
  // that never produces near-duplicates yet.
  const nearDuplicateNote = nearDuplicateCount > 0 ? `, near-duplicate ${nearDuplicateCount}` : '';
  const lines: string[] = [
    `Saved ${summary.saved}, duplicate ${summary.duplicate}${nearDuplicateNote}, rejected ${summary.rejected}, relations ${summary.relations}.`,
  ];
  for (const f of facts) {
    if (f.status === 'saved') {
      const supersedeNote = f.supersededId != null ? ` (saved+superseded #${f.supersededId})` : '';
      lines.push(`  saved [obs#${f.observationId}] ${f.entity}${supersedeNote}`);
    } else if (f.status === 'duplicate') {
      lines.push(`  duplicate [obs#${f.observationId}] ${f.entity} (already stored)`);
    } else if (f.status === 'near_duplicate') {
      lines.push(
        `  near-duplicate of [obs#${f.observationId}] ${f.entity} — pass allow_near_duplicate:true or supersedes_observation_id to save anyway`
      );
    } else {
      lines.push(`  rejected ${f.entity || '(no entity)'}: ${f.reason}`);
    }
  }
  for (const r of relations) {
    lines.push(`  ${r.created ? 'linked' : 'already linked'}: ${renderEdgeLine({ srcCanonical: r.src, predicate: r.predicate, dstCanonical: r.dst })}`);
  }
  return lines.join('\n');
}

export function renderLinkResult(edge: RelationOutcome): string {
  return `${edge.created ? 'Created' : 'Already exists'} (edge#${edge.edgeId}): ${renderEdgeLine({
    srcCanonical: edge.src,
    predicate: edge.predicate,
    dstCanonical: edge.dst,
  })}`;
}

export function renderStats(stats: StatsResult, projectId: string | null): string {
  const scopeLine = (label: string, byScope: Record<Scope, number>) =>
    `  ${label}: global=${byScope.global} project=${byScope.project} private=${byScope.private}`;
  const lines = [
    `# Memory stats${projectId ? ` (project_id=${projectId})` : ' (no project context)'}`,
    `nodes: total=${stats.nodes.total}`,
    scopeLine('by scope', stats.nodes.byScope),
    `observations: total=${stats.observations.total} invalidated=${stats.observations.invalidated} older_than_90_days=${stats.observations.olderThan90Days}`,
    scopeLine('by scope', stats.observations.byScope),
    `edges: total=${stats.edges.total} invalidated=${stats.edges.invalidated}`,
    scopeLine('by scope', stats.edges.byScope),
  ];
  if (stats.dbSizeBytes != null) {
    lines.push(`db size: ${stats.dbSizeBytes} bytes`);
  }
  return lines.join('\n');
}

export interface InspectObservationRow {
  id: number;
  text: string;
  category: string | null;
  confidence: string;
  source: string | null;
  validFrom: string;
  invalidatedAt: string | null;
  supersededBy: number | null;
}

export interface InspectNodeRow {
  id: number;
  canonical: string;
  kind: string;
  scope: Scope;
  projectId: string | null;
  projectLabel: string | null;
  observations: InspectObservationRow[];
}

/** The only human-readable (markdown) output in the system — a debug/trust
 * escape hatch showing full metadata that the token-dense renders omit. */
export function renderInspect(nodes: InspectNodeRow[]): string {
  if (nodes.length === 0) {
    return '## Memory Inspect\n\nNo matching nodes found.';
  }
  const lines: string[] = ['## Memory Inspect', ''];
  for (const node of nodes) {
    lines.push(
      `### ${node.canonical} (${node.kind}, scope: ${node.scope}${
        node.projectId ? `, project: ${node.projectLabel ?? node.projectId}` : ''
      })`
    );
    if (node.observations.length === 0) {
      lines.push('- _(no observations)_');
    }
    for (const obs of node.observations) {
      const status = obs.invalidatedAt
        ? `invalidated at ${obs.invalidatedAt}${obs.supersededBy ? `, superseded by #${obs.supersededBy}` : ''}`
        : 'valid';
      lines.push(
        `- **#${obs.id}** (${obs.category ?? 'fact'}, confidence: ${obs.confidence}, source: ${
          obs.source ?? 'unknown'
        }, valid_from: ${obs.validFrom}, ${status}): ${obs.text}`
      );
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export interface WisdomRow {
  category: string;
  text: string;
  confidence: string;
  validFrom: string;
}

const WISDOM_CATEGORY_ORDER = ['convention', 'gotcha', 'decision', 'failed_approach'];
const WISDOM_CATEGORY_LABEL: Record<string, string> = {
  convention: 'Conventions',
  gotcha: 'Gotchas',
  decision: 'Decisions',
  failed_approach: 'Failed Approaches',
};
const STALE_MS = 90 * 24 * 60 * 60 * 1000;

export function renderWisdom(rows: WisdomRow[]): string {
  if (rows.length === 0) {
    return 'No accumulated wisdom yet.';
  }
  const now = Date.now();
  const byCategory = new Map<string, WisdomRow[]>();
  for (const row of rows) {
    const key = row.category;
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key)!.push(row);
  }

  const lines: string[] = ['## Accumulated Wisdom'];
  const categories = [
    ...WISDOM_CATEGORY_ORDER.filter((c) => byCategory.has(c)),
    ...[...byCategory.keys()].filter((c) => !WISDOM_CATEGORY_ORDER.includes(c)),
  ];
  for (const category of categories) {
    const items = byCategory.get(category) ?? [];
    lines.push('', `### ${WISDOM_CATEGORY_LABEL[category] ?? category} (${items.length})`);
    for (const item of items) {
      const age = now - Date.parse(item.validFrom);
      const stale = Number.isFinite(age) && age > STALE_MS ? ' ⚠️ older than 90 days — consider reviewing' : '';
      lines.push(`- [${item.confidence}] ${item.text}${stale}`);
    }
  }
  return lines.join('\n');
}
