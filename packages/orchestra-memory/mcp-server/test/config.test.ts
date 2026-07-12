import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getDbPath } from '../src/config.js';

describe('config.getDbPath', () => {
  const ENV_KEY = 'ORCHESTRA_MEMORY_DB_PATH';
  let hadOriginal: boolean;
  let original: string | undefined;

  beforeEach(() => {
    hadOriginal = ENV_KEY in process.env;
    original = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (hadOriginal) {
      process.env[ENV_KEY] = original;
    } else {
      delete process.env[ENV_KEY];
    }
  });

  it('returns the default path when unset', () => {
    delete process.env[ENV_KEY];
    expect(getDbPath()).toBe(join(homedir(), '.claude', 'orchestra-memory', 'graph.db'));
  });

  it('returns the override path exactly when set to a custom path', () => {
    process.env[ENV_KEY] = '/custom/path/graph.db';
    expect(getDbPath()).toBe('/custom/path/graph.db');
  });

  it('falls back to the default when set to an empty string', () => {
    process.env[ENV_KEY] = '';
    expect(getDbPath()).toBe(join(homedir(), '.claude', 'orchestra-memory', 'graph.db'));
  });
});
