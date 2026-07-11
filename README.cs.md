# Orchestra v2 — Multi-Agent Orchestration Plugin pro Claude Code

Nativní Claude Code plugin replikující multi-agent workflow z [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent). Poskytuje 3-vrstvou architekturu se 7 specializovanými agenty, staged pipeline s quality gates, file claiming, wisdom accumulation a session persistence.

## Instalace

Claude Code pluginy se instalují přes marketplace systém. Plugin vyžaduje marketplace wrapper:

```
orchestra-marketplace/
├── .claude-plugin/
│   └── marketplace.json       # marketplace manifest
└── orchestra/                 # symlink nebo kopie orchestra-plugin/
    └── .claude-plugin/
        └── plugin.json        # plugin manifest
```

```bash
# 1. Zaregistruj lokální marketplace
claude plugin marketplace add /cesta/k/orchestra-marketplace --scope user

# 2. Nainstaluj plugin
claude plugin install orchestra@orchestra-marketplace

# 3. Ověř instalaci
claude plugin list
```

Pro instalaci jen do konkrétního projektu použij `--scope project`.

Po instalaci plugin běží na pozadí — nemusíš nic konfigurovat. Díky symlinku se změny v `orchestra-plugin/` automaticky promítnou.

## Jak to funguje v praxi

### Komplexní feature (full pipeline)

```
> /orchestrate Implementuj systém slevových kupónů — databázové schéma,
  REST API, validační logiku a frontend formulář
```

Co se stane:

1. **Conductor** posoudí složitost, klasifikuje jako `complex`
2. Spustí **scout** + **scholar** paralelně — scout prozkoumá kódovou bázi (modely, API patterns, frontend komponenty), scholar stáhne dokumentaci relevantních knihoven
3. Spustí **architect** s nálezy — navrhne fázovaný plán:
   - Fáze 1: DB migrace + model
   - Fáze 2: API endpointy + validace
   - Fáze 3: Frontend formulář
   - Ke každé fázi: kdo vlastní jaké soubory
4. **Plán se ti ukáže ke schválení** — můžeš upravit, schválit nebo zahodit
5. **Executor** vezme schválený plán a spustí **craftsmany** paralelně:
   - Craftsman A: DB schéma (OWNS `src/db/*`, MUST NOT MODIFY `src/api/*`)
   - Craftsman B: API endpointy (OWNS `src/api/*`, MUST NOT MODIFY `src/db/*`)
   - Craftsman C: po dokončení A+B → frontend formulář
6. **Sentinel** provede review všech změn — reportuje jen issues s 80%+ confidence:
   ```
   ## Code Review Report
   ### Summary: PASS WITH NOTES

   ### Important (P1)
   - [ ] src/api/coupons.ts:42 — chybí rate limiting (confidence: 85%)

   ### Positive Notes
   - Dobrá validace na hranici systému
   - Konzistentní error handling
   ```
7. Pokud P0/P1: craftsman opraví, sentinel znovu zkontroluje (max 2 cykly)
8. Report: co se změnilo, jaké soubory, learnings uloženy do wisdom

### Jenom plánování (bez implementace)

```
> /plan Migrace z Express na Hono framework
```

1. **Scout** prozkoumá aktuální Express kód — routy, middleware, error handling
2. **Scholar** stáhne dokumentaci Hono z Context7
3. **Architect** vytvoří migrační plán s fázemi, riziky a rollback strategií
4. Strukturovaný plán, žádný kód se nezmění

Až budeš chtít plán realizovat:
```
> Implementuj tento plán
```
Conductor/executor se chopí exekuce.

### Paralelní práce

```
> /parallel Přidej rate limiting na API | Implementuj health check endpoint | Přidej request logging middleware
```

1. **Scout** rychle identifikuje soubory per task
2. File ownership se přiřadí — žádný overlap
3. Tři **craftsmani** se spustí současně, každý s explicitním omezením co smí a nesmí editovat; v git repozitáři každý dostane vlastní worktree (`isolation: "worktree"`)
4. Po dokončení souhrnný report

**Scale decision:** ≤8 tasků → prompt-driven craftsman dispatch (výše). >8 tasků nebo opakovaný batch (audity, migrace, codemod) → generuje se Workflow script (`pipeline()`, schema-validated výstupy, uložen do `.claude/workflows/`). Žádné tiché vynechání — co se nestihne, to se reportuje.

### Code review

```
> /review
```

