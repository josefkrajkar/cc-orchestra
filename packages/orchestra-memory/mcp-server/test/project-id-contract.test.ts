import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeProjectId } from '../src/migrate.js';

/**
 * === SHARED project_id CONTRACT — DO NOT CHANGE ===
 * project_id = first 16 hex chars of sha256(path + "\n"). This test is the
 * cross-package guard: it computes the SAME value two independent ways —
 * once via computeProjectId() (TS) and once by shelling out to the exact
 * bash one-liners used in production (memory-inject.sh, post-compact.sh,
 * orchestra/session-start.sh) — and asserts they agree byte-for-byte.
 *
 * If this test ever fails, the formula has diverged between the TS and
 * bash sites — that's a P0 bug: it silently fragments every user's memory
 * graph (facts written under one project_id become invisible to lookups
 * computed under a different one). Do not "fix" this test by changing the
 * formula; find and fix the divergent site instead.
 * ===================================================
 */

/** Mirrors `echo "$CWD" | shasum -a 256 | cut -c1-16` (post-compact.sh,
 * session-start.sh — `echo` appends a trailing newline to its input). */
function bashEchoProjectId(path: string): string {
  return execFileSync('bash', ['-c', 'echo "$0" | shasum -a 256 | cut -c1-16', path])
    .toString()
    .trim();
}

/** Mirrors `pwd | shasum -a 256 | cut -c1-16` (memory-inject.sh — `pwd`
 * also appends a trailing newline to its output). */
function bashPwdProjectId(dir: string): string {
  return execFileSync('bash', ['-c', 'cd "$0" && pwd | shasum -a 256 | cut -c1-16', dir])
    .toString()
    .trim();
}

describe('project_id shared contract (TS vs bash)', () => {
  it('echo-based formula (post-compact.sh, session-start.sh) matches computeProjectId() for representative paths', () => {
    const representativePaths = [
      '/Users/alice/project',
      '/tmp/my project',
      '/Users/bob/dev/monorepo/packages/orchestra-memory/mcp-server',
      '/Users/alice/Desktop/projects/orchestra-plugin',
    ];

    for (const path of representativePaths) {
      const bashResult = bashEchoProjectId(path);
      const tsResult = computeProjectId(path);
      expect(bashResult).toStrictEqual(tsResult);
    }
  });

  it('pwd-based formula (memory-inject.sh) matches computeProjectId() for the cwd path', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'project-id-contract-'));
    try {
      // Note: bash's `pwd` builtin (no `-P`) reports the LOGICAL path — i.e.
      // exactly what was passed to `cd`, without resolving symlink
      // components (macOS's /tmp -> /private/tmp is one such symlink). So
      // the correct comparison is against the path as given to `cd`, NOT
      // its realpath — that's also what happens in production, where
      // memory-inject.sh's plain `pwd` never resolves symlinks either.
      const bashResult = bashPwdProjectId(tmpDir);
      const tsResult = computeProjectId(tmpDir);
      expect(bashResult).toStrictEqual(tsResult);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
