// HTTP server for the remote memory backend (`--serve-http` mode). See
// docs/design/remote-memory-plan.md sections 1-3 for the wire protocol,
// trust model, and env surface this implements.
//
// This file is deliberately the "home" of server-identity concerns
// (SERVER_VERSION lives here, not in server.ts) to keep the module
// dependency direction one-way: server.ts imports `startServeHttp` (and
// `SERVER_VERSION`) FROM serve.ts. If SERVER_VERSION lived in server.ts
// instead, serve.ts would need to import it back, creating an import
// cycle (server.ts -> serve.ts -> server.ts). Defining it here avoids that
// entirely.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { openDb, SCHEMA_VERSION } from './db/connection.js';
import { createRepository, type OwnerRow, type RepositoryInternal } from './db/repository.js';
import { getAllowedOrigins, getDbPath, getListenAddress, getServerToken } from './config.js';
import {
  isValidMethodName,
  PROJECT_ID_OBJECT_FIELD,
  PROJECT_ID_PARAM_INDEX,
  type HealthResponse,
  type MethodName,
} from './remote/protocol.js';

/** orchestra-memory server identity, shared by the MCP stdio server (which
 * imports this constant from here — see the file-header note above) and
 * this HTTP server's /health response. */
export const SERVER_VERSION = '0.3.0';

/** Hard cap on POST /rpc request bodies. There's no body-parsing library in
 * this zero-runtime-deps package, so the accumulation below is manual —
 * this cap bounds the memory a single misbehaving/malicious request can
 * force the process to buffer. */
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB

const PROJECT_ID_RE = /^[0-9a-f]{16}$/;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Hosts treated as "loopback" for the no-token-configured startup safety
 * check below. Deliberately an exact-match allowlist (not a resolver) — see
 * that check's comment for why arbitrary hostname resolution is out of
 * scope. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Constant-time bearer-token comparison. Raw tokens are hashed to a
 * fixed-size SHA-256 digest first, because `timingSafeEqual` requires
 * equal-length buffers and would throw a RangeError comparing two raw
 * strings of different lengths (which a wrong guess almost always is) —
 * hashing first avoids both the length mismatch and the underlying timing
 * side-channel on token length/prefix. */
function safeTokenEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

class BodyTooLargeError extends Error {}
class InvalidJsonError extends Error {}

/** Manually accumulates the request body (no body-parsing library available)
 * and parses it as JSON, enforcing MAX_BODY_BYTES. Rejects with
 * BodyTooLargeError / InvalidJsonError for the two expected failure modes so
 * the caller can map them to the right HTTP status; any other rejection
 * (e.g. a raw stream error) is left to bubble up to the outer catch-all. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        settle(() => reject(new BodyTooLargeError('request body exceeds MAX_BODY_BYTES')));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed: unknown = JSON.parse(raw);
        settle(() => resolve(parsed));
      } catch {
        settle(() => reject(new InvalidJsonError('invalid JSON body')));
      }
    });

    req.on('error', (err) => {
      settle(() => reject(err));
    });
  });
}

/** Looks up whether/where a given method's params carry a project_id, per
 * remote/protocol.ts's PROJECT_ID_PARAM_INDEX / PROJECT_ID_OBJECT_FIELD
 * maps. `present: false` means "no project_id validation applies to this
 * method" (method absent from both maps) OR "the value found was null/
 * undefined" (the legitimate no-project/global-scope case) — both are
 * treated identically by the caller (skip the format check). */
function extractProjectId(method: MethodName, params: unknown[]): { present: boolean; value: unknown } {
  const paramIndex = PROJECT_ID_PARAM_INDEX[method];
  if (paramIndex !== undefined) {
    const value = params[paramIndex];
    return { present: value !== null && value !== undefined, value };
  }
  const fieldName = PROJECT_ID_OBJECT_FIELD[method];
  if (fieldName !== undefined) {
    const obj = params[0] as Record<string, unknown> | undefined;
    const value = obj?.[fieldName];
    return { present: value !== null && value !== undefined, value };
  }
  return { present: false, value: undefined };
}