Automaticky vezme `git diff`, spustí **sentinel** a vrátí strukturovaný report:

```
## Code Review Report
### Summary: NEEDS CHANGES

### Critical (P0)
- [ ] src/auth.ts:42 — SQL injection v user query (confidence: 98%)
  - Why: Interpolace user inputu přímo do SQL
  - Suggestion: Použít parametrizovaný query

### Important (P1)
- [ ] src/api/routes.ts:118 — Chybí rate limiting na /login (confidence: 87%)

### Positive Notes
- Dobrá separace concerns v service layer
```

Pak stačí říct "oprav P0 issues" a craftsman to fixne. Sentinel pak znovu zkontroluje.

### Batch operace (Ralph Loop)

```
> /ralph Oprav všechny ESLint warningy
```

Iterativní cyklus: vezme warning → opraví → ověří → další. Max 8 iterací, automaticky přeskočí co nejde opravit.

Cyklus také skončí dříve (semantic completion) pokud verify krok vrátí `<promise>DONE</promise>` A testy/lint projdou — v tu chvíli se přeskočí zbývající iterace. MAX_ITERATIONS=8 zůstává jako pojistka vždy.

### Session persistence (dlouhý projekt)

Pracuješ na velkém refactoringu, musíš odejít:

```
> /boulder save
```

Uloží stav — fázi, tasky, file hashe, wisdom — do `.claude/orchestra-boulder.json`. Boulder obsahuje také pole `instance` odvozené z pracovního adresáře, takže session-start hlásí pouze boulders patřící aktuálnímu projektu (žádný cross-talk mezi dvěma instancemi Claude).

Příští den otevřeš Claude Code a automaticky uvidíš:

```
Orchestra: Found existing orchestration state. Phase: execution, Tasks: 5/12 completed.
Accumulated wisdom: 8 entries. Use /status to see full details or continue where you left off.
```

```
> /boulder restore
```

Validuje, že se soubory nezměnily (porovná git hashe), obnoví tasky a navrhne další kroky. Pokud se něco změnilo, restore **vypíše seznam neshodných souborů a vyžádá explicitní potvrzení** před tím, než přepíše tasky — žádná slepá obnova.

### Wisdom — učení se z práce

```
> /wisdom show
```

```
## Accumulated Wisdom

### High Confidence (2 entries)
- Always use path aliases — never relative ../../ imports — source: session-abc, 2026-05-01
- zod schemas next to the route handler — source: user, 2026-06-01

### Medium Confidence (2 entries)
- prisma needs regeneration after every schema change — source: session-xyz, 2026-04-10
- NextAuth session callback must return full user object — source: session-xyz, 2026-01-05 ⚠️ older than 90 days — consider reviewing

### Low Confidence (1 entry)
- Hono over Express — 3x faster cold start, same API surface — source: session-abc, 2025-12-01 ⚠️ older than 90 days — consider reviewing

### Unclassified / Legacy (1 entry)
- barrel exports in every module index.ts
```

Wisdom schema v2 — každá položka je objekt `{text, ts, confidence, source}`. Starší plain-string záznamy jsou zobrazeny v sekci "Unclassified / Legacy". Záznamy starší 90 dní jsou označeny ⚠️ k přehodnocení. Tyhle learnings se automaticky předávají craftsman agentům a přežijí i kompakci context window.

### Graph memory — paměť napříč projekty (nově v 2.1.0)

Wisdom JSON výše je per-projekt. Od verze 2.1.0 k němu přibyla **cross-project graph memory** — MCP server `orchestra-memory` nad SQLite, sdílený napříč všemi projekty na stroji, s temporální validitou a scopingem `global/project/private`. Jednorázové nastavení:

```
> /memory-setup
```

1. Zkontroluje Node.js (potřeba ≥ 22.5 kvůli `node:sqlite`) a že je MCP server sestavený (`mcp-server/dist/server.mjs`) — pokud ne, nabídne `npm install && npm run build`
2. Ověří dostupnost `orchestra-memory` nástrojů přes ToolSearch a zobrazí `memory_stats`
3. Nabídne migraci starých pamětí (dry-run → potvrzení → zápis)
4. Vypíše přesný JSON snippet pro vypnutí vestavěné auto-memory — **tuhle změnu uděláš sám**, plugin `~/.claude/settings.json` nikdy needituje automaticky
5. Ověří end-to-end zápis/čtení (`memory_save` → `memory_search` smoke test)

