// Bundles the MCP server into a single ESM file under dist/.
import { build } from 'esbuild';
import { existsSync, copyFileSync } from 'node:fs';

const entry = process.env.MCP_BUILD_ENTRY ?? 'src/server.ts';

if (!existsSync(entry)) {
  console.error(`esbuild: entry point "${entry}" not found`);
  process.exit(1);
}

await build({
  entryPoints: [entry],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.16',
  // Never bundle Node built-ins (incl. node:sqlite) — they must be resolved
  // at runtime by the host Node process, not inlined by esbuild.
  external: ['node:*'],
  sourcemap: true,
  logLevel: 'info',
});

// esbuild only bundles JS — it does not copy non-JS assets. connection.ts
// loads schema.sql via readFileSync relative to import.meta.url; once
// bundled, import.meta.url inside dist/server.mjs points at dist/server.mjs
// itself (esbuild does not rewrite import.meta.url on bundling), so
// connection.ts's `join(dirname(fileURLToPath(import.meta.url)), 'schema.sql')`
// resolves to dist/schema.sql. Copy it there so the bundle can find it
// without modifying connection.ts (db/** is frozen for this phase).
copyFileSync('src/db/schema.sql', 'dist/schema.sql');
console.log('esbuild: copied src/db/schema.sql -> dist/schema.sql');
