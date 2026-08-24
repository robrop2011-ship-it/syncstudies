# ADR 0002 — Relative imports inside workspace packages are extensionless

- **Status:** Accepted
- **Date:** 2026-08-24
- **Applies to:** `packages/shared`, `packages/auth`, `packages/db`

## Context

Node's ESM resolver requires a file extension on relative imports, and TypeScript's own
documentation tells you to write `./video.js` even though the file on disk is
`./video.ts`. That is correct advice for a package that is compiled and then run by Node.

Our workspace packages are not that. Their `main` points at `src/index.ts` and they are
consumed as **TypeScript source** by whatever bundler is compiling the app that imports
them. Four toolchains touch them, and they do not agree:

| Toolchain | Resolves `./video.js` → `video.ts`? |
|---|---|
| `tsc` (moduleResolution: Bundler) | yes |
| `tsx` (the realtime service) | yes |
| webpack (`next build`) | only with `resolve.extensionAlias` |
| **Turbopack (`next dev`)** | **no, and it has no escape hatch** |

The failure mode is nasty. `pnpm typecheck` passes, because `tsc` maps the extension
happily. `next build` can be made to pass with a `webpack.extensionAlias` config. Then
`next dev --turbopack` dies with `Module not found: Can't resolve './video.js'` — so the
break appears only at development time, in the one command nobody runs in CI.

## Decision

Relative imports inside `packages/**` carry **no extension**: `import { positionAt } from
'./video'`.

`moduleResolution: "Bundler"` in `packages/config/tsconfig.base.json` explicitly supports
this, and it is the only form all four toolchains resolve identically. Both
`packages/shared/src/index.ts` and `packages/auth/src/index.ts` carry a header comment
stating the rule, because the "fix" someone will reach for is to add `.js` back.

`apps/web` uses the `@/` path alias, and `apps/realtime` keeps `.js` extensions — it runs
under `tsx`/Node and is never bundled, so the Node-ESM convention is correct there.

## Consequences

- No bundler-specific resolution config. The `webpack.extensionAlias` and
  `turbopack.resolveExtensions` workarounds were both removed once this landed.
- These packages cannot be compiled to plain ESM JavaScript and run directly by Node
  without a resolver. That is already true — they ship as source by design — but if a
  package ever needs a real build step, that build must add extensions on the way out.
- **Run `pnpm build` in CI, not just `pnpm typecheck`.** A typecheck cannot see this
  class of error at all. CI does this today (`.github/workflows/ci.yml`).