```
> /memory-migrate
```

Dry-run report ukáže, co by se importovalo z `.claude/orchestra-wisdom.json` a z markdown auto-memory souborů (`~/.claude/projects/*/memory/*.md`); k zápisu dojde až po explicitním potvrzení (nebo `--commit`). Originální soubory se nikdy needitují ani nemažou. Detailní architektura je popsaná níže v sekci "Jak to funguje pod kapotou".

**Denní záloha (nově v 2.2.0):** Při každém `SessionStart` `scripts/session-start.sh` spustí `scripts/memory-backup.sh`, který jednou denně (rotace) zazálohuje `~/.claude/orchestra-memory/graph.db` do `~/.claude/orchestra-memory/backups/graph-<YYYY-MM-DD>.db`. Drží se posledních 7 záloh (nejstarší se mažou). Hot-path (záloha za dnešek už existuje) je čistý `existsSync` bez otevření DB, takže náklad na běžný SessionStart je zanedbatelný. Celé je to fail-open — chybějící/starý Node nebo nesestavený bundle → tichý no-op, nikdy nerozbije SessionStart hook.

### Přirozený jazyk (bez slash příkazů)

Plugin se aktivuje i automaticky díky skills — nemusíš používat slash příkazy:

```
> Potřebuji zrefaktorovat celý autentizační modul, rozděl to na fáze
  a koordinuj práci mezi agenty
```

Conductor se aktivuje sám, protože rozpozná multi-agent orchestrační potřebu.

```
> Zkontroluj všechny změny co jsme udělali
```

Sentinel se spustí automaticky přes deep-review skill.

## Kdy co použít

| Situace | Příkaz |
|---------|--------|
| Komplexní feature/refactoring | `/orchestrate <popis>` |
| Chci plán, ne kód | `/plan <popis>` |
| Nezávislé úkoly paralelně | `/parallel t1 \| t2 \| t3` |
| Review kódu | `/review` |
| Opakované opravy (lint, testy) | `/ralph <popis>` |
| Uložit stav pro příště | `/boulder save` |
| Obnovit z předchozí session | `/boulder restore` |
| Zobrazit learnings | `/wisdom show` |
| Zjistit kde jsem | `/status` |
| Nastavit graph memory (jednorázově) | `/memory-setup` |
| Migrovat staré paměti do grafu | `/memory-migrate` |
| Jednoduchý task | Prostě řekni co chceš (orchestraci nepotřebuješ) |

---

## Jak to funguje pod kapotou

### Architektura

```
┌─────────────────────────────────────────────────────┐
│                  PLANNING LAYER                      │
│  scout (haiku) + scholar (haiku) + architect (opus)  │
├─────────────────────────────────────────────────────┤
│               ORCHESTRATION LAYER                    │
│   conductor (inherit/opus) + executor (sonnet)       │
├─────────────────────────────────────────────────────┤
│                EXECUTION LAYER                       │
│      craftsman (sonnet) + sentinel (sonnet)          │
└─────────────────────────────────────────────────────┘
```

### Agenti

| Agent | Model | Odpovídá v OMO | Funkce |
|-------|-------|----------------|--------|
| **conductor** | inherit/opus (blue) | Sisyphus | Orchestrátor — intent classification, dekompozice, delegace; může běžet jako `inherit` |
| **architect** | opus (cyan) | Prometheus | Strategický plánovač — read-only, plány s file ownership |
| **executor** | sonnet (green) | Atlas | Koordinátor — file claiming, parallel dispatch, wisdom; koordinace je mechanická, jakmile existuje plán (naměřeno 27 % nákladů session na opusu) |
| **craftsman** | sonnet (green) | Hephaestus | Worker — OWNS/MUST NOT MODIFY, explore → implement → verify → file report + shrnutí do 5 řádků |
| **sentinel** | sonnet (red) | Momus | Reviewer — 80%+ confidence filtering, P0-P3, read-only; strukturovaný checklist nevyžaduje plný opus |
| **scout** | haiku (yellow) | Explore | Průzkumník — read-only, strukturovaný report |
| **scholar** | haiku (magenta) | Librarian | Researcher — Context7, web, read-only |

### Staged Pipeline

