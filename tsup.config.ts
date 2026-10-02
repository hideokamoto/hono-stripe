import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/webhooks.ts', 'src/testing.ts', 'src/ui.tsx'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  treeshake: true,
  sourcemap: true,
  // stripe / hono are peer dependencies — never bundle them or their subpaths.
  external: ['stripe', 'hono', 'hono/*'],
})
