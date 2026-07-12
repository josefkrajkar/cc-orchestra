// Remote HTTP client implementing the `Repository` interface (see
// docs/design/remote-memory-plan.md sections 1-3, Task 1.3). This is the
// CLIENT side of the RPC boundary whose SERVER side is src/serve.ts (Task
// 1.2, built in parallel — this module does not import from it).
//
// Design (per the plan and task spec):
//   - Dependency injection, not env reads: callers (a later task, 1.4)
//     resolve URL/token/timeoutMs from config.ts and pass them in explicitly.
//     This keeps this module pure/testable without mutating process.env.
//   - Every one of the ~21 Repository methods is a thin one-line delegate to
//     a single private `call()` helper that owns all fetch/timeout/
//     error-handling logic, so callers get one consistent failure mode.
//   - Fail-open contract: ANY failure (timeout, network error, HTTP 5xx,
//     HTTP 401/403, any other non-2xx, or a malformed/unexpected response
//     body) throws `RemoteUnavailableError` — never a raw TypeError/
//     DOMException/AbortError. Callers (tool handlers, hooks) decide how to
//     degrade; this module's only job is to guarantee a single error type.
import type { Repository } from '../db/repository.js';
import { computeProjectId } from '../migrate.js';
import type { HealthResponse, MethodName, MethodParams, MethodResult } from './protocol.js';

export interface RemoteRepositoryOptions {
  /** Base URL, e.g. "http://127.0.0.1:8787" — no trailing /rpc, this module appends it. */
  url: string;
  /** Bearer token to send, if any (omit the header entirely if undefined). */
  token?: string;
  /** Per-request timeout in ms — REQUIRED, caller (a later task) resolves the
   * right default (1000 for MCP tools, 500 for --inject) via config.ts's
   * getTimeoutMs() and passes it in explicitly, so this module has no opinion
   * about which default applies to which call site. */
  timeoutMs: number;
}

/** Thrown for ANY failure to obtain a usable result from the remote server —
 * timeout, network error, HTTP 4xx/5xx, or a malformed response body. This is
 * the single seam every caller relies on to fail open; a caller that doesn't
 * catch it will see an unhandled rejection (intentional — this module never
 * decides how to degrade, only guarantees the error type is consistent). */
export class RemoteUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'RemoteUnavailableError';
  }
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | null | undefined)?.name === 'AbortError';
}

/** Extracts an inner `{ error: { message } }` message from a parsed JSON
 * body, if present, defaulting to a generic message otherwise. */
function extractErrorMessage(body: unknown, fallback: string): string {
  const message = (body as { error?: { message?: string } } | undefined)?.error?.message;
  return typeof message === 'string' && message.length > 0 ? message : fallback;
}

/** Strips trailing `undefined` entries from a params tuple before it's sent
 * over the wire — see the doc comment at this function's call site in
 * `call()` for the full "why" (JSON.stringify's array-vs-object undefined
 * asymmetry). Only trims from the END, and only actual `undefined` values —
 * a `null` anywhere (including trailing) is a meaningful value for several
 * Repository methods (e.g. `projectId: null` for global scope) and must be
 * preserved untouched. */
function trimTrailingUndefined(params: readonly unknown[]): unknown[] {
  let end = params.length;
  while (end > 0 && params[end - 1] === undefined) end--;
  return params.slice(0, end);
}