```
[Assessment] → classify intent (quick/standard/complex/research/review)
      ↓
[Reconnaissance] → scout + scholar (parallel)
      ↓
[Planning] → architect produces plan with file ownership (complex only)
      ↓ quality gate: user approves plan
[Specification] → tasks + file claiming + acceptance criteria
      ↓ quality gate: spec complete
[Execution] → executor dispatches craftsmen (max 5-8 parallel)
      ↓ quality gate: all tasks done
[Validation] → sentinel review (80%+ confidence)
      ↓ quality gate: no P0/P1
[Fix Loop] → craftsman fixes → sentinel re-review (max 2 cycles)
      ↓
[Completion] → extract wisdom, report
```

### Intent Classification

Conductor automaticky klasifikuje každý úkol — nemusíš to dělat ručně:

| Intent | Pipeline | Kdy |
|--------|----------|-----|
| `quick` | Přímé řešení, bez agentů | Jeden soubor, jasná změna |
| `standard` | scout → craftsman → sentinel | Multi-file, straightforward |
| `complex` | Full staged pipeline | Cross-cutting, vysoké riziko |
| `research` | scout + scholar | Porozumění, žádné změny |
| `review` | sentinel | Pouze code review |

### File Claiming

Při paralelní práci každý craftsman dostane explicitní vlastnictví:
```
Craftsman A: OWNS [src/api/*]         MUST NOT MODIFY [src/frontend/*]
Craftsman B: OWNS [src/frontend/*]    MUST NOT MODIFY [src/api/*]
```
PreToolUse hook automaticky varuje při pokusu o editaci cizího souboru.

### Confidence-Based Review

Sentinel reportuje pouze issues s 80%+ confidence:
- 95-100%: Definitivní bug/vulnerability → P0
- 80-94%: Velmi pravděpodobné → P1/P2
- 60-79%: Možné → P3 Observations only
- <60%: Nereportuje se

### Error Recovery

| Selhání | Akce | Limit |
|---------|------|-------|
| Craftsman selže | 1. retry: SendMessage stejnému craftsman agentId s detaily; 2. retry: nový spawn s kumulovaným kontextem | Max 2 retries celkem |
| Plán nedostatečný | Architect replánuje sekci | Max 2 replans |
| Sentinel zamítne | Craftsman fixne P0/P1 | Max 2 fix cycles |
| Opakované selhání | Eskalace na uživatele | Po dosažení limitu |

### Hooky

| Event | Script | Funkce |
|-------|--------|--------|
| **SessionStart** | `session-start.sh` | Načte boulder stav + wisdom z předchozí session; oznamuje jen boulders odpovídající aktuální instanci (cwd) |
| **PreToolUse (Edit/Write)** | `pretooluse-guard.sh` | File ownership guard — varuje při editaci cizího souboru; jq-missing = viditelné varování |
| **PostToolUse (Edit/Write)** | `track-progress.sh` | Trackuje změněné soubory v boulder state |
| **PostCompact** | `post-compact.sh` | Re-injektuje orchestrační kontext po kompakci context window; toleruje wisdom v2 objekty i legacy strings |
| **Stop** | `validate-completion.sh` | Varuje pokud jsou nedokončené úkoly |
| **Notification** | `notify.sh` | Orchestrační notifikace |
| **SubagentStart** | `subagent-log.sh` | Zapíše JSONL záznam (ts, event, agent_type, session) do `.claude/orchestra-log.jsonl` |
| **SubagentStop** | `subagent-log.sh` | Zapíše JSONL záznam při ukončení sub-agenta |
| **TaskCompleted** | `taskcompleted-gate.sh` | Opt-in sentinel gate: blokuje dokončení (exit 2) jen když boulder má `"gate": "sentinel"`; jinak exit 0 |

### Graph memory (`orchestra-memory` MCP server)

MCP server bundlovaný s pluginem (`mcp-server/`, TypeScript → esbuild → jeden soubor `dist/server.mjs`), spouštěný přes `.mcp.json` (`node ${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/server.mjs`). Storage: SQLite přes `node:sqlite` (nula nativních závislostí, žádný `node_modules` v deploynutém bundlu) v `~/.claude/orchestra-memory/graph.db` — **uživatelsky globální, ne per-repo**, což je klíč k tomu, aby fakta mohla surfovat napříč projekty. WAL mód + `busy_timeout=5000` kvůli souběžnému zápisu z více sessions/subagentů.

**Scoping:**

