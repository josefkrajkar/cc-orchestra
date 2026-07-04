-- Orchestra graph memory schema (v1).
-- PRAGMAs (journal_mode, foreign_keys, busy_timeout) are set programmatically
-- in connection.ts, not here, since journal_mode returns a result row.

-- Entity (uzly grafu), kanonicky pojmenované
CREATE TABLE nodes (
  id            INTEGER PRIMARY KEY,
  canonical     TEXT NOT NULL,          -- kanonické jméno entity
  kind          TEXT NOT NULL,          -- person|project|tech|convention|decision|gotcha|failed_approach|preference|fact|other
  scope         TEXT NOT NULL CHECK(scope IN ('global','project','private')),
  project_id    TEXT,                   -- NULL pro global; jinak sha256-16 cwd
  project_label TEXT,
  created_at    TEXT NOT NULL,          -- ISO-8601
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_nodes_canonical ON nodes(canonical, scope, COALESCE(project_id,''));
CREATE INDEX idx_nodes_scope_proj ON nodes(scope, project_id);
CREATE INDEX idx_nodes_kind ON nodes(kind);

-- Aliasy pro entity dedup / kanonizaci
CREATE TABLE node_aliases (
  id       INTEGER PRIMARY KEY,
  node_id  INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  alias    TEXT NOT NULL
);
CREATE INDEX idx_aliases_alias ON node_aliases(alias);

-- Observations = atomické self-contained propozice (jeden fakt)
CREATE TABLE observations (
  id            INTEGER PRIMARY KEY,
  node_id       INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  text          TEXT NOT NULL,          -- destilovaná atomická propozice, token-dense
  scope         TEXT NOT NULL CHECK(scope IN ('global','project','private')),
  project_id    TEXT,
  category      TEXT,                   -- convention|gotcha|decision|failed_approach|preference|fact (absorbuje wisdom)
  confidence    TEXT NOT NULL DEFAULT 'medium' CHECK(confidence IN ('high','medium','low')),
  source        TEXT,                   -- session-id | 'user' | 'migration:wisdom' | 'migration:md'
  valid_from    TEXT NOT NULL,          -- ISO-8601
  invalidated_at TEXT,                  -- NULL = stále platí
  superseded_by INTEGER REFERENCES observations(id),  -- novější fakt, který tento nahradil
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_obs_node ON observations(node_id);
CREATE INDEX idx_obs_scope_proj ON observations(scope, project_id);
CREATE INDEX idx_obs_valid ON observations(invalidated_at) WHERE invalidated_at IS NULL;
CREATE INDEX idx_obs_category ON observations(category);

-- Edges = relace mezi entitami (triples: subject -[predicate]-> object)
CREATE TABLE edges (
  id            INTEGER PRIMARY KEY,
  src_id        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  predicate     TEXT NOT NULL,          -- např. "uses", "depends_on", "prefers", "decided"
  dst_id        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL CHECK(scope IN ('global','project','private')),
  project_id    TEXT,
  confidence    TEXT NOT NULL DEFAULT 'medium',
  valid_from    TEXT NOT NULL,
  invalidated_at TEXT,
  superseded_by INTEGER REFERENCES edges(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_edges_src ON edges(src_id);
CREATE INDEX idx_edges_dst ON edges(dst_id);
CREATE INDEX idx_edges_scope_proj ON edges(scope, project_id);
CREATE UNIQUE INDEX idx_edges_triple ON edges(src_id, predicate, dst_id, scope, COALESCE(project_id,''))
  WHERE invalidated_at IS NULL;

-- FTS5 full-text nad observations (BM25 relevance driver v1)
CREATE VIRTUAL TABLE observations_fts USING fts5(
  text,
  content='observations',
  content_rowid='id',
  tokenize='unicode61'
);
CREATE TRIGGER obs_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER obs_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, text) VALUES('delete', old.id, old.text);
END;
CREATE TRIGGER obs_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, text) VALUES('delete', old.id, old.text);
  INSERT INTO observations_fts(rowid, text) VALUES (new.id, new.text);
END;

-- Schema verze pro budoucí migrace
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO meta(key,value) VALUES ('schema_version','1');
