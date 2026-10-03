import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/webhooks.ts',
    'src/testing.ts',
    'src/ui.tsx',
    'src/billing/index.ts',
    'src/billing/schema.ts',
    'src/ec/index.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  treeshake: true,
  sourcemap: true,
  // stripe / hono are peer dependencies — never bundle them or their subpaths.
  // stripe-decline-codes is a real dependency but ships its own build; keep it
  // external so its data tables don't inflate this bundle.
  external: ['stripe', 'hono', 'hono/*', 'stripe-decline-codes'],
})