Server se při startu naváže na vlastní projektovou identitu (sha256 z jeho cwd, stejná derivace jako boulder instance key) — volající proto `project_id` u nástrojů běžně vůbec nezadává, server použije svou vlastní. Pokud je přesto zadaný `project_id`, který neodpovídá té serverové, nástroj pro `project`/`private` scope vrátí chybu — cross-project přístup do těchto scopes není možný. `global` scope se tímto neřídí.

| Scope | Chování |
|---|---|
| `global` | Viditelné ve všech projektech — jen fakta platná univerzálně (např. preference uživatele), nikdy klientská data; explicitní opt-in (`scope: 'global'`) |
| `project` | Výchozí scope. Vázané na projektovou identitu serveru (sha256 z cwd), viditelné jen v daném projektu |
| `private` | Vázané na projektovou identitu serveru, NIKDY se needituje cross-project ani do subagentů mimo tento projekt — určeno pro citlivá klientská fakta, kde riziko úniku převažuje nad pohodlím sdílení |

**Temporalita:** každý fakt (`observation`) má `valid_from`, volitelně `invalidated_at` (soft delete) a `superseded_by` (odkaz na novější fakt, který ho nahradil), plus `confidence` (`high`/`medium`/`low`). Nic se needituje na místě — starý fakt se buď zneplatní, nebo nahradí novým, historie zůstává dohledatelná přes `memory_inspect`. Náhrada faktu: `memory_search` → z výsledku se vezme `#<id>` zastaralého faktu → `memory_save` nového faktu s `supersedes_observation_id` nastaveným na toto id; starý fakt dostane `invalidated_at` a `superseded_by` automaticky.

**Nástroje** (přes MCP, discovery přes ToolSearch — nejsou defaultně připojené ke commandům/agentům):

| Nástroj | Účel |
|---|---|
| `memory_save` | Zápis destilovaných faktů (+ volitelně relací); volající model musí destilovat PŘED voláním, žádný raw text. Volitelné `supersedes_observation_id` nahradí starší fakt (ten se automaticky invaliduje a dostane `superseded_by`) |
| `memory_search` | FTS5 BM25 fulltext nad platnými fakty + graph expansion o 1 hop, scope-guarded; každý výsledný řádek začíná `#<id>` pro pozdější použití v `memory_invalidate`/`supersedes_observation_id` |
| `memory_link` | Vytvoří/aktualizuje `subjekt -predikát-> objekt` hranu (idempotentní) |
| `memory_traverse` | Graph walk z entity do hloubky N, scope-guarded |
| `memory_inspect` | Jediný human-readable debug pohled v systému — confidence, valid_from, superseded_by, source |
| `memory_invalidate` | Soft delete (výchozí, nastaví `invalidated_at`) nebo hard delete (`hard: true`) |
| `memory_stats` | Počty nodes/observations/edges per scope, invalidated, velikost DB, staleness (>90 dní) |
| `wisdom_get` / `wisdom_add` | Tenké kompatibilní wrappery nad `memory_search`/`memory_save` pro `/wisdom` a legacy čtenáře; `wisdom_add` bere `{text, category, confidence?, scope?}` se `scope` defaultně `'project'`; `project_id` se u obou normálně nezadává (server je vázaný na vlastní projekt) |

**Setup a migrace:** `/memory-setup` (diagnostika Node/bundle/tools, nabídka migrace, instrukce pro vypnutí built-in auto-memory) a `/memory-migrate` (dry-run inventura → potvrzení → mechanický import wisdom.json + LLM destilace markdown pamětí do grafu) — viz sekce "Graph memory — paměť napříč projekty" výše.

**Fail-open:** chybí-li Node (< 22.5) nebo sestavený bundle, MCP tools i injekční hooky (`scripts/memory-inject.sh`, re-injekce v `scripts/post-compact.sh`) tiše přeskočí — zbytek Orchestra funguje beze změny, přesně jako u chybějícího `jq`.

**Požadavky:** Node.js ≥ 22.5 (kvůli `node:sqlite`); v dev checkoutu build krok `cd mcp-server && npm install && npm run build` (marketplace deploy dodává už sestavený `dist/`).

### Skills (automatická aktivace)

| Skill | Trigger |
|-------|---------|
| **orchestrate** | "orchestruj", "multi-agent", "rozděl práci", 3+ files cross-cutting |
| **deep-plan** | "navrhni", "naplánuj", "design this", "migration strategy" |
| **deep-review** | "review", "zkontroluj", "audit", "security review" |
| **skill-extract** | Post-workflow pattern extraction |

