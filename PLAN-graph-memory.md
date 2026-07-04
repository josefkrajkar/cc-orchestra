# Deep Plan: Rozšíření Orchestra pluginu o cross-project graph memory systém

## 1. Kontext

### Současný stav
Orchestra plugin (v2.0.0, `/Users/josefkrajkar/Desktop/projects/orchestra-plugin/`) je čistě markdown + bash řešení. Nemá žádný JS/TS kód, žádný `.mcp.json`, závislost jen na `bash` + `jq` (a `jq` je bráno jako volitelné — hooky selhávají fail-open). Paměť napříč sessions dnes zajišťují dvě oddělené vrstvy:

1. **Built-in Claude Code auto-memory** — `~/.claude/projects/<encoded>/memory/*.md` (7 markdown souborů uživatele), MEMORY.md se načítá per-git-repo, prvních 200 řádků / 25 KB. Nemá globální mód, nemá scoping, není AI-optimalizovaná.
2. **Orchestra wisdom** — `.claude/orchestra-wisdom.json` per-projekt, kategorie `conventions/gotchas/decisions/failed_approaches`, položky `{text, ts, confidence, source}` (+ legacy plain-string kompatibilita). Čtenáři: `agents/executor.md` (ř. 94–117), `agents/conductor.md` (ř. 120–124), `commands/wisdom.md`, `scripts/post-compact.sh` (ř. 64–79), `scripts/session-start.sh` (ř. 54–59), `skills/skill-extract/SKILL.md`.

Obě vrstvy jsou per-projekt/per-repo, izolované, bez sdílení faktů napříč projekty, bez temporální validity, bez řízeného scopingu důvěrnosti.

### Cílový stav
Jednotný **cross-project graph memory** systém dodávaný jako součást Orchestra pluginu:
- Plugin-bundlovaný **MCP server** (stdio) nad **SQLite** (nodes/edges/observations + FTS5).
- **AI-optimalizovaný** zápis přes LLM destilaci (atomické propozice, kanonické entity, triples, merge místo duplicit).
- **First-class scoping** `global / project / private` (klient A nesmí ve výchozím stavu vidět fakta klienta B).
- **Temporální validita** Graphiti-style (`valid_from`, `superseded_by`, `invalidated_at`, `confidence`).
- **SessionStart injekce** relevantní paměti do kontextu (rozpočet < 10 KB, DB dotaz < 100 ms).
- Built-in auto-memory **vypnuta** (`autoMemoryEnabled: false` — uživatelská změna, plugin ji nemůže nastavit sám).
- Wisdom **absorbována** jako kategorie/scope v grafu, s backward-compat během přechodu.
- **Migrace** existujících markdown pamětí (7 souborů) + `orchestra-wisdom.json`.
- Subagenti (scout, craftsman, executor…) mají přístup přes MCP tools (ToolSearch).

### Omezení (constraints)
- **Runtime:** plugin poprvé získává Node.js závislost. Musí degradovat fail-open (jako zbytek Orchestra), pokud Node chybí.
- **Latence:** SessionStart hook musí zůstat rychlý; DB dotaz pro injekci < 100 ms.
- **Injekční limit:** SessionStart stdout / `hookSpecificOutput.additionalContext` — tvrdý limit 10 000 znaků.
- **Deploy:** dev → marketplace přes rsync (`orchestra-marketplace/orchestra/`); marketplace **není git repo** → povinná záloha před změnami. rsync nesmí přepsat fable-model experiment v plugin cache.
- **Souběh:** více sessions/subagentů může zapisovat současně → SQLite WAL mód povinný.
- **Embeddings/hybrid retrieval:** odloženo na v2 (v1 = FTS5 BM25 + graph expansion).
- **Kuzu / Neo4j:** zamítnuto (viz níže).

---

## 2. Přístupy k packagingu a runtime MCP serveru