async function handleRpc(repo: RepositoryInternal, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: { message: 'request body too large' } });
      return;
    }
    if (err instanceof InvalidJsonError) {
      sendJson(res, 400, { error: { message: 'invalid JSON body' } });
      return;
    }
    throw err;
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as Record<string, unknown>).method !== 'string' ||
    !Array.isArray((body as Record<string, unknown>).params)
  ) {
    sendJson(res, 400, {
      error: { message: 'malformed request: expected { method: string, params: array }' },
    });
    return;
  }

  const method = (body as { method: string }).method;
  const params = (body as { params: unknown[] }).params;

  // ---------------------------------------------------------------------
  // AUTH (Task 2.1): Origin check first, then bearer check. Both happen
  // before any method-name/project_id validation below. GET /health is
  // intentionally exempt from all of this (see its own comment).
  // ---------------------------------------------------------------------

  const origin = req.headers.origin;
  if (origin) {
    const allowedOrigins = getAllowedOrigins();
    if (!allowedOrigins.includes(origin)) {
      sendJson(res, 403, { error: { message: 'origin not allowed' } });
      return;
    }
  }

  const serverToken = getServerToken();
  if (serverToken !== undefined) {
    const authHeader = req.headers.authorization;
    const BEARER_PREFIX = 'Bearer ';
    if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
      console.error('orchestra-memory --serve-http: request rejected: unauthorized');
      sendJson(res, 401, { error: { message: 'unauthorized' } });
      return;
    }
    const receivedToken = authHeader.slice(BEARER_PREFIX.length);
    if (!safeTokenEquals(receivedToken, serverToken)) {
      console.error('orchestra-memory --serve-http: request rejected: unauthorized');
      sendJson(res, 401, { error: { message: 'unauthorized' } });
      return;
    }
  }
  // If serverToken is unset, there is nothing to compare against — this is
  // only reachable in practice because of the startup loopback-only
  // enforcement in createServeHttpServer() below.

  // ---------------------------------------------------------------------
  // HEADER VALIDATION (P0 security fix): the client (src/remote/client.ts)
  // always asserts its own project identity via the `x-orchestra-project-id`
  // header. The server requires and format-validates it here, BEFORE method
  // validation, so every subsequent step (including the ownership
  // enforcement below) can rely on a well-formed value being present. This
  // header is what makes the ownership checks below possible at all for the
  // six id-based methods that carry no project_id of their own — see
  // remote/protocol.ts's PROJECT_ID_PARAM_INDEX/PROJECT_ID_OBJECT_FIELD
  // comment.
  // ---------------------------------------------------------------------
  const rawHeaderProjectId = req.headers['x-orchestra-project-id'];
  const headerProjectId = Array.isArray(rawHeaderProjectId) ? rawHeaderProjectId[0] : rawHeaderProjectId;
  if (!headerProjectId || !PROJECT_ID_RE.test(headerProjectId)) {
    sendJson(res, 400, { error: { message: 'missing or malformed x-orchestra-project-id header' } });
    return;
  }

  if (!isValidMethodName(method)) {
    sendJson(res, 400, { error: { message: `unknown method: ${method}`, code: 'UNKNOWN_METHOD' } });
    return;
  }

  const projectId = extractProjectId(method, params);
  if (projectId.present && !PROJECT_ID_RE.test(projectId.value as string)) {
    sendJson(res, 400, { error: { message: 'invalid project_id format' } });
    return;
  }
  // Defense-in-depth: when the method's own params carry a project_id, it
  // must agree with the header the client asserted for this request — a
  // caller must not be able to send one project_id in the header (used below
  // for the id-based ownership checks) and a different one in params.
  if (projectId.present && projectId.value !== headerProjectId) {
    sendJson(res, 403, {
      error: { message: 'project_id mismatch: params project_id does not match x-orchestra-project-id header' },
    });
    return;
  }

  // ---------------------------------------------------------------------
  // OWNERSHIP (P0 security fix, docs/design/remote-memory-plan.md section 2):
  // six Repository methods take a raw id (or node id) with NO project_id
  // param — addAlias, findSupersedeTarget, invalidateObservation,
  // invalidateEdge, supersedeObservation, supersedeEdge. Locally, tool
  // handlers (tools/save.ts, tools/invalidate.ts) fetch the target row first
  // and check scope/projectId against the caller's own identity before
  // mutating; that check never ran for a bearer-token holder calling /rpc
  // directly, letting them invalidate/supersede/alias ANY row in ANY project
  // by enumerating small auto-increment ids, and using findSupersedeTarget as
  // an oracle to learn a foreign row's projectId. This block re-applies the
  // same rule server-side, keyed off the caller-asserted headerProjectId
  // validated above — global rows are visible/mutable by anyone holding the
  // bearer token; project/private rows only by the owning project.
  //
  // findSupersedeTarget is handled specially: it's a *read*, and its local
  // callers (save.ts/invalidate.ts) already treat "row not visible" the same
  // as "row not found" (see their doc comments) — so instead of a 403 here,
  // an invisible row's result is simply nulled out, preserving that exact
  // client-side behavior instead of turning an ordinary "does not exist"
  // check into a hard error.
  // ---------------------------------------------------------------------
  function isOwned(row: OwnerRow | undefined): boolean {
    return row !== undefined && (row.scope === 'global' || row.projectId === headerProjectId);
  }

  // P3 polish (sentinel review): the six id-based methods below used to cast
  // `params[i] as number` directly and let a malformed/missing id fall
  // through to whatever the downstream repo call (or its SQL) did with a
  // non-numeric value — typically an opaque 500, not a client-diagnosable
  // 400. `expectIntegerParams` validates shape/type up front so a caller
  // sending e.g. a string, a float, or too few params gets a clean 400
  // instead. This only validates the leading numeric id(s) each method
  // needs for the ownership lookup above/below it, not the full params
  // array — the downstream repo call still validates anything else (e.g.
  // addAlias's alias string, invalidateObservation's optional `hard` flag).
  function expectIntegerParams(count: number): number[] | null {
    if (params.length < count) return null;
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const value = params[i];
      if (typeof value !== 'number' || !Number.isInteger(value)) return null;
      ids.push(value);
    }
    return ids;
  }

  const ID_PARAM_COUNT: Partial<Record<MethodName, number>> = {
    findSupersedeTarget: 1,
    invalidateObservation: 1,
    supersedeObservation: 2,
    invalidateEdge: 1,
    supersedeEdge: 2,
    addAlias: 1, // only nodeId is id-shaped; addAlias's alias (params[1]) is validated downstream
  };
  const idParamCount = ID_PARAM_COUNT[method];
  if (idParamCount !== undefined && expectIntegerParams(idParamCount) === null) {
    sendJson(res, 400, { error: { message: `${method}: expected ${idParamCount} integer id param(s)` } });
    return;
  }

  if (method === 'findSupersedeTarget') {
    const target = await repo.findSupersedeTarget(params[0] as number);
    sendJson(res, 200, { result: isOwned(target) ? target : null });
    return;
  }

  if (method === 'invalidateObservation' || method === 'supersedeObservation') {
    const ids = method === 'supersedeObservation' ? [params[0] as number, params[1] as number] : [params[0] as number];
    for (const id of ids) {
      const row = await repo.findSupersedeTarget(id);
      if (!isOwned(row)) {
        sendJson(res, 403, { error: { message: `observation #${id} is not visible to this project` } });
        return;
      }
    }
  }

  if (method === 'invalidateEdge' || method === 'supersedeEdge') {
    const ids = method === 'supersedeEdge' ? [params[0] as number, params[1] as number] : [params[0] as number];
    for (const id of ids) {
      const row = await repo.findEdgeOwner(id);
      if (!isOwned(row)) {
        sendJson(res, 403, { error: { message: `edge #${id} is not visible to this project` } });
        return;
      }
    }
  }

  if (method === 'addAlias') {
    const nodeId = params[0] as number;
    const row = await repo.findNodeOwner(nodeId);
    if (!isOwned(row)) {
      sendJson(res, 403, { error: { message: `node #${nodeId} is not visible to this project` } });
      return;
    }
  }

  try {
    // Safe non-null assertion: `method` was already validated by
    // isValidMethodName() above, so it is guaranteed to be one of
    // Repository's own keys and therefore present on `repo`.
    const fn = (repo as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method]!;
    const result = await fn(...params);
    sendJson(res, 200, { result });
  } catch (err) {
    // Log method name + error message only — never the raw params (could
    // contain fact text) and never the raw Error/stack in the HTTP response.
    console.error(`orchestra-memory --serve-http: repo call failed (method=${method}):`, errorMessage(err));
    sendJson(res, 500, { error: { message: errorMessage(err) } });
  }
}