### Framework conventions

Framework pravidla fungují na **dvoustupňovém modelu přednosti:**

1. **User skill (primární):** Pokud existuje `~/.claude/skills/react-conventions/`, agenti načtou jeho `SKILL.md` a `reference/review-checklist.md` — tyto soubory mají přednost před plugin digestem.
2. **Plugin digest (offline fallback):** `conventions/react.md` a `conventions/react-review-checklist.md` jsou tenké ukazatele (~20 řádků) obsahující pouze P0/CRITICAL anti-pattern digest.

| Convention | Trigger | Primární zdroj | Fallback |
|------------|---------|----------------|---------|
| **React 19+ / Next.js 15+ / TypeScript** | `.tsx`, `.jsx`, hooks, App Router | `~/.claude/skills/react-conventions/SKILL.md` + `reference/review-checklist.md` | `conventions/react.md` + `conventions/react-review-checklist.md` |

**Chování:**
- **Craftsman** nejprve zkontroluje user skill; pokud neexistuje, načte plugin fallback. Před reportem self-checkne P0 anti-patterns
- **Sentinel** nejprve načte user-skill checklist; fallback = plugin digest. Každé porušení P0 = Critical, mapování P1-P3 dle checklistu
- **Architect** v plánu explicitně rozhodne Server vs Client komponenty, data layer (RSC / TanStack Query / Server Action) a state ownership (URL / server / context / local)

Přidání vlastního frameworku: vytvoř `conventions/<framework>.md` + checklist, zaregistruj trigger v `agents/craftsman.md`, `agents/sentinel.md`, `agents/architect.md`. Viz `AGENTS.md → FRAMEWORK_CONVENTIONS`.

## Struktura pluginu

```
orchestra-plugin/
├── .claude-plugin/
│   └── plugin.json              # Manifest v2.1.0 — 9 hook events
├── .mcp.json                    # Registruje orchestra-memory MCP server
├── mcp-server/                  # Graph memory MCP server (TS → esbuild → dist/server.mjs)
│   ├── src/                     # server.ts, inject.ts, migrate.ts, db/, tools/
│   ├── test/                    # vitest — repository, tools, migrate
│   ├── dist/                    # Build output — server.mjs + schema.sql (NOT gitignored — ships with the plugin)
│   └── README.md                # Build/test/run/scoping/CLI reference pro MCP server
├── agents/
│   ├── conductor.md             # Orchestrátor s intent classification
│   ├── architect.md             # Plánovač s file ownership
│   ├── executor.md              # Koordinátor s file claiming + wisdom
│   ├── craftsman.md             # Worker s OWNS/MUST NOT MODIFY
│   ├── sentinel.md              # Reviewer s confidence filtering (sonnet)
│   ├── scout.md                 # Explorer (read-only)
│   └── scholar.md               # Researcher (read-only, Context7 fallback)
├── commands/
│   ├── orchestrate.md           # /orchestrate — staged pipeline
│   ├── plan.md                  # /plan
│   ├── review.md                # /review
│   ├── parallel.md              # /parallel — scale decision + file ownership
│   ├── ralph.md                 # /ralph — iterativní batch + semantic completion
│   ├── boulder.md               # /boulder — instance field + restore confirmation
│   ├── wisdom.md                # /wisdom — primary MCP path (wisdom_get/wisdom_add) + legacy fallback
│   ├── status.md                # /status
│   ├── memory-setup.md          # /memory-setup — onboarding: diagnostika, migrace, autoMemoryEnabled instrukce
│   └── memory-migrate.md        # /memory-migrate — dry-run → potvrzení → import wisdom.json + markdown pamětí
├── skills/
│   ├── orchestrate/SKILL.md     # Staged pipeline + scale decision
│   ├── deep-plan/SKILL.md       # Planning s file ownership
│   ├── deep-review/SKILL.md     # Review s confidence filtering
│   ├── skill-extract/SKILL.md   # Post-workflow pattern extraction
│   └── memory-discipline/SKILL.md # Write-discipline pro orchestra-memory (WHEN/HOW/SCOPE/anti-spam)
├── conventions/                 # Framework-specific rules — tenké ukazatele
│   ├── react.md                 # P0 digest; ukazatel na ~/.claude/skills/react-conventions/
│   └── react-review-checklist.md # P0/CRITICAL digest; ukazatel na user skill
├── scripts/
│   ├── session-start.sh         # SessionStart — boulder (instance-scoped) + wisdom load + graph memory injekce
│   ├── memory-inject.sh         # Graph memory injekce (9500 B budget), fail-open bez Node/bundle
│   ├── pretooluse-guard.sh      # PreToolUse — file ownership guard
│   ├── track-progress.sh        # PostToolUse — progress tracking
│   ├── post-compact.sh          # PostCompact — context re-injection (wisdom + graph memory, 4000 B budget)
│   ├── validate-completion.sh   # Stop — completion validation
│   ├── notify.sh                # Notification handler
│   ├── subagent-log.sh          # SubagentStart/Stop → .claude/orchestra-log.jsonl
│   └── taskcompleted-gate.sh    # TaskCompleted → opt-in sentinel gate
├── .claude/
│   ├── orchestra-log.jsonl      # Audit trail (SubagentStart/Stop záznamy)
│   └── workflows/               # Uložené Workflow skripty pro repeatable batches
├── AGENTS.md                    # Agent reference (STYLE, GOTCHAS, ARCH_DECISIONS)
└── README.md
```