export function createRemoteRepository(opts: RemoteRepositoryOptions): Repository {
  // Client process identity, computed once at construction time (mirrors
  // server.ts's computeOwnProjectId() pattern: fail-safe to null, never
  // throws). Sent as a request-level header on every call as a
  // defense-in-depth identity assertion — "which client process is calling"
  // — distinct from (and sent alongside, never overriding) the project_id
  // embedded in each call's own `params`, which asserts "which project's
  // data this specific call concerns". In v1 these are the same value by
  // construction (callers already resolved project_id via resolveProjectId()
  // upstream), but the header exists independently for future server-side
  // cross-checking, not because the two could legitimately differ today.
  const ownProjectId = (() => {
    try {
      return computeProjectId(process.cwd());
    } catch {
      return null;
    }
  })();

  const endpoint = `${opts.url.replace(/\/+$/, '')}/rpc`;

  function buildHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(ownProjectId ? { 'x-orchestra-project-id': ownProjectId } : {}),
    };
  }

  async function call<M extends MethodName>(method: M, ...params: MethodParams<M>): Promise<MethodResult<M>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: buildHeaders(),
        // Trim trailing `undefined` entries before serializing: an omitted
        // optional trailing positional argument (e.g. repository.ts's
        // `listNodes(scopes, projectId, entityFilter, limit = 50)` called
        // without `limit`) arrives here as a literal `undefined` element in
        // the `params` array. `JSON.stringify` keeps a trailing `undefined`
        // ARRAY element and serializes it as `null` (unlike an object
        // property set to `undefined`, which it drops entirely) — so an
        // omitted argument would otherwise reach the server as an explicit
        // `null`, bypassing the callee's own JS default parameter and (for
        // numeric LIMIT-bound params) causing a node:sqlite "datatype
        // mismatch". Trimming restores "argument omitted" semantics on the
        // wire, matching a direct (non-RPC) call. This must NOT trim a
        // genuine `null` (e.g. `projectId: null` for global scope) — only
        // `undefined` — since `null` is itself a meaningful value for several
        // Repository methods. See test/remote-integration.test.ts (task-5.2)
        // for the characterization test that caught this.
        body: JSON.stringify({ method, params: trimTrailingUndefined(params) }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new RemoteUnavailableError(
        isAbortError(err)
          ? `orchestra-memory remote: ${method} timed out after ${opts.timeoutMs}ms`
          : `orchestra-memory remote: ${method} request failed`,
        err
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      throw new RemoteUnavailableError(`orchestra-memory remote: ${method} unauthorized (HTTP ${res.status})`);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new RemoteUnavailableError(`orchestra-memory remote: ${method} returned invalid JSON`, err);
    }

    if (!res.ok) {
      throw new RemoteUnavailableError(
        `orchestra-memory remote: ${method} failed: ${extractErrorMessage(body, `HTTP ${res.status}`)}`
      );
    }
    if (!body || typeof body !== 'object') {
      throw new RemoteUnavailableError(`orchestra-memory remote: ${method} returned a malformed response`);
    }
    if ('error' in (body as Record<string, unknown>)) {
      throw new RemoteUnavailableError(
        `orchestra-memory remote: ${method} failed: ${extractErrorMessage(body, 'unknown error')}`
      );
    }
    // A missing `result` key is NOT treated as malformed: void-returning
    // Repository methods (addAlias, invalidateObservation,
    // supersedeObservation, invalidateEdge, supersedeEdge) resolve to
    // `undefined` server-side, and serve.ts's `sendJson(res, 200, { result })`
    // serializes to a literal `{}` on the wire — `JSON.stringify` drops an
    // object property whose value is `undefined` entirely (the opposite
    // asymmetry from the array-trimming case above). A 2xx response with no
    // `error` key IS the success signal for this wire protocol, not the
    // presence of a `result` key. See test/remote-integration.test.ts
    // (task-5.2) for the characterization test that caught this.
    return (body as { result?: MethodResult<M> }).result as MethodResult<M>;
  }

  return {
    upsertNode: (input) => call('upsertNode', input),
    addAlias: (nodeId, alias) => call('addAlias', nodeId, alias),
    findSimilarNodes: (name, scope, projectId, limit) => call('findSimilarNodes', name, scope, projectId, limit),
    addObservation: (input) => call('addObservation', input),
    supersedeObservation: (oldId, newId) => call('supersedeObservation', oldId, newId),
    invalidateObservation: (id, hard) => call('invalidateObservation', id, hard),
    upsertEdge: (input) => call('upsertEdge', input),
    invalidateEdge: (id) => call('invalidateEdge', id),
    supersedeEdge: (oldId, newId) => call('supersedeEdge', oldId, newId),
    searchObservations: (input) => call('searchObservations', input),
    expandFromNodes: (nodeIds, depth, scopes, projectId) => call('expandFromNodes', nodeIds, depth, scopes, projectId),
    stats: (projectId) => call('stats', projectId),
    fetchVisibleEdges: (nodeIds, projectId) => call('fetchVisibleEdges', nodeIds, projectId),
    findSupersedeTarget: (id) => call('findSupersedeTarget', id),
    findNearDuplicate: (text, scope, projectId) => call('findNearDuplicate', text, scope, projectId),
    listNodes: (scopes, projectId, entityFilter, limit) => call('listNodes', scopes, projectId, entityFilter, limit),
    listObservationsForNode: (nodeId, projectId) => call('listObservationsForNode', nodeId, projectId),
    listWisdomRows: (categories, projectId, limit) => call('listWisdomRows', categories, projectId, limit),
    injectObservations: (scope, projectId, limit) => call('injectObservations', scope, projectId, limit),
    highConfidenceObservations: (scope, projectId, limit) =>
      call('highConfidenceObservations', scope, projectId, limit),
    entityRoster: (projectId) => call('entityRoster', projectId),
  };
}

/** Standalone health-probe helper for a later task (1.4) to use at startup,
 * before committing to remote mode. Same AbortController/timeout/
 * error-wrapping pattern as `call()` above: throws RemoteUnavailableError on
 * any network/timeout/non-200/malformed-JSON/missing-field failure. */
export async function probeHealth(url: string, timeoutMs: number): Promise<HealthResponse> {
  const endpoint = `${url.replace(/\/+$/, '')}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(endpoint, { method: 'GET', signal: controller.signal });
  } catch (err) {
    throw new RemoteUnavailableError(
      isAbortError(err)
        ? `orchestra-memory remote: health check timed out after ${timeoutMs}ms`
        : `orchestra-memory remote: health check request failed`,
      err
    );
  } finally {
    clearTimeout(timer);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new RemoteUnavailableError('orchestra-memory remote: health check returned invalid JSON', err);
  }

  if (!res.ok) {
    throw new RemoteUnavailableError(
      `orchestra-memory remote: health check failed: ${extractErrorMessage(body, `HTTP ${res.status}`)}`
    );
  }
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as Partial<HealthResponse>).ok !== 'boolean' ||
    typeof (body as Partial<HealthResponse>).schemaVersion !== 'string' ||
    typeof (body as Partial<HealthResponse>).serverVersion !== 'string'
  ) {
    throw new RemoteUnavailableError('orchestra-memory remote: health check returned a malformed response');
  }
  return body as HealthResponse;
}