async function handleRequest(repo: RepositoryInternal, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    // Deliberately UNAUTHENTICATED: container orchestrators / uptime
    // monitors need to reach this without a bearer token. Task 2.1 (auth)
    // must not gate this route — this is a considered choice, not an
    // oversight.
    const health: HealthResponse = { ok: true, schemaVersion: SCHEMA_VERSION, serverVersion: SERVER_VERSION };
    sendJson(res, 200, health);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/rpc') {
    await handleRpc(repo, req, res);
    return;
  }

  sendJson(res, 404, { error: { message: 'not found' } });
}

/**
 * Builds and starts the `--serve-http` HTTP server. Returns the underlying
 * `http.Server` on success, or `undefined` on a fail-closed startup error
 * (after already writing a diagnostic to stderr and calling
 * `process.exit(1)`). Split out from `startServeHttp()` so tests can drive
 * a real server on an ephemeral port and inspect failure paths without
 * actually terminating the test process.
 */
export function createServeHttpServer(): Server | undefined {
  const dbPath = getDbPath();

  // Fail CLOSED on DB-open failure — deliberately the OPPOSITE of this
  // codebase's usual fail-open philosophy (see db/connection.ts's
  // tryOpenDb(), backup.ts, inject.ts: those degrade gracefully because a
  // broken hook/tool call must never break a user's local session). This is
  // a dedicated server process whose only reason to exist is serving this
  // DB; if it can't open it, starting "successfully" just means every
  // subsequent request fails instead. A future reader should NOT "fix" this
  // to match the client's fail-open pattern — it is intentionally different.
  let db;
  try {
    db = openDb(dbPath);
  } catch (err) {
    process.stderr.write(
      `orchestra-memory --serve-http: failed to open database at "${dbPath}": ${errorMessage(err)}\n`
    );
    process.exit(1);
    return undefined;
  }

  const repo = createRepository(db, { dbPath });

  // Split on the LAST ':' rather than a naive split(':') so a future IPv6
  // literal (e.g. "::1:8787") doesn't get mis-parsed on the first colon.
  // Full IPv6 bracket notation ("[::1]:8787") is NOT supported in v1 — this
  // is a best-effort split for the documented "host:port" format.
  const listenAddress = getListenAddress();
  const sepIndex = listenAddress.lastIndexOf(':');
  const host = sepIndex === -1 ? '' : listenAddress.slice(0, sepIndex);
  const portStr = sepIndex === -1 ? '' : listenAddress.slice(sepIndex + 1);
  const port = Number(portStr);

  if (!host || portStr === '' || !Number.isInteger(port) || port < 0 || port > 65535) {
    // Garbled listen address is a startup misconfiguration, not a runtime
    // degradation — fail closed the same way as the DB-open failure above.
    process.stderr.write(
      `orchestra-memory --serve-http: malformed ORCHESTRA_MEMORY_LISTEN "${listenAddress}" (expected "host:port")\n`
    );
    process.exit(1);
    return undefined;
  }

  // Fail CLOSED when no bearer token is configured at all AND the bind
  // address is not loopback: per docs/design/remote-memory-plan.md's trust
  // model, a missing ORCHESTRA_MEMORY_SERVER_TOKEN is only safe when the
  // server is unreachable from outside the machine. Binding e.g. `0.0.0.0`
  // or a LAN IP with no token would expose the whole DB with no auth at
  // all. This is an exact-match check against LOOPBACK_HOSTS (127.0.0.1,
  // localhost, ::1) deliberately, NOT a hostname resolver — resolving
  // arbitrary hostnames to "maybe loopback" is out of scope and would add a
  // DNS round-trip to server startup for speculative safety.
  if (getServerToken() === undefined && !LOOPBACK_HOSTS.has(host)) {
    process.stderr.write(
      `orchestra-memory --serve-http: refusing to start: no ORCHESTRA_MEMORY_SERVER_TOKEN is configured and ` +
        `ORCHESTRA_MEMORY_LISTEN host "${host}" is not loopback. Binding a non-loopback address with no token ` +
        `would expose the entire memory database with no authentication. Set ORCHESTRA_MEMORY_SERVER_TOKEN, or ` +
        `bind to 127.0.0.1/localhost/::1 for local-only use.\n`
    );
    process.exit(1);
    return undefined;
  }

  const server = createServer((req, res) => {
    // Last-resort catch-all: a truly unexpected error must still produce
    // SOME JSON 500 response rather than hanging the connection or
    // crashing the process.
    handleRequest(repo, req, res).catch((err) => {
      console.error('orchestra-memory --serve-http: unhandled request error:', errorMessage(err));
      try {
        sendJson(res, 500, { error: { message: 'internal server error' } });
      } catch {
        // Response may already be partially sent; nothing more to do.
      }
    });
  });

  // Registered BEFORE .listen() so a bind failure (e.g. EADDRINUSE) is
  // caught. Same fail-closed philosophy: a server that can't bind its port
  // has no reason to keep the process alive.
  server.on('error', (err) => {
    process.stderr.write(`orchestra-memory --serve-http: server error: ${errorMessage(err)}\n`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    const addr = server.address();
    const boundPort = addr && typeof addr === 'object' && addr !== null ? addr.port : port;
    process.stderr.write(`orchestra-memory --serve-http: listening on ${host}:${boundPort}\n`);
  });

  return server;
}

/**
 * Entry point for `node dist/server.mjs --serve-http`. Synchronous by
 * design: `openDb` is synchronous (node:sqlite) and `http.Server#listen` is
 * non-blocking — the process stays alive afterward because of the open
 * listening socket, exactly like the MCP stdio branch stays alive via
 * `await server.connect(transport)`. There is nothing here for a caller to
 * await.
 */
export function startServeHttp(): void {
  createServeHttpServer();
}
