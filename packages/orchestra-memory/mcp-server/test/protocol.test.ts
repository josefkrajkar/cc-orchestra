import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, type SqliteDatabase } from '../src/db/connection.js';
import { createRepository, type RepositoryInternal } from '../src/db/repository.js';
import { METHOD_NAMES, isValidMethodName } from '../src/remote/protocol.js';

// `createRepository()` returns RepositoryInternal, which adds a couple of
// internal-only ownership lookups (findNodeOwner, findEdgeOwner) on top of
// the public `Repository` interface — see RepositoryInternal's doc comment in
// src/db/repository.ts. Those two are deliberately excluded from
// METHOD_NAMES/isValidMethodName (src/serve.ts calls them directly on its
// local repo instance, never through the generic `repo[method](...)` /rpc
// dispatch) so a remote caller can never invoke them as a method name and
// turn them into the same project_id-oracle problem the P0 fix closes for
// findSupersedeTarget. Keep this list in sync with RepositoryInternal.
const INTERNAL_ONLY_METHODS = ['findNodeOwner', 'findEdgeOwner'];

describe('remote/protocol METHOD_NAMES', () => {
  let db: SqliteDatabase;
  let repo: RepositoryInternal;

  beforeEach(() => {
    db = openDb(':memory:');
    repo = createRepository(db);
  });

  it('every entry is a real key on a Repository instance', () => {
    for (const name of METHOD_NAMES) {
      expect(typeof (repo as unknown as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('has exactly as many entries as the Repository instance has keys, aside from the documented internal-only methods (catches drift both ways)', () => {
    expect(Object.keys(repo).length - INTERNAL_ONLY_METHODS.length).toBe(METHOD_NAMES.length);
    for (const name of INTERNAL_ONLY_METHODS) {
      expect(typeof (repo as unknown as Record<string, unknown>)[name]).toBe('function');
      expect(METHOD_NAMES as readonly string[]).not.toContain(name);
    }
  });

  it('isValidMethodName accepts every known method name and rejects garbage', () => {
    for (const name of METHOD_NAMES) {
      expect(isValidMethodName(name)).toBe(true);
    }
    expect(isValidMethodName('notARealMethod')).toBe(false);
    expect(isValidMethodName(123)).toBe(false);
    expect(isValidMethodName(undefined)).toBe(false);
  });
});
