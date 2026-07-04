// Trust-boundary context shared by every tool handler (Finding 1 of the
// graph-memory review): the server binds to its OWN project identity at
// startup (see server.ts's computeOwnProjectId(), which reuses migrate.ts's
// computeProjectId() so the derivation is identical everywhere in the
// plugin). Handlers must never simply trust a caller-supplied project_id —
// they resolve it against this context instead.
//
// Handlers stay directly unit-testable: tests construct a ToolContext per
// call (e.g. `{ ownProjectId: 'proj-a' }` vs `{ ownProjectId: 'proj-b' }`) to
// simulate different server instances/projects without going through MCP.
import type { Scope } from '../db/repository.js';

export interface ToolContext {
  /** sha256-16 of this server process's cwd, or null if cwd was unavailable
   * (should not happen in practice) — see server.ts's computeOwnProjectId(). */
  ownProjectId: string | null;
}

export interface ProjectIdOk {
  ok: true;
  /** The project_id to actually use for this call: the caller's own project
   * (defaulted from context when omitted), or null if there is none. */
  projectId: string | null;
}

export interface ProjectIdMismatch {
  ok: false;
  message: string;
}

export type ProjectIdResolution = ProjectIdOk | ProjectIdMismatch;

/**
 * Enforces the Finding 1 trust boundary for any handler argument named
 * `project_id`:
 *   - omitted (undefined/empty)      -> defaults to ctx.ownProjectId
 *   - supplied and === ownProjectId  -> fine, use it
 *   - supplied and !== ownProjectId  -> rejected (cross-project access
 *                                       to project/private scopes is not
 *                                       permitted, no matter how the caller
 *                                       learned/guessed the other id)
 * "global" scope is unaffected by this check — it is never gated by
 * project_id in the first place.
 */
export function resolveProjectId(
  ctx: ToolContext,
  supplied: string | undefined | null
): ProjectIdResolution {
  if (supplied == null || supplied === '') {
    return { ok: true, projectId: ctx.ownProjectId };
  }
  if (supplied === ctx.ownProjectId) {
    return { ok: true, projectId: supplied };
  }
  return {
    ok: false,
    message:
      `project_id mismatch: this server instance is bound to ` +
      `${ctx.ownProjectId ?? '(no project identity available)'}; cross-project access to ` +
      `project/private scopes is not permitted.`,
  };
}

/** Message used whenever private scope is denied because this server
 * instance has no project identity (cwd unavailable) — fail-closed per
 * Finding 1: with no identity, there is no project to own private data, so
 * private reads/writes are refused outright rather than silently resolving
 * to a null/empty project. */
export function privateDeniedMessage(): string {
  return (
    'private scope is not permitted: this server instance has no project identity ' +
    '(cwd unavailable) — private reads/writes are disabled until it does.'
  );
}

/** True if the given scope or scope set includes "private" while this
 * server instance has no project identity to own it under. */
export function isPrivateDenied(
  ctx: ToolContext,
  scopes: Scope | Scope[] | undefined | null
): boolean {
  if (ctx.ownProjectId != null) return false;
  if (scopes == null) return false;
  return Array.isArray(scopes) ? scopes.includes('private') : scopes === 'private';
}
