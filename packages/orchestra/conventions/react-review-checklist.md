# React Review Checklist — thin pointer

If `~/.claude/skills/react-conventions/reference/review-checklist.md` exists, load it — it takes precedence over this file. This digest is the offline fallback for sentinel.

---

## Anti-patterns — severity mapping (offline fallback)

`[CRITICAL]` = **P0**. Unmarked = **P1**.

### Hooks & State
- `useEffect` on derived state → **[CRITICAL] P0**
- Missing / incomplete deps in `useEffect` → **[CRITICAL] P0**
- Async operations in `useEffect` without cleanup (AbortController) → **[CRITICAL] P0**
- Mutating state objects/arrays before `setState` → **[CRITICAL] P0**

### Performance
- `index` as `key` in dynamic lists (adding / removing / reordering) → **[CRITICAL] P0**
- `Math.random()` as `key` → **[CRITICAL] P0**

### Security
- API keys / secrets in Client Components (`'use client'` / `NEXT_PUBLIC_*`) → **[CRITICAL] P0**
- `dangerouslySetInnerHTML` without sanitization → **[CRITICAL] P0**
- Server Actions without auth/authz check → **[CRITICAL] P0**

### TypeScript / Components
- `React.FC` / `React.FunctionComponent` → P1
- Controlled + uncontrolled input mix (`defaultValue` + `value`) → P1
- Prop drilling through 3+ levels without Context / composition → P1