### Přístup A — TypeScript + esbuild bundle do jednoho JS souboru (DOPORUČENO)
Zdroj v TS (`mcp-server/src/`), build přes `esbuild` do jediného `mcp-server/dist/server.mjs` (bundlované všechny JS závislosti kromě nativní SQLite). `.mcp.json` spouští `node ${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/server.mjs`.

- **SQLite driver:** primárně `node:sqlite` (stabilní od Node 22.5+, žádná nativní kompilace, žádné `node_modules` v distribuci). Fallback detekce: pokud `node:sqlite` není dostupný, server vypíše diagnostiku a MCP tools vrací degradovaný stav (fail-open).
- **Plusy:** typová bezpečnost, jeden distribuovaný artefakt, čitelný vývoj, snadné testy (vitest). `node:sqlite` = nula nativních závislostí → rsync-safe, žádný `node_modules` balík v marketplace.
- **Mínusy:** build krok (dev musí spustit `npm run build` před deploy); vyžaduje Node ≥ 22.5 pro `node:sqlite`; FTS5 musí být v buildu SQLite (v `node:sqlite` je SQLite s FTS5 zkompilované — ověřit v akceptaci).

### Přístup B — Plain Node, žádné závislosti, čistě `node:sqlite`, ručně psané MCP JSON-RPC
Žádný build, žádný TS, žádný esbuild — jen `mcp-server/server.mjs` v čistém JS, ruční implementace MCP stdio protokolu.
- **Plusy:** nulové závislosti, nulový build, maximálně rsync-safe, minimální attack surface.
- **Mínusy:** ruční MCP protokol = víc kódu a chyb (bez `@modelcontextprotocol/sdk`), horší DX, žádné typy. Distillation prompt-handling a schema validace bez knihoven jsou křehké.

### Přístup C — npx-instalovaná závislost (`better-sqlite3` + MCP SDK přes npm install)
`.mcp.json` spouští server, který má `node_modules` instalované za běhu / přibalené.
- **Plusy:** `better-sqlite3` je nejrychlejší synchronní SQLite driver, robustní FTS5.
- **Mínusy:** **nativní modul** (kompilace při instalaci / prebuilt binárky per-platform) → rsync do marketplace přenese platform-specific binárky, křehké; první instalace vyžaduje síť/`npm install`; porušuje "fail-open bez závislostí" étos Orchestra. Zamítnuto jako výchozí.

### Doporučení
**Přístup A** (TypeScript + esbuild bundle, `node:sqlite` jako primární driver s fail-open detekcí). Kombinuje DX/typovou bezpečnost s nulovými nativními závislostmi a rsync-bezpečností. Použijeme `@modelcontextprotocol/sdk` (bundlovaný esbuildem do dist — je pure-JS), takže se vyhneme ruční implementaci protokolu z přístupu B, a přitom nemáme nativní závislost z přístupu C.

**Fallback strategie pro Node:** pokud `node` chybí nebo je < 22.5, `.mcp.json` server nenaběhne → MCP tools nejsou k dispozici. Bash hooky (SessionStart) proto MUSÍ detekovat dostupnost paměti a fail-open (žádná injekce, žádná chyba) — přesně jako dnešní `jq` detekce.

### Zamítnuté možnosti (rekapitulace)
- **Kuzu** — archivováno po akvizici Applem, nejistá budoucnost.
- **Neo4j** — overkill, samostatný server proces, těžká provozní zátěž.
- **`better-sqlite3` jako default** — nativní modul, rsync/platform problémy (viz přístup C).
- **Ruční MCP protokol (přístup B)** — zbytečná složitost, když SDK je pure-JS a bundlovatelné.
- **Markdown jako source of truth** — zamítnuto v locked rozhodnutích (storage je opaque, AI-optimalizovaný).
- **Embeddings ve v1** — odloženo na v2 (hybrid RRF).

---

## 3. Datový model (SQLite schema)

Umístění DB: `~/.claude/orchestra-memory/graph.db` (uživatelsky-globální, ne per-repo — to je klíč k cross-project sdílení). WAL mód povinný.

