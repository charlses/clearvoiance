# @clearvoiance/site

Marketing + docs site for clearvoiance.io. Next.js 16 (App Router, Turbopack)
+ React 19 + Tailwind 4 + MDX.

## Local dev

From the repo root:

```bash
pnpm install
pnpm --filter @clearvoiance/site dev    # http://localhost:3200
```

Or from inside `site/`:

```bash
pnpm dev
pnpm build
pnpm typecheck
pnpm lint
```

## Content

- **Landing** — `app/page.tsx` (hero, feature grid, quickstart, replay, adapters, CTA).
- **Docs** — `app/docs/**/page.mdx`. Each page is plain MDX; `mdx-components.tsx`
  provides the typography overrides and shiki-powered syntax highlighting
  (server-rendered, zero client JS).
- **Shared chrome** — `components/site-header.tsx`, `site-footer.tsx`,
  `theme-toggle.tsx`, shadcn-style primitives in `components/ui/`.

Theme tokens live in `app/globals.css` (Tailwind 4 `@theme inline` + a
`.dark` class variant driven by `next-themes`).

## Deploying to Vercel

1. In the Vercel dashboard, **Root Directory** → `site`.
2. Framework preset: **Next.js** (auto-detected).
3. Install command: leave as default — Vercel walks up to find
   `pnpm-workspace.yaml` and installs the whole workspace.
4. Build command: `pnpm build` (default).
5. Output directory: `.next` (default).

`vercel.json` keeps the deploy config reproducible and silences the bot's
PR comments. When Root Directory is set, Vercel only rebuilds on pushes
that touch `site/**`.
