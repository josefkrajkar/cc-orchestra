// Shared wire-protocol types for the remote memory backend (see
// docs/design/remote-memory-plan.md sections 1-3). These types are the
// contract BOTH the future HTTP server (src/serve.ts, Task 1.2) and the
// future HTTP client (src/remote/client.ts, Task 1.3) import — this file
// does not implement either side.
//
// The server exposes `POST /rpc` with a `{ method, params }` body mapping
// 1:1 onto the existing `Repository` interface (src/db/repository.ts), plus
// `GET /health`. To avoid ever drifting from repository.ts (the single
// source of truth for method names/params/results), the param and result
// types below are DERIVED from the `Repository` interface itself via
// TypeScript mapped/utility types rather than hand-copied per method.
import type { Repository } from '../db/repository.js';

/** Wire protocol version — bump if the request/response envelope shape
 * itself changes (NOT the same thing as the DB schema_version in
 * connection.ts, which versions the data, not the transport). */
export const PROTOCOL_VERSION = 1;

export type MethodName = keyof Repository;

/** Positional argument tuple for a given Repository method — this is
 * exactly what goes in the wire request's `params` array. Note that some
 * methods (e.g. `searchObservations`) take a single input object rather
 * than several positional args; for those, `MethodParams<M>` is a
 * one-tuple `[SomeInput]`, which is still correct as "the params array to
 * send over the wire" — see PROJECT_ID_FIELD_BY_METHOD below for how the
 * server distinguishes the two shapes when validating project_id. */
export type MethodParams<M extends MethodName> = Parameters<Repository[M]>;

/** The resolved (un-Promise-wrapped) result for a given Repository method —
 * this is exactly what goes in the wire response's `result` field. */
export type MethodResult<M extends MethodName> = Awaited<ReturnType<Repository[M]>>;

export interface RpcRequest<M extends MethodName = MethodName> {
  method: M;
  params: MethodParams<M>;
}

export interface RpcSuccessResponse<M extends MethodName = MethodName> {
  result: MethodResult<M>;
}

export interface RpcErrorResponse {
  error: { message: string; code?: string };
}

export type RpcResponse<M extends MethodName = MethodName> = RpcSuccessResponse<M> | RpcErrorResponse;

/** Runtime list of every valid method name, generated FROM the Repository
 * interface's own key set at the type level but needing a literal runtime
 * array since TypeScript interfaces don't exist at runtime. Keep this array
 * in sync with the Repository interface by hand — there is no way to
 * derive a runtime string array from a compile-time-only interface.
 * test/protocol.test.ts asserts this array's contents/length match
 * `Object.keys(createRepository(...))` so a future repository.ts method
 * addition that forgets to update this list fails CI instead of silently
 * dropping a method from the remote surface. */
export const METHOD_NAMES: readonly MethodName[] = [
  'upsertNode',
  'addAlias',
  'findSimilarNodes',
  'addObservation',
  'supersedeObservation',
  'invalidateObservation',
  'upsertEdge',
  'invalidateEdge',
  'supersedeEdge',
  'searchObservations',
  'expandFromNodes',
  'stats',
  'fetchVisibleEdges',
  'findSupersedeTarget',
  'findNearDuplicate',
  'listNodes',
  'listObservationsForNode',
  'listWisdomRows',
  'injectObservations',
  'highConfidenceObservations',
  'entityRoster',
] as const;

/** Health check response shape for GET /health. */
export interface HealthResponse {
  ok: boolean;
  schemaVersion: string;
  serverVersion: string;
}

export function isValidMethodName(name: unknown): name is MethodName {
  return typeof name === 'string' && (METHOD_NAMES as readonly string[]).includes(name);
}

// --- project_id location map, for server-side request validation ----------
//
// Per the plan's trust-model section, the client asserts project_id per
// request and the server must validate it ("is a 16-char hex string" per
// computeProjectId's sha256-16 derivation, or null for global-only calls)
// before dispatching. Repository methods carry project_id in one of two
// shapes:
//
//   1. POSITIONAL — project_id is one element of the method's positional
//      argument tuple. `PROJECT_ID_PARAM_INDEX` maps the method name to the
//      0-based index of that argument in `params`.
//   2. OBJECT FIELD — the method takes a single input object (its own
//      `*Input` interface) with a `projectId` field. `PROJECT_ID_OBJECT_FIELD`
//      maps the method name to the field name to read off `params[0]`.
//
// Methods that take NO project id at all (addAlias, findSupersedeTarget,
// invalidateObservation, invalidateEdge, supersedeObservation, supersedeEdge)
// are omitted from both maps — the dispatcher should treat "absent from
// both maps" as "no project_id validation applies to this method", not as
// a bug.
//
// P0 security fix (docs/design/remote-memory-plan.md section 2): because
// these six methods carry no project_id, the params-vs-header project_id
// check below can't protect them — a bearer-token holder could otherwise
// invalidate/supersede/alias ANY row in ANY project by guessing small
// auto-increment ids, and use findSupersedeTarget as an oracle to learn a
// foreign row's projectId. src/serve.ts's handleRpc() closes this by
// resolving each referenced row's own scope/project_id (via
// findSupersedeTarget for observations, or the internal-only
// findNodeOwner/findEdgeOwner lookups on RepositoryInternal — see
// src/db/repository.ts) and rejecting (403) or filtering the result unless
// it's global or owned by the caller-asserted x-orchestra-project-id header.
//
// This lets a future server-side dispatcher (Task 1.2, not this task) look
// up where project_id lives for ANY method without special-casing each one
// by hand: check PROJECT_ID_PARAM_INDEX first, then PROJECT_ID_OBJECT_FIELD,
// then skip validation if the method appears in neither.

/** Methods whose project_id (or projectId) lives at a fixed positional
 * index in the `params` tuple. Indices verified against each method's
 * signature in src/db/repository.ts. */
export const PROJECT_ID_PARAM_INDEX: Partial<Record<MethodName, number>> = {
  findSimilarNodes: 2, // (name, scope, projectId?, limit?)
  expandFromNodes: 3, // (nodeIds, depth, scopes?, projectId?)
  stats: 0, // (projectId?)
  fetchVisibleEdges: 1, // (nodeIds, projectId)
  findNearDuplicate: 2, // (text, scope, projectId)
  listNodes: 1, // (scopes, projectId, entityFilter, limit?)
  listObservationsForNode: 1, // (nodeId, projectId)
  listWisdomRows: 1, // (categories, projectId, limit)
  injectObservations: 1, // (scope, projectId, limit)
  highConfidenceObservations: 1, // (scope, projectId, limit)
  entityRoster: 0, // (projectId)
};

/** Methods whose project_id lives on a field of the single input object
 * passed as `params[0]`. */
export const PROJECT_ID_OBJECT_FIELD: Partial<Record<MethodName, string>> = {
  upsertNode: 'projectId', // UpsertNodeInput.projectId
  addObservation: 'projectId', // AddObservationInput.projectId
  upsertEdge: 'projectId', // UpsertEdgeInput.projectId
  searchObservations: 'projectId', // SearchObservationsInput.projectId
};