## Inspirace a zdroje

Přejímá klíčové koncepty z:
- [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) — 3-vrstvá architektura, wisdom accumulation, boulder systém
- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) — nativní multi-agent koordinace
- [Specification-Driven Development](https://github.blog/ai-and-ml/generative-ai/multi-agent-workflows-often-fail-heres-how-to-engineer-ones-that-dont/) — prevence 41.8% selhání z vágních specs
- [Agent Farm](https://github.com/Dicklesworthstone/claude_code_agent_farm) — file-system koordinace
- [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) — staged pipeline pattern

---

## 2026-07-04 upgrade — v2.2.0

Hardening batch nad graph memory hooky z v2.1.0, žádné nové nástroje/agenty:

- **jq-first ordering ve 7 hookách:** `command -v jq` check teď proběhne dřív než jakákoli extrakce dat přes jq — dřív mohl skript pod `set -euo pipefail` spadnout na neošetřeném `jq` volání ještě před tím, než stihl vypsat srozumitelné varování. Vedlejší efekt: `pretooluse-guard.sh` bez jq teď varování vypíše při **každém** PreToolUse eventu (dřív, díky pádu před warningem, prakticky nikdy) — akceptovaný trade-off, viz `AGENTS.md` GOTCHAS.
- **Bezpečná JSON emise:** hooky skládající JSON s uživatelským/souborovým obsahem (system messages, cesty) teď používají `jq -n --arg ... '{...}'` místo ruční interpolace do heredocu — eliminuje riziko poškozeného/injektovaného JSON výstupu.
- **`stat` portabilita:** `pretooluse-guard.sh` detekuje BSD (macOS) vs GNU (Linux) `stat` flagy před čtením mtime zámku místo předpokladu jedné platformy.
- **Oprava driftu wisdom v `/orchestrate` a `/boulder`:** popisovaly jen legacy `.claude/orchestra-wisdom.json` cestu — doplněna primární cesta přes orchestra-memory MCP tools (`wisdom_get`/`wisdom_add`) s legacy fallbackem, stejně jako ve zbytku pluginu.
- **`/status` memory health:** `/status` teď zobrazuje i stav graph memory (dostupnost MCP nástrojů, `memory_stats` souhrn), ne jen boulder/wisdom.
- **Conductor smí Edit/Write:** conductor agent dostal přístup k `Edit`/`Write` pro drobné přímé zásahy bez nutnosti delegovat na craftsmana.
- **Denní záloha `graph.db`:** nový `scripts/memory-backup.sh` + `--backup` CLI mód na MCP serveru, zapojený do `session-start.sh` (viz sekce "Graph memory — paměť napříč projekty" výše a `mcp-server/README.md`).

## 2026-07-04 upgrade — Graph memory (v2.1.0)

Plugin poprvé získává Node.js závislost: `mcp-server/` je nový bundlovaný MCP server `orchestra-memory` nad SQLite (`node:sqlite`, vyžaduje Node ≥ 22.5), doplňující dosavadní per-projektovou wisdom o cross-project graf s temporální validitou a scopingem `global/project/private`. Devět nástrojů (`memory_save`, `memory_search`, `memory_link`, `memory_traverse`, `memory_inspect`, `memory_invalidate`, `memory_stats`, `wisdom_get`, `wisdom_add`) je registrováno přes `.mcp.json` a discoverovatelných přes ToolSearch. `scripts/memory-inject.sh` injektuje relevantní fakta při `SessionStart` (rozpočet 9500 B), `scripts/post-compact.sh` re-injektuje po kompakci (4000 B), obojí fail-open bez Node/bundle. `skills/memory-discipline/SKILL.md` definuje write-discipline (WHEN/HOW/SCOPE/anti-spam). Agenti executor/conductor/wisdom.md nyní volají primárně MCP nástroje s legacy `.claude/orchestra-wisdom.json` fallbackem; scout/craftsman/scholar/sentinel/architect mají sekci "Memory access" pro read přístup. Nové příkazy `/memory-setup` (onboarding, diagnostika, instrukce pro vypnutí built-in auto-memory) a `/memory-migrate` (dry-run → potvrzení → import) uzavírají migrační cestu ze dvou starých systémů (wisdom JSON + markdown auto-memory). Vestavěná auto-memory Claude Code (`autoMemoryEnabled`) se **nevypíná automaticky** — je to vždy explicitní krok uživatele, viz `/memory-setup`.

## 2026-06-12 upgrade

Přehled všech změn z upgrade batche R1–R10.

**R1 — Workflow hybrid (`/parallel`, `/ralph`, orchestrate skill):** Přibyla sekce "Scale decision" — ≤8 independentních tasků = prompt-driven craftsman dispatch; >8 tasků nebo opakovaný batch (audit, migrace, codemod) = generuje se Workflow script (`pipeline()`, schema-validated výstupy, uložen do `.claude/workflows/`). Žádné tiché vynechání — co se nestihne, reportuje se. Ralph dostává semantic completion: cyklus skončí dříve pokud verify vrátí `<promise>DONE</promise>` A testy projdou; MAX_ITERATIONS=8 zůstává pojistkou.

**R2 — Worktree isolation:** Executor a `/parallel` předávají `isolation: "worktree"` craftsman agentům v git repozitářích — každý pracuje v izolovaném worktree. Merging po dokončení zajišťuje executor (reportuje konflikty, nikdy nevynucuje merge). File-lock protokol je fallback pouze pro non-git adresáře. jq-missing = viditelné varování, nikdy tichý no-op.

**R3 — Audit trail + quality-gate hooky:** Plugin má nově 9 hook eventů (dříve 6). `SubagentStart`/`SubagentStop` → `scripts/subagent-log.sh` zapíše JSONL záznam do `.claude/orchestra-log.jsonl`. `TaskCompleted` → `scripts/taskcompleted-gate.sh` blokuje dokončení (exit 2) jen když boulder má `"gate": "sentinel"` — jinak exit 0 (fail-open).

**R4 — SendMessage retry:** První retry = SendMessage stejnému craftsman agentId s detaily selhání. Nový spawn až při druhém selhání s kumulovaným kontextem. Celkový limit 2 retry nezměněn.

**R5 — Model tiering:** Sentinel přechází z opus na sonnet — strukturovaný checklist review nevyžaduje plný reasoning. Conductor může běžet jako `inherit`. Všechny spawn instrukce vyžadují explicitní předání `model` v Agent tool callu (frontmatter může být ignorován).

**R6 — Background recon:** Scout + scholar průzkum může být spuštěn s `run_in_background: true` zatímco conductor klasifikuje intent; výsledky se sbírají po notifikaci.

**R7 — Wisdom schema v2:** Položky jsou objekty `{text, ts, confidence, source}`. Čtenáři tolerují legacy plain strings. `/wisdom show` seskupuje podle confidence a označuje záznamy starší 90 dní. Boulder save obsahuje pole `instance` (odvozeno z cwd); session-start oznamuje pouze boulders odpovídající aktuální instanci.

**R8 — Ralph semantic completion:** Viz R1.

**R9 — Fragility fixes:** jq-missing = viditelné varování ve všech scriptech. Boulder restore při neshodě hashů vyžaduje explicitní potvrzení uživatele před recreate tasků. `deep-plan` skill odkazuje na architect template místo duplikace.

**R10 — Conventions sync:** `conventions/react.md` a `conventions/react-review-checklist.md` jsou tenké ukazatele (~20 řádků) s P0 digestem. User-level skill `~/.claude/skills/react-conventions/` má přednost; plugin soubory jsou offline fallback. Craftsman, sentinel i architect aktualizovány pro dvoustupňovou přednost.
