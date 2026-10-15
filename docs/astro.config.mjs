import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc'

export default defineConfig({
  integrations: [
    starlight({
      title: 'hono-stripe',
      description:
        'All-in-one Stripe toolkit for Hono and HonoX — client middleware, typed webhook routing, testing fixtures, and JSX payment UI.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/hideokamoto/hono-stripe',
        },
      ],
      plugins: [
        starlightTypeDoc({
          entryPoints: [
            '../src/index.ts',
            '../src/webhooks.ts',
            '../src/testing.ts',
            '../src/ui.tsx',
          ],
          tsconfig: '../tsconfig.json',
          output: 'api',
          sidebar: { label: 'Modules' },
          typeDoc: {
            // No module-level readmes are generated, so the project readme
            // page would only contain dead links — the static api.md page in
            // docs/ is the landing instead.
            readme: 'none',
          },
        }),
      ],
      sidebar: [
        { label: 'Getting Started', slug: 'getting-started' },
        {
          label: 'Guides',
          items: [
            { label: 'Webhooks', slug: 'guides/webhooks' },
            { label: 'Billing', slug: 'guides/billing' },
            { label: 'Testing', slug: 'guides/testing' },
            { label: 'Payment UI', slug: 'guides/ui' },
            { label: 'Deployment', slug: 'guides/deployment' },
          ],
        },
        {
          label: 'API Reference',
          items: [{ label: 'Overview', slug: 'api' }, typeDocSidebarGroup],
        },
      ],
    }),
  ],
})
