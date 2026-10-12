# hono-stripe docs

Documentation site for `hono-stripe` — [Starlight](https://starlight.astro.build)
(Astro) with the API reference auto-generated from `../src` JSDoc via TypeDoc.

Deployed as a **Cloudflare Workers Static Assets** site (`hono-stripe-docs`).

## Commands

Run from the repo root with `pnpm -C docs <script>` (or `--filter hono-stripe-docs`):

| Command | What it does |
| -- | -- |
| `dev` | `astro dev` — local dev server with TypeDoc regeneration |
| `build` | `astro build` → `dist/` (typedoc API pages are generated here) |
| `preview` | `wrangler dev` — serve the built `dist/` through the Worker runtime |
| `deploy` | `astro build && wrangler deploy` — publish to Workers Static Assets |

## Structure

- `src/content/docs/` — guides (`getting-started`, `guides/*`, `api.md`)
- `src/content/docs/api/` — **generated** by TypeDoc at build time (gitignored)
- `astro.config.mjs` — sidebar + `starlight-typedoc` entry points
- `wrangler.jsonc` — static-assets-only Worker config

## CI

`.github/workflows/docs.yml` builds on PRs touching `docs/`/`src/` and deploys
on `main`. Requires repo secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`.

After the first deploy, set `site` in `astro.config.mjs` to the workers.dev URL
so the sitemap is emitted.
