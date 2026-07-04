# React Conventions — tenký ukazatel

Pokud existuje `~/.claude/skills/react-conventions/`, načti jeho `SKILL.md` a `reference/review-checklist.md` — mají přednost před tímto souborem. Tento digest je offline fallback.

---

## P0 anti-patterns (vždy reportovat / odmítnout)

| # | Anti-pattern | Důvod |
|---|---|---|
| 1 | `useEffect` na derived state | Zbytečný re-render; počítej přímo v render fázi |
| 2 | `index` jako `key` u dynamických listů | Rozbíjí reconciliation při přidání / mazání / řazení |
| 3 | `React.FC` / `React.FunctionComponent` | Zbytečný wrapper typu; piš plain function + inline typ |
| 4 | Chybějící / nekompletní deps v `useEffect` | Stale closure, těžko debugovatelné bugy |
| 5 | API klíče / secrets v Client Components | `'use client'` kód je viditelný v browseru |
| 6 | `Math.random()` jako `key` | Nový klíč každý render = remount každý render |
| 7 | Mutace state objektů / polí před `setState` | React nedetekuje změnu; stale UI |
| 8 | Async `useEffect` bez cleanup | Memory leak, race condition |
| 9 | `dangerouslySetInnerHTML` bez sanitizace | XSS |
| 10 | Server Actions bez auth/authz checku | Nechráněná mutace dat |
| 11 | Kombinace controlled + uncontrolled inputu | React varování, nepředvídatelný stav |
| 12 | Class components (mimo error boundaries) | Legacy pattern; function components vždy |