### Scope model
Enum `scope`: `global` | `project` | `private`.
- `global` — surfaces ve všech projektech.
- `project` — vázáno na `project_id` (stabilní klíč z cwd), surfaces jen ve stejném projektu.
- `private` — vázáno na `project_id`, NIKDY se neinjektuje cross-project ani do subagentů mimo projekt; určeno pro citlivá klientská fakta.

`project_id` = prvních 16 hex znaků `sha256($PROJECT_ROOT)` — **stejný algoritmus jako boulder instance** v `session-start.sh` (ř. 35), aby byla konzistence. Uloží se i čitelný `project_label` (basename cwd) pro `memory_inspect`.

### DDL

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;   -- pro souběh sessions/subagentů

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
```

### Entity kanonizace (v1, bez embeddings)
Při zápisu (`memory_save`) LLM destilace vrátí kandidátní jméno entity. Server:
1. Normalizuje (lowercase, trim, sjednocení whitespace) → hledá přesnou shodu v `nodes.canonical` a `node_aliases.alias` v daném scope/project.
2. Při shodě: reuse existujícího `node_id`, případně přidá nový alias.
3. Bez shody: FTS5 lookup podobných existujících entit → LLM (v save promptu) rozhodne merge vs. nová entita.
4. Nová entita → `INSERT` + volitelné aliasy.

Merge faktů: nová observation se porovná s existujícími platnými pro daný node/kategorii; při sémantické shodě LLM buď (a) supersede starého (`superseded_by`, `invalidated_at` = now), nebo (b) zahodí duplicitu, nebo (c) přidá jako nový nezávislý fakt.

---

## 4. MCP tool surface

Server jméno: `orchestra-memory`. Nástroje:

- **`memory_save`** — `{content, scope?, project_hint?, source?}` → destiluje vstup na atomické propozice + triples, kanonizuje entity, merguje s existujícími (supersede/dedup), zapíše nodes/observations/edges. **Distillation contract:** vrací kanonické entity, jeden fakt = jedna self-contained věta (bez zájmenných referencí na kontext), relace jako `subject | predicate | object`; scope default `project` pokud neurčeno; NIKDY nezapisuje raw text bez destilace.
- **`memory_search`** — `{query, scope_filter?, project_id?, limit?, include_invalidated?}` → FTS5 BM25 nad platnými observations respektující scope (default: global + aktuální project, NIKDY private cizího projektu) + graph expansion o 1 hop z hit nodes. Vrací token-dense text (jeden fakt/řádek, triple-style).
- **`memory_link`** — `{src, predicate, dst, scope?}` → vytvoří/aktualizuje edge (triple) mezi kanonickými entitami; idempotentní přes unique triple index.
- **`memory_traverse`** (alias `memory_expand`) — `{entity, depth?, scope_filter?}` → graph walk z uzlu do hloubky N, vrací propojené entity + jejich platné observations, respektuje scope.
- **`memory_inspect`** — `{scope_filter?, project_id?, entity?}` → **debug/trust escape hatch**; generuje na vyžádání human-readable pohled (markdown) na uložená data včetně metadat (confidence, valid_from, superseded_by, source). Jediný human-readable výstup v systému.
- **`memory_invalidate`** (alias `memory_forget`) — `{observation_id? | entity? | query?, reason?}` → nastaví `invalidated_at` = now (soft delete). Hard delete jen s explicitním `{hard:true}`.
- **`memory_stats`** — `{}` → počty nodes/observations/edges per scope, počet invalidated, velikost DB, flag entries starších 90 dní. Používá se pro SessionStart budget rozhodování.

### Wisdom compat tools
- **`wisdom_get`** — `{project_id?}` → čte fakta s `category IN (convention,gotcha,decision,failed_approach)` z grafu, vrací ve formátu kompatibilním se stávající injekcí. Interně volá `memory_search`.
- **`wisdom_add`** — `{text, category, confidence?}` → tenký wrapper nad `memory_save` s vynuceným category; zachovává chování `/wisdom add`.

Během přechodu `commands/wisdom.md` a agent protokoly volají tyto compat tools místo přímého zápisu do `orchestra-wisdom.json`. Legacy JSON čtení zůstává jako fallback, dokud migrace neproběhne (viz Fáze 7).

---

## 5. Fáze

Cesty jsou vždy absolutní pod `/Users/josefkrajkar/Desktop/projects/orchestra-plugin/`.

### Fáze 0 — Bootstrap projektu MCP serveru
- **OWNS:** `mcp-server/package.json`, `mcp-server/tsconfig.json`, `mcp-server/esbuild.config.mjs`, `mcp-server/.gitignore`, `mcp-server/vitest.config.ts`
- **MUST NOT MODIFY:** cokoli v `.claude-plugin/`, `agents/`, `scripts/`, `commands/`.
- **Dependencies:** žádné. **Parallelizable:** ne.
- **Risk:** špatná volba Node targetu → build/runtime nekompatibilita. Nízký.
- **Acceptance:** `npm install && npm run build` produkuje prázdný `dist/server.mjs`; `npm test` běží.

### Fáze 1 — Schema + storage vrstva
- **OWNS:** `mcp-server/src/db/schema.sql`, `mcp-server/src/db/connection.ts` (WAL, busy_timeout, migrace přes meta.schema_version, detekce node:sqlite s fail-open), `mcp-server/src/db/repository.ts` (CRUD, FTS5 search, graph expansion, kanonizace, supersede/invalidate), `mcp-server/test/repository.test.ts`
- **Dependencies:** Fáze 0. **Parallelizable:** ne (jádro).
- **Risk:** node:sqlite FTS5 nedostupné → mitigace: acceptance test FTS5; fallback sql.js.
- **Acceptance:** unit testy — insert entity, dedup přes alias, FTS5 BM25 search, supersede nastaví invalidated_at, scope filtr izoluje private.

### Fáze 2 — MCP server core + tool surface
- **OWNS:** `mcp-server/src/server.ts`, `mcp-server/src/tools/{save,search,link,traverse,inspect,invalidate,stats}.ts`, `mcp-server/src/tools/wisdom-compat.ts`, `mcp-server/src/distill.ts`, `mcp-server/src/render.ts`, `mcp-server/test/tools.test.ts`, `.mcp.json` (root)
- **MUST NOT MODIFY:** plugin.json hooks, agenti.
- **Dependencies:** Fáze 1. **Parallelizable:** jednotlivé tool soubory paralelně po zamrznutí repository API.
- **Risk:** distillation garbage-in → server-side validace tvaru, zamítnutí prázdných/duplicitních.
- **Acceptance:** všech 9 tools odpovídá přes MCP stdio; save→search roundtrip; memory_inspect vrací čitelný markdown; scope izolace ověřena.

### Fáze 3 — SessionStart hook integrace (rozpočet 10 KB)
- **OWNS:** `scripts/memory-inject.sh` (nový), úprava `scripts/session-start.sh` (aditivní volání).
- **Injektuje:** project-scope index (platná project fakta dle confidence/recency) + top-K global fakta + private fakta jen aktuálního projektu. CLI mód: `node dist/server.mjs --inject --project-id <key>`. Byte-count ořez, přebytek → soubor + preview.
- **Dependencies:** Fáze 2. **Parallelizable:** ne.
- **Risk:** latence, přesah 10 KB, Node absence → tvrdý timeout, fail-open.
- **Acceptance:** injekce ≤ 10 000 znaků; bez Node hook tiše pokračuje; dotaz < 100 ms na DB s ~1000 fakty.

### Fáze 4 — Write-discipline skill + PostCompact re-injekce
- **OWNS:** `skills/memory-discipline/SKILL.md` (nový), úprava `scripts/post-compact.sh` (memory re-injekce s legacy fallbackem).
- **Dependencies:** Fáze 2. **Parallelizable:** ano — souběžně s Fází 3.
- **Risk:** zápisový spam → kvalitní filtr (non-obvious/reusable/stable) ze skill-extract ř. 64–71.
- **Acceptance:** skill triggery fungují; post-compact re-injekce pod budgetem; legacy wisdom JSON čten pokud graf prázdný.

### Fáze 5 — Migrace agent/command protokolů (wisdom → graph memory)
- **OWNS:** `agents/executor.md` (ř. 94–117), `agents/conductor.md` (ř. 120–124), `commands/wisdom.md`, `skills/skill-extract/SKILL.md` (ř. 18–61), `agents/{scout,craftsman,scholar,sentinel,architect}.md` (sekce "Memory access via orchestra-memory MCP tools")
- **Dependencies:** Fáze 2, 4. **Parallelizable:** ano — až 8 paralelních craftsmanů (disjunktní soubory).
- **Risk:** wisdom backward-compat breakage → dvojí režim, legacy fallback do potvrzené migrace.
- **Acceptance:** /wisdom show funguje z grafu i legacy JSON; executor zapíše fakt do grafu; subagent umí memory_search.

### Fáze 6 — UX pro vypnutí built-in auto-memory
- **OWNS:** `commands/memory-setup.md` (nový příkaz /memory-setup: kontrola Node ≥ 22.5, ověření MCP serveru, spuštění migrace, instrukce pro `"autoMemoryEnabled": false` — nenastavuje bez potvrzení), úprava README.md.
- **MUST NOT MODIFY:** `~/.claude/settings.json` automaticky.
- **Dependencies:** Fáze 2, 7. **Parallelizable:** ne.
- **Risk:** souběh built-in + graph memory → /memory-setup explicitně upozorní a ověří.
- **Acceptance:** /memory-setup diagnostikuje, migruje, vypíše přesné instrukce.

### Fáze 7 — Migrační příkaz (markdown paměti + wisdom.json import)
- **OWNS:** `mcp-server/src/migrate.ts`, `commands/memory-migrate.md` (dry-run default, `--commit` pro zápis), `mcp-server/test/migrate.test.ts`
- **MUST NOT MODIFY:** originální markdown soubory (jen čtení).
- **Dependencies:** Fáze 2. **Parallelizable:** ano — souběžně s 5/6.
- **Risk:** data loss / špatná destilace → dry-run first, originály nikdy nemazány, idempotence, DB backup před --commit.
- **Acceptance:** dry-run report 7 md + N wisdom položek; --commit idempotentní; originály nedotčené.

### Fáze 8 — Dokumentace
- **OWNS:** README.md, AGENTS.md, mcp-server/README.md. Verze pluginu → 2.1.0.
- **Dependencies:** Fáze 1–7. **Parallelizable:** ano.

### Fáze 9 — Deploy do marketplace (ZÁLOHA NEJDŘÍV!)
- Záloha: `cp -R orchestra-marketplace/orchestra orchestra-marketplace/orchestra.bak-2026-07-04`
- rsync dev → marketplace s `--exclude` fable-model experiment + `--exclude node_modules` (deployuje se jen dist/). `--dry-run` první, žádné `--delete` bez review.
- **Dependencies:** VŠECHNY fáze + validace.
- **Acceptance:** marketplace funguje; fable experiment zachován; záloha existuje; MCP server naběhne z marketplace cesty.

---

## 6. Paralelizace

- **Sekvenční páteř:** Fáze 0 → 1 → 2.
- **Uvnitř Fáze 2:** tool soubory paralelně po zamrznutí repository API (worktree izolace).
- **Po Fázi 2 paralelně:** Track A (Fáze 3), Track B (Fáze 4), Track C (Fáze 7) — disjunktní soubory.
- **Fáze 5:** až 8 paralelních craftsmanů.
- **Fáze 8:** 3 doc soubory paralelně. **Fáze 6, 9:** sekvenční.

## 7. Risk matice

| Riziko | Pravděpodobnost | Dopad | Mitigace |
|---|---|---|---|
| Node.js chybí / < 22.5 | Střední | Vysoký | Fail-open všude; bash detekce; /memory-setup verifikace; node:sqlite = 0 nativních závislostí |
| SessionStart latence > 100 ms | Střední | Vysoký | Tvrdý timeout, indexy, top-K limit, fail-open bez injekce |
| Cross-project leakage | Nízká | Kritický | Scope povinný; default = global + current project; private NIKDY cross-project; e2e test |
| Přesah 10 KB injekce | Střední | Střední | Byte-count ořez, přebytek → soubor + preview |
| Wisdom backward-compat breakage | Střední | Vysoký | Dvojí režim, legacy fallback do potvrzené migrace |
| Distillation garbage-in | Střední | Střední | Server-side validace, dedup/merge, kvalitní filtr, memory_inspect audit |
| SQLite concurrency | Vysoká | Střední | WAL, busy_timeout=5000, krátké transakce |
| Migrace data loss | Nízká | Vysoký | Dry-run default, originály read-only, idempotence, DB backup |
| rsync přepíše fable experiment | Střední | Vysoký | Povinná záloha, --exclude, --dry-run, žádné --delete |
| FTS5 nedostupné v node:sqlite | Nízká | Vysoký | Acceptance test ve Fázi 1; fallback sql.js |
| esbuild bundle nekompatibilní | Nízká | Střední | node:* jako external; smoke test dist ve Fázi 2 |

## 8. Rollback strategie

- **F0–2:** čistě aditivní → smazat mcp-server/ + .mcp.json.
- **F3:** memory blok jako oddělený skript volaný podmíněně → odebrat volání.
- **F4:** skill smazat; post-compact memory blok podmíněný.
- **F5:** legacy fallback zachován → vrátit původní soubory (záloha před editací).
- **F6:** příkaz smazat; uživatel vrátí autoMemoryEnabled: true.
- **F7:** migrace nedestruktivní; rollback dat = DB backup restore nebo memory_invalidate `source LIKE 'migration:%'`.
- **F9:** restore z orchestra.bak-<datum>.
- **Globálně:** built-in auto-memory se vypíná až ve Fázi 6 a legacy wisdom JSON zůstává čten → vždy funkční paměťová vrstva.

## 9. End-to-end akceptační scénáře

1. **Global cross-project surfacing:** global fakt z projektu A se objeví v SessionStart injekci projektu B.
2. **Private izolace:** private fakt z projektu A se NEOBJEVÍ v injekci ani memory_search z projektu B.
3. **Project scope izolace:** project fakt z A se neobjeví v B, objeví se při návratu do A.
4. **Supersession:** "používá Express" → "migroval na Hono"; search vrátí jen Hono; inspect ukáže historii.
5. **Entity kanonizace:** "Josef" a "Josef Krajkar" → jedna entita s aliasem.
6. **Injekce pod 10 KB** při ~1000 faktech; dotaz < 100 ms.
7. **Wisdom migrace + kompat:** import wisdom.json; /wisdom show z grafu; legacy strings tolerovány.
8. **Markdown migrace:** 7 souborů importováno; originály nedotčené; re-run idempotentní.
9. **Fail-open bez Node:** hook tiše pokračuje, zbytek Orchestra funguje.
10. **Subagent přístup:** scout přes ToolSearch najde orchestra-memory tools a zavolá memory_search.
11. **memory_inspect trust:** čitelný markdown s confidence, valid_from, source.

---

## Realizační pořadí
Fáze 0→1→2 sekvenčně (jádro) → paralelní tracky A/B/C (Fáze 3/4/7) → Fáze 5 (paralelní craftsmani) → Fáze 6 → Fáze 8 → Fáze 9 (deploy se zálohou).
