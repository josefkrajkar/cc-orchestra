# React Conventions — thin pointer

If `~/.claude/skills/react-conventions/` exists, load its `SKILL.md` and `reference/review-checklist.md` — they take precedence over this file. This digest is the offline fallback.

---

## P0 anti-patterns (always report / reject)

| # | Anti-pattern | Reason |
|---|---|---|
| 1 | `useEffect` on derived state | Unnecessary re-render; compute directly in the render phase |
| 2 | `index` as `key` in dynamic lists | Breaks reconciliation on add / remove / reorder |
| 3 | `React.FC` / `React.FunctionComponent` | Unnecessary type wrapper; write a plain function + inline type |
| 4 | Missing / incomplete deps in `useEffect` | Stale closure, hard-to-debug bugs |
| 5 | API keys / secrets in Client Components | `'use client'` code is visible in the browser |
| 6 | `Math.random()` as `key` | New key on every render = remount on every render |
| 7 | Mutating state objects/arrays before `setState` | React doesn't detect the change; stale UI |
| 8 | Async `useEffect` without cleanup | Memory leak, race condition |
| 9 | `dangerouslySetInnerHTML` without sanitization | XSS |
| 10 | Server Actions without auth/authz check | Unprotected data mutation |
| 11 | Combining controlled + uncontrolled input | React warning, unpredictable state |
| 12 | Class components (except error boundaries) | Legacy pattern; always use function components |
