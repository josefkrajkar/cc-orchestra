# React Review Checklist — tenký ukazatel

Pokud existuje `~/.claude/skills/react-conventions/reference/review-checklist.md`, načti jej — má přednost před tímto souborem. Tento digest je offline fallback pro sentinela.

---

## Anti-patterns — mapování severity (offline fallback)

`[CRITICAL]` = **P0**. Neoznačené = **P1**.

### Hooks & State
- `useEffect` na derived state → **[CRITICAL] P0**
- Chybějící / nekompletní deps v `useEffect` → **[CRITICAL] P0**
- Async operace v `useEffect` bez cleanup (AbortController) → **[CRITICAL] P0**
- Mutace state objektů / polí před `setState` → **[CRITICAL] P0**

### Performance
- `index` jako `key` u dynamických listů (přidávání / mazání / řazení) → **[CRITICAL] P0**
- `Math.random()` jako `key` → **[CRITICAL] P0**

### Security
- API klíče / secrets v Client Components (`'use client'` / `NEXT_PUBLIC_*`) → **[CRITICAL] P0**
- `dangerouslySetInnerHTML` bez sanitizace → **[CRITICAL] P0**
- Server Actions bez auth/authz checku → **[CRITICAL] P0**

### TypeScript / Komponenty
- `React.FC` / `React.FunctionComponent` → P1
- Controlled + uncontrolled input mix (`defaultValue` + `value`) → P1
- Prop drilling přes 3+ úrovně bez Context / composition → P1
